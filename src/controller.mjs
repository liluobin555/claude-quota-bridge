import {initialState, step, DEFAULTS} from './vendor/quota-guard-core.mjs';
import {inspectSnapshot} from './contract.mjs';

export class Controller {
  constructor({sessionId, saved, config = {}}) {
    this.sessionId = sessionId;
    this.config = {...DEFAULTS, threshold: 85, weeklyThreshold: 90, abortThreshold: 95, compactMinContext: 50, graceSec: 60, afterCompact: 'continue', ...config};
    if (!['continue', 'pause'].includes(this.config.afterCompact)) throw new Error('invalid_after_compact_policy');
    if (!Number.isFinite(this.config.compactMinContext) || this.config.compactMinContext < 0 || this.config.compactMinContext > 100) throw new Error('invalid_context_threshold');
    this.state = saved?.state ?? initialState();
    this.accountRef = saved?.accountRef;
    this.bindingVersion = saved?.bindingVersion;
    this.compaction = saved?.compaction;
    this.hold = saved?.hold;
    this.children = new Set(saved?.children ?? []);
    this.snapshot = undefined;
    this.context = undefined;
    this.autoResume = config.autoResume === true;
    this.attemptedWindows = saved?.attemptedWindows ?? [];
    this.pendingWindows = saved?.pendingWindows ?? [];
    // A verified pause from the old policy can be released without submitting a
    // continuation. Remember its windows so the upgrade cannot compact it again.
    if (this.config.afterCompact === 'continue' && this.state.rec.phase === 'paused' &&
        (this.compaction?.ok || this.compaction?.smallContext) && !this.hold) {
      if (this.compaction?.ok) this.rememberWindows(this.state.rec.usage ?? []);
      this.state.rec.phase = 'idle';
    }
  }
  dump() { return {state: this.state, accountRef: this.accountRef, bindingVersion: this.bindingVersion, compaction: this.compaction, hold: this.hold, children: [...this.children], attemptedWindows: this.attemptedWindows, pendingWindows: this.pendingWindows}; }
  view() { return {sessionId: this.sessionId, phase: this.state.rec.phase, hold: this.hold, accountRef: this.accountRef, compaction: this.compaction, context: this.context, afterCompact: this.config.afterCompact, compactMinContext: this.config.compactMinContext, attemptedWindows: this.attemptedWindows, children: this.children.size, heldNotifications: this.state.rec.held?.length ?? 0,
    quota: this.snapshot ? {sampledAt: this.snapshot.sampledAt, windows: this.snapshot.windows, vmId: this.snapshot.vmId, routeSafety: this.snapshot.routeSafety, bindingSource: this.snapshot.bindingSource, quotaSource: this.snapshot.quotaSource, fresh: this.snapshot.fresh, autoReady: this.snapshot.autoReady} : undefined}; }
  blocksNewAgents() { return (this.hold !== undefined && this.hold !== 'observe_only') || this.state.rec.phase !== 'idle' || this.config.afterCompact === 'pause' && this.snapshot?.windows?.some(w => w.percent >= (w.kind === 'five_hour' ? this.config.threshold : this.config.weeklyThreshold)); }
  blocksPrompts() {
    // Observation must not prevent the ordinary response that refreshes passive
    // quota headers. It never admits a previously paused automatic continuation.
    if (this.snapshot?.routeSafety === 'observe_only' && this.state.rec.phase === 'idle' &&
      [undefined, 'observe_only', 'quota_stale', 'reset_unverified', 'binding_unknown'].includes(this.hold)) return false;
    return (this.hold !== undefined && this.hold !== 'observe_only') || ['compacting', 'paused', 'resuming', 'stopped'].includes(this.state.rec.phase);
  }
  ingest(snapshot, context, now) {
    this.snapshot = snapshot;
    // Read afresh on every evaluation. Never restore a previous model's window
    // from session storage or infer it from a hard-coded model-name table.
    this.context = context ? {...context} : undefined;
    if (this.bindingVersion && snapshot?.bindingSource === 'live_sticky' && snapshot.bindingVersion !== this.bindingVersion) {this.hold = 'binding_changed'; return [];}
    const checked = inspectSnapshot(snapshot, {sessionId: this.sessionId, now, accountRef: this.accountRef});
    if (!checked.usage) {
      // A brand-new session can discover its route on its first response.
      this.hold = checked.reason === 'unbound' && !this.accountRef ? undefined : checked.reason;
      return [];
    }
    this.accountRef ??= snapshot.accountRef;
    if (snapshot.bindingSource === 'live_sticky') this.bindingVersion ??= snapshot.bindingVersion;
    if (!checked.automation) { this.hold = 'observe_only'; return []; }
    if (['compaction_failed', 'compaction_unsupported', 'resume_failed', 'interrupted', 'lease_lost', 'children_still_running'].includes(this.hold)) return [];
    this.hold = undefined;
    if (this.config.afterCompact === 'continue') return this.ingestContinue(checked.usage, context, now);
    const usage = {...checked.usage, contextPercent: context?.percent};
    if (this.state.rec.phase !== 'paused' && usage.windows.some(w => w.percent >= (w.kind === 'five_hour' ? this.config.threshold : this.config.weeklyThreshold)) && !Number.isFinite(usage.contextPercent)) {
      this.hold = 'unknown_context'; return [];
    }
    if (this.state.rec.phase === 'paused' && (!this.autoResume || !this.compaction?.ok && !this.compaction?.smallContext)) return [];
    if (this.state.rec.phase === 'paused') {
      return [...this.dispatch({type: 'measure', now, usage}), ...this.dispatch({type: 'tick', now, usage})];
    }
    return this.dispatch({type: 'measure', now, usage});
  }
  dispatch(event) {
    if (this.config.afterCompact === 'continue') {
      if (event.type === 'turnStart') { this.state.busy = true; this.state.turnId = event.turnId; }
      if (event.type === 'turnComplete' && (!event.turnId || !this.state.turnId || event.turnId === this.state.turnId)) {
        this.state.busy = false; this.state.turnId = undefined;
        // The hook will read fresh quota/context after releasing the turn frame.
      }
      if (event.type === 'userPrompt' && event.isUser) this.state.rec.task = event.text;
      return [];
    }
    if (this.hold && !['turnStart', 'turnComplete', 'userPrompt', 'compactDone'].includes(event.type)) return [];
    const result = step(this.state, event, this.config);
    this.state = result.state;
    if (this.state.rec.phase === 'paused' && this.compaction === undefined && this.state.ctx !== undefined && this.state.ctx <= this.config.compactMinContext) this.compaction = {smallContext: true};
    return result.fx;
  }
  compactDone({ok, unsupported = false, detail, now, route, evidence, tokensBefore, tokensAfter}) {
    this.compaction = {ok, at: now, detail, route, evidence, tokensBefore, tokensAfter};
    if (this.config.afterCompact === 'continue') {
      this.pendingWindows = [];
      this.state.rec.phase = 'idle';
      if (!ok) this.hold = unsupported ? 'compaction_unsupported' : 'compaction_failed';
      return [];
    }
    const fx = this.dispatch({type: 'compactDone', now, op: this.state.rec.op, ok, detail});
    if (!ok) this.hold = unsupported ? 'compaction_unsupported' : 'compaction_failed';
    return fx;
  }
  child(id, active) { if (active) this.children.add(id); else this.children.delete(id); }
  rememberWindows(windows) {
    for (const w of windows) {
      if (!this.attemptedWindows.some(a => a.kind === w.kind && a.accountRef === this.accountRef && Math.abs(a.resetsAt - w.resetsAt) <= 120000)) {
        this.attemptedWindows.push({kind: w.kind, resetsAt: w.resetsAt, accountRef: this.accountRef});
      }
    }
    this.attemptedWindows = this.attemptedWindows.slice(-32);
  }
  ingestContinue(usage, context, now) {
    if (this.state.rec.phase === 'compacting') return [];
    const hit = usage.windows.filter(w => w.percent >= (w.kind === 'five_hour' ? this.config.threshold : this.config.weeklyThreshold));
    const eligible = hit.filter(w => !this.attemptedWindows.some(a => a.kind === w.kind && a.accountRef === this.accountRef && Math.abs(a.resetsAt - w.resetsAt) <= 120000));
    if (!eligible.length) { this.state.rec.phase = 'idle'; this.pendingWindows = []; return []; }
    if (!Number.isFinite(context?.percent)) { this.hold = 'unknown_context'; return []; }
    this.state.ctx = context.percent;
    // Inclusive threshold. A small session continues and can qualify later when
    // it grows; it is neither paused nor marked as having used its attempt.
    if (context.percent < this.config.compactMinContext) { this.state.rec.phase = 'idle'; this.pendingWindows = []; return []; }
    this.pendingWindows = eligible.map(w => ({...w}));
    this.state.rec.phase = 'armed';
    if (this.state.busy || this.children.size) return [];
    // Persist the attempt before executing it: retries/restarts must not loop.
    this.rememberWindows(hit);
    this.state.rec.phase = 'compacting';
    this.state.rec.op = this.state.opSeq = (this.state.opSeq ?? 0) + 1;
    return [{t: 'compact', op: this.state.rec.op, instructions: 'Compact the current conversation while preserving the task, decisions, completed work, pending work, and background job locations. The user or agent may continue normally afterwards; do not invent or start a continuation.'}];
  }
}

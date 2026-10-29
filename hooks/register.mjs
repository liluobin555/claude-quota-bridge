import {Controller} from '../src/controller.mjs';
import {createClient, isBootstrapBinding} from '../src/contract.mjs';
import {compactVerified} from '../src/compaction.mjs';
import {activation} from '../src/scope.mjs';

const CONTINUE = 'Continue the previous task from the compacted context and saved results. Check existing background jobs before restarting any work.';
let options = {};
let epoch = 0;
let scope = {active: false, reason: 'not_opted_in'};
let mustGuard = false;
  let ctl, call, timer, processing = false, ended = false, runner, lastRefresh = 0, turnId, observedCompact = false, selfCompact = false;
  let pendingPrompt, pendingFx = [], effectsRunning = false;
  async function publish($, extra = {}) {
    if (!ctl) return;
    await $.store.set(`vm2api-quota:${ctl.sessionId}`, ctl.dump());
    const status = {...ctl.view(), ...extra};
    if (runner) {
      const r = await $.http.fetch(runner.url + '/event', {method: 'POST', headers: {authorization: `Bearer ${runner.token}`, 'content-type': 'application/json'}, body: JSON.stringify(status)});
      if (r.status !== 200) throw new Error('runner_unavailable');
    } else {
      const five = status.quota?.windows?.find(w => w.kind === 'five_hour')?.percent;
      await $.ui.status(`quota · ${five === undefined ? '?' : five + '%'} · ${status.phase}${status.hold ? ' · ' + status.hold : ''}`);
    }
  }
  async function ensure($) {
    const enabled = await $.env.get('QUOTA_BRIDGE_ENABLED');
    const supervisor = enabled === '1' ? await $.env.get('QUOTA_RUNNER_URL') : undefined;
    mustGuard = enabled === '1' && /^http:\/\/127\.0\.0\.1:\d+$/.test(supervisor || '');
    scope = activation({enabled,
      expectedGateway: await $.env.get('QUOTA_GATEWAY_BASE_URL'), actualGateway: await $.env.get('ANTHROPIC_BASE_URL')});
    if (!scope.active) {
      if (ctl) { ++epoch; timer?.cancel(); ctl = undefined; call = undefined; runner = undefined; pendingFx = []; }
      if (mustGuard) {
        const id = await $.session.id(), token = await $.env.get('QUOTA_RUNNER_TOKEN');
        await $.http.fetch(supervisor + '/event', {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
          body: JSON.stringify({sessionId: id, ready: true, phase: 'idle', hold: scope.reason})});
      }
      return false;
    }
    const id = await $.session.id();
    if (ctl && ctl.sessionId === id && !ended) return true;
    ++epoch; timer?.cancel(); ctl = undefined; pendingFx = []; ended = false;
    processing = false; effectsRunning = false; selfCompact = false;
    const token = await $.env.get('ANTHROPIC_AUTH_TOKEN') || await $.env.get('ANTHROPIC_API_KEY');
    const baseUrl = await $.env.get('QUOTA_BRIDGE_URL') || options.bridgeUrl || 'http://127.0.0.1:47824';
    call = createClient({baseUrl, token, fetcher: async (url, init) => {
      // Fail closed for automatic actions; bounded requests cannot hold a hook indefinitely.
      const timeout = url.endsWith('/v1/refresh') ? 30000 : 4000;
      return Promise.race([$.http.fetch(url, init), $.clock.sleep(timeout).then(() => { throw new Error('bridge_timeout'); })]);
    }});
    const contextThreshold = await $.env.get('QUOTA_COMPACT_MIN_CONTEXT');
    ctl = new Controller({sessionId: id, saved: await $.store.get(`vm2api-quota:${id}`), config: {...options,
      afterCompact: await $.env.get('QUOTA_AFTER_COMPACT') || options.afterCompact || 'continue',
      ...(contextThreshold === undefined ? {} : {compactMinContext: Number(contextThreshold)}),
      autoResume: options.autoResume === true || await $.env.get('QUOTA_AUTO_RESUME') === '1'}});
    const url = await $.env.get('QUOTA_RUNNER_URL');
    if (url) {
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('runner_must_be_loopback');
      runner = {url, token: await $.env.get('QUOTA_RUNNER_TOKEN')};
    } else if ((await $.session.surfaces()).length === 0) {
      ctl.hold = 'headless_runner_required';
    }
    await publish($, {ready: true});
    const generation = epoch;
    timer = $.clock.every(Math.max(10000, (options.pollSeconds ?? 30) * 1000), () => { if (generation === epoch) void evaluate($).catch(() => {}); });
    return true;
  }
  async function lease($, kind, action) {
    const generation = epoch, current = ctl, request = call;
    const sessionPath = '/v1/session?sessionId=' + encodeURIComponent(current.sessionId);
    const snapshot = await request(sessionPath);
    const now = await $.clock.now();
    // Re-read immediately before the action, preserving paused state and operation identity.
    if (generation !== epoch || ended || !snapshot.autoReady || snapshot.accountRef !== current.accountRef ||
      snapshot.bindingVersion !== current.snapshot?.bindingVersion && !isBootstrapBinding(current.snapshot, snapshot) || now - snapshot.sampledAt > 120000) throw new Error('binding_or_quota_changed');
    const body = {sessionId: current.sessionId, accountRef: snapshot.accountRef, bindingVersion: snapshot.bindingVersion, kind};
    const grant = await request('/v1/lease', body);
    if (generation !== epoch || ended) { await request('/v1/release', {sessionId: current.sessionId, leaseId: grant.leaseId}); throw new Error('stale_operation'); }
    let lost = false;
    let tracked = snapshot, renewing = false, renewalInFlight = Promise.resolve();
    const renewal = $.clock.every(15000, () => {
      if (renewing) return;
      renewing = true;
      renewalInFlight = (async () => {
        const next = await request(sessionPath), at = await $.clock.now();
        if (generation !== epoch || ended || !next.autoReady || next.accountRef !== tracked.accountRef || next.vmId !== tracked.vmId || at-next.sampledAt > 120000) throw new Error('binding_or_quota_changed');
        if (next.bindingVersion !== body.bindingVersion) {
          if (!isBootstrapBinding(tracked, next)) throw new Error('binding_changed');
          body.bindingVersion = next.bindingVersion;
          current.bindingVersion = next.bindingVersion;
          current.snapshot = next;
        }
        tracked = next;
        await request('/v1/lease', {...body, leaseId: grant.leaseId});
        if (generation === epoch) await publish($);
      })().catch(() => { lost = true; }).finally(() => { renewing = false; });
    });
    try {
      const result = await action();
      renewal.cancel();
      await renewalInFlight;
      if (lost || generation !== epoch || ended) throw new Error('lease_lost');
      return result;
    } finally {
      renewal.cancel();
      await renewalInFlight;
      await request('/v1/release', {sessionId: current.sessionId, leaseId: grant.leaseId}).catch(() => {});
    }
  }
  async function effects($, fx) {
    const generation = epoch;
    for (const effect of fx) {
      if (ended || generation !== epoch) return;
      if (effect.t === 'toast') { if (!runner) await $.ui.toast(effect.text); }
      if (effect.t === 'abort' && turnId) await $.turn.abort({turnId});
      if (effect.t === 'compact') {
        if (ctl.children.size) { ctl.hold = 'children_still_running'; return; }
        let result;
        observedCompact = false;
        try {
          const boundaryBefore = runner ? JSON.parse((await $.http.fetch(runner.url + '/status', {headers: {authorization: `Bearer ${runner.token}`}})).text).compactBoundaries : 0;
          result = await lease($, 'compact', async () => {
            selfCompact = true;
            try {
              return await compactVerified({
                context: async () => (await $.session.usage()).context,
                direct: instructions => $.session.compact({instructions}),
                command: instructions => $.command.run({command: 'compact', args: instructions}),
                observed: async () => {
                  if (observedCompact) return true;
                  if (!runner) return false;
                  const evidence = JSON.parse((await $.http.fetch(runner.url + '/status', {headers: {authorization: `Bearer ${runner.token}`}})).text);
                  return evidence.sessionId === ctl.sessionId && evidence.compactBoundaries > boundaryBefore;
                },
                sleep: ms => $.clock.sleep(ms),
              }, effect.instructions);
            } finally { if (generation === epoch) selfCompact = false; }
          });
        } catch { result = {ok: false, detail: 'lease_or_compaction_failed'}; }
        if (generation !== epoch || ended) return;
        ctl.compactDone({...result, now: await $.clock.now()});
        await publish($);
      }
      if (effect.t === 'submit') {
        try {
          await lease($, 'resume', async () => {
            const result = await $.prompt.submit({text: effect.text || pendingPrompt || CONTINUE});
            if (result?.drop) throw new Error('resume_rejected');
          });
          ctl.dispatch({type: 'resumeDelivered', now: await $.clock.now(), op: effect.op});
          pendingPrompt = undefined;
        } catch { if (generation === epoch) ctl.hold = 'resume_failed'; }
        if (generation !== epoch || ended) return;
        await publish($);
      }
    }
  }
  function enqueue($, fx) {
    const generation = epoch;
    pendingFx.push(...fx);
    if (!pendingFx.length || effectsRunning) return;
    later($, async () => {
      if (effectsRunning || ended || generation !== epoch) return;
      effectsRunning = true;
      try { while (pendingFx.length && !ended) await effects($, pendingFx.splice(0)); }
      finally { if (generation === epoch) effectsRunning = false; }
    });
  }
  async function evaluate($) {
    if (processing || effectsRunning || ended || !ctl) return;
    if (!(await ensure($))) return;
    if (ctl.hold === 'headless_runner_required') {
      if ((await $.session.surfaces()).length === 0) return;
      ctl.hold = undefined;
    }
    processing = true;
    const generation = epoch;
    try {
      let s = await call('/v1/session?sessionId=' + encodeURIComponent(ctl.sessionId));
      const now = await $.clock.now();
      if (generation !== epoch || ended) return;
      // Refresh reads quota only; it does not submit a model request.
      // Busy/restored turns must not prevent stale quota from recovering.
      // Compaction still waits for the root turn and tracked children to finish.
      if (!s.fresh && s.capabilities?.refresh && now - lastRefresh > 60000) {
        lastRefresh = now;
        s = await call('/v1/refresh', {sessionId: ctl.sessionId});
        if (generation !== epoch || ended) return;
      }
      if (ctl.hold === 'children_still_running' && ctl.children.size === 0) {
        // Keep quota operation armed until the final child completes.
        ctl.hold = undefined;
        ctl.state.rec.phase = 'armed';
        enqueue($, ctl.dispatch({type: 'turnComplete', now, reason: 'answer'}));
      }
      const context = (await $.session.usage()).context;
      if (generation !== epoch || ended) return;
      const fx = ctl.ingest(s, context, await $.clock.now());
      enqueue($, fx);
      await publish($, {evaluating: false});
    } catch { if (generation === epoch) { ctl.hold = 'bridge_unavailable'; await publish($).catch(() => {}); } }
    finally { if (generation === epoch) processing = false; }
  }
  function later($, task) { $.clock.after(1, () => { void task().catch(() => {}); }); }
export function register(on, config = {}) {
  options = config;
  on('session.start', async ($, e, next) => {
    await $.command.register({name: 'quota-bridge', description: 'Show quota bridge status; use quota-bridge status.'});
    if (!(await ensure($))) return next(e);
    await evaluate($);
    return next(e);
  });
  on('command.run', {command: 'quota-bridge'}, async ($, e) => {
    if (!(await ensure($))) return {text: JSON.stringify({enabled: false, reason: scope.reason})};
    if (e.args?.trim() === 'resume') {
      if (ctl.hold || !ctl.compaction?.ok && !ctl.compaction?.smallContext) return {text: 'Cannot resume: verify and resolve the recorded hold first.'};
      later($, async () => {
        const enabled = ctl.autoResume;
        ctl.autoResume = true;
        try { await evaluate($); } finally { ctl.autoResume = enabled; }
      });
      return {text: 'Fresh quota verification scheduled. No bypass of account or compaction checks.'};
    }
    return {text: JSON.stringify(ctl.view(), null, 2)};
  });
  on('prompt.submit', async ($, e, next) => {
    if (!(await ensure($))) return mustGuard ? {drop: 'quota runner gateway configuration mismatch; prompt not submitted'} : next(e);
    if (selfCompact) return next(e);
    await evaluate($);
    const background = ['task-notification', 'peer', 'peer-send-message', 'scheduled-trigger'].includes(e.origin?.kind);
    const ownResume = e.origin?.kind === 'plugin' && e.origin.name === 'vm2api-quota-guard';
    if (ctl.state.rec.phase === 'resuming' && !ownResume) {
      if (background) {ctl.dispatch({type: 'held', text: e.text}); await publish($);}
      return {drop: 'quota bridge: continuation in flight; prompt not submitted'};
    }
    if (ctl.blocksPrompts() && ctl.state.rec.phase !== 'resuming') {
      if (background) {ctl.dispatch({type: 'held', text: e.text}); await publish($);}
      // Do not silently drop a human prompt or replay it later. Explicit retry after reset.
      return {drop: `quota bridge: ${ctl.hold || ctl.state.rec.phase}. Prompt not submitted; retry after verification.`};
    }
    if (ctl.state.rec.phase !== 'resuming') {
      ctl.dispatch({type: 'userPrompt', now: await $.clock.now(), text: e.text, isUser: !background});
      pendingPrompt = undefined;
    }
    return next(e);
  }).catch(($, e, next) => scope.active || mustGuard ? {drop: 'quota bridge unavailable; prompt not submitted'} : next(e));
  on('turn.start', async ($, e, next) => {
    if (!(await ensure($))) return next(e);
    if (!e.agentId && !selfCompact) {
      turnId = e.turnId;
      ctl.dispatch({type: 'turnStart', turnId, owns: ctl.state.rec.phase === 'resuming'});
      await publish($, {busy: true});
    }
    return next(e);
  });
  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (!(await ensure($)) || !ctl || selfCompact) return result;
    if (e.agentId) {
      ctl.child(e.agentId, false);
      await call('/v1/agent-event', {sessionId: ctl.sessionId, agentId: e.agentId, event: 'stop'}).catch(() => {});
    } else {
      enqueue($, ctl.dispatch({type: 'turnComplete', now: await $.clock.now(), reason: e.reason, turnId: e.turnId}));
      turnId = undefined;
      // Compaction must run after this hook frame releases the completed turn.
      await publish($, {busy: false, evaluating: true});
    }
    later($, () => evaluate($));
    return result;
  });
  on('session.measure', async ($, e, next) => {
    const result = await next(e);
    if (await ensure($) && !selfCompact) later($, () => evaluate($));
    return result;
  });
  on('session.compact', async ($, e, next) => {
    const result = await next(e);
    if (ctl && scope.active && !e.agentId && e.trigger !== 'precompute' && !result?.skip && !result?.deny) observedCompact = true;
    return result;
  });
  on('session.append', async ($, e, next) => {
    const result = await next(e);
    if (ctl && scope.active && !e.agentId && e.message?.type === 'system' && e.message.name === 'compact_boundary') observedCompact = true;
    return result;
  });
  on('agent.spawn', async ($, e, next) => {
    if (!(await ensure($))) return mustGuard ? {deny: 'quota runner gateway configuration mismatch'} : next(e);
    await evaluate($);
    if (ctl.blocksNewAgents()) return {deny: `quota bridge: no new agent (${ctl.hold || ctl.state.rec.phase})`};
    const result = await next(e);
    if (result?.agentId) {
      ctl.child(result.agentId, true);
      await call('/v1/agent-event', {sessionId: ctl.sessionId, agentId: result.agentId, event: 'start'}).catch(() => {});
      await publish($);
    }
    return result;
  }).catch(($, e, next) => scope.active || mustGuard ? {deny: 'quota bridge unavailable; agent not created'} : next(e));
  on('session.end', async ($, e, next) => {
    ended = true; ++epoch; timer?.cancel();
    if (ctl) await publish($, {ended: true}).catch(() => {});
    return next(e);
  });
}

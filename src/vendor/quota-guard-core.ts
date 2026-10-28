// Pure quota state machine. No engine imports: the adapter (register.ts) feeds
// it events and executes the effects it returns, so everything here is
// unit-testable with plain values.

export type Phase = 'idle' | 'armed' | 'compacting' | 'paused' | 'resuming' | 'stopped'

export const FIVE = 'five_hour'
export const WEEK = 'seven_day'

export type Win = { kind: string; percent: number; resetsAt?: number }
export type Usage = { windows: Win[]; contextPercent?: number }

export type Config = {
  enabled: boolean
  threshold: number // 5-hour compaction/pause threshold, %
  weeklyThreshold: number // weekly threshold, %
  abortThreshold: number // abort the running turn at/above this, %
  ceiling: number // burn-rate ceiling: pause if pct + predicted next jump >= this
  burnMultiplier: number
  graceSec: number // wait this long after the reported reset before re-checking
  maxResumeAttempts: number
  weeklyPolicy: 'pause' | 'notify'
  notifyAt: number // one-off heads-up toast at this %, 0 = off
  compactMinContext: number // compact before pausing only if context is above this %
}

export const DEFAULTS: Config = {
  enabled: true,
  threshold: 98, // compaction itself costs about one point, so this still leaves room for it
  weeklyThreshold: 97,
  abortThreshold: 99,
  ceiling: 99,
  burnMultiplier: 1.5,
  graceSec: 30,
  maxResumeAttempts: 5,
  weeklyPolicy: 'pause',
  notifyAt: 80,
  compactMinContext: 30,
}

export type Rec = {
  phase: Phase
  reason?: string
  kinds: string[]
  expectedReset?: number
  wakeAt?: number
  task: string
  pausedAt?: number
  compactedAt?: number
  compactFailed?: boolean
  compactError?: string // why the quota compaction did not happen: the engine's own words
  usage: Win[]
  resumeAttempts: number
  delayCount: number
  lastResumeAt?: number
  abortRequested?: boolean
  op?: number // identity of the compaction / resume in flight; a completion for any other op is stale
  delivered?: boolean // the session accepted this resume's prompt (accepted is not started)
  deliveredAt?: number
  started?: boolean // the continuation's own turn has started: only now has the task actually resumed
  manual?: boolean // an explicit /quota resume: it does not queue behind account-wide coordination
  verified?: boolean // quota was seen to have reset (it can be seen before the prompt is delivered)
  predictive?: boolean // paused on the burn-rate prediction, not on a static limit
  resets?: Record<string, number> // each window's reset time when the pause began: a reset is THAT window moving on
  verifiedKinds?: string[] // the windows the quota evidence covered when it was taken
  olderTurnRunning?: boolean // a turn was already running when this resume began: its completion is not ours
  olderTurnId?: string // ...and which one
  turnId?: string // the turn that is this resume's continuation, once it has started
  foreignTurns?: string[] // turns that started during this resume and are not its continuation
  causes?: Record<string, 'static' | 'predictive'> // why each window is part of the pause
  // background-task notices that arrived while automatic prompts were held back: delivered with the continuation
  // (or beside the person's own prompt when they take over), never simply lost
  held?: string[]
}

export type State = {
  v: 1
  rec: Rec
  busy: boolean
  deltas: number[] // recent 5-hour jumps per measurement, for burn-rate
  last?: { pct: number; resetsAt?: number }
  notified: string[]
  ctx?: number // last known context-window fill, %
  turnId?: string // the main turn that is running
  opSeq: number // source of operation identities
  known: string[] // managed windows ever seen: a resume is only verified if all of them read healthy
  ended?: { op: number; reason: Ended } // how the most recent resume operation ended (evidence, not just lifecycle)
}

// Why a resume operation stopped being in flight. Only 'verified' and 'completed' are evidence that quota is back.
// 'stalled': the prompt was accepted but its turn never started, so nothing was learned about the quota.
export type Ended = 'verified' | 'completed' | 'takeover' | 'interrupted' | 'cancelled' | 'failed' | 'stalled'

export type Ev =
  | { type: 'measure'; now: number; usage: Usage; shared?: boolean } // shared: another session's reading of the account
  | { type: 'turnStart'; turnId?: string; owns?: boolean }
  | { type: 'turnComplete'; now: number; reason: string; turnId?: string }
  | { type: 'userPrompt'; now: number; text: string; isUser: boolean }
  | { type: 'compactDone'; now: number; ok: boolean; op?: number; external?: boolean; detail?: string }
  | { type: 'tick'; now: number; usage: Usage | null }
  | { type: 'boot'; now: number; usage: Usage | null }
  | { type: 'submitFailed'; now: number; text: string; op: number; detail?: string }
  | { type: 'resumeDelivered'; now: number; op: number }
  | { type: 'resumeStarted'; now: number; op: number } // dry run only: stands in for the continuation's turn.start
  | { type: 'held'; text: string } // a background-task notice kept out of the paused session, to deliver later
  | { type: 'resumeHold'; now: number; op: number } // the adapter is deliberately waiting (coordination): not a stalled resume
  | { type: 'resumeBlocked'; now: number; op: number; why: string } // coordination refused the attempt: back off and retry
  | { type: 'forcePause'; now: number; minutes: number }
  | { type: 'cancel'; now: number }
  | { type: 'resume'; now: number }

export type Fx =
  | { t: 'toast'; text: string }
  | { t: 'abort'; op?: number; turnId?: string }
  | { t: 'compact'; instructions: string; op: number }
  | { t: 'submit'; text: string; op: number; manual: boolean }
  | { t: 'fill'; text: string }

export type Result = { state: State; fx: Fx[] }

export const RESUME_PROMPT =
  'Usage window has reset. Continue the previous task from the compacted context and persisted recovery state. Do not restart completed work.'

const BACKOFF_SEC = [60, 120, 300, 600, 900]
const RESUME_WATCHDOG_MS = 180_000
// A reading arrives only with a response. Long after the expected reset (a session reopened hours later: its process
// ended during the pause, as when Claude Desktop relaunches itself), waiting for one is waiting for nothing.
const LONG_PAST_RESET_MS = 10 * 60_000
// An accepted continuation that has not started its turn after this long, with nothing else running, is stalled.
// It is not sent again (a late start would then run the continuation twice); the person is told instead.
export const START_WATCHDOG_MS = 180_000

export function emptyRec(task = ''): Rec {
  return { phase: 'idle', kinds: [], task, usage: [], resumeAttempts: 0, delayCount: 0 }
}

export function initialState(): State {
  return { v: 1, rec: emptyRec(), busy: false, deltas: [], notified: [], opSeq: 0, known: [] }
}

// ---------- formatting ----------

const pad = (n: number) => (n < 10 ? '0' + n : String(n))

export function fmtClock(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fmtDur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000))
  if (m < 1) return '<1m'
  const h = Math.floor(m / 60)
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `${h}h ${pad(m % 60)}m`.replace(/ 0(\d)m/, ' $1m') : `${m}m`
}

const label = (kind: string) => (kind === FIVE ? '5-hour' : kind === WEEK ? 'Weekly' : kind)

export function describeWindow(w: Win, now: number): string {
  const reset = w.resetsAt === undefined ? '' : w.resetsAt <= now ? ', reset time passed' : `, resets in ${fmtDur(w.resetsAt - now)}`
  return `${label(w.kind)} usage: ${Math.round(w.percent)}%${reset}`
}

// ---------- helpers ----------

const clone = (s: State): State => JSON.parse(JSON.stringify(s))

function limitFor(kind: string, cfg: Config): number | undefined {
  if (kind === FIVE) return cfg.threshold
  if (kind === WEEK) return cfg.weeklyPolicy === 'pause' ? cfg.weeklyThreshold : undefined
  return undefined
}

export function predictedJump(s: State, cfg: Config): number {
  const m = s.deltas.length ? Math.max(...s.deltas) : 0
  return Math.min(25, m * cfg.burnMultiplier)
}

function breaches(u: Usage, s: State, cfg: Config): Win[] {
  const out: Win[] = []
  for (const w of u.windows) {
    const lim = limitFor(w.kind, cfg)
    if (lim === undefined) continue
    if (w.percent >= lim || (w.kind === FIVE && w.percent + predictedJump(s, cfg) >= cfg.ceiling)) out.push(w)
  }
  return out
}

const backoffMs = (n: number) => (BACKOFF_SEC[Math.min(n, BACKOFF_SEC.length - 1)] ?? 900) * 1000

export function blocksAutomation(s: State): boolean {
  return (
    s.rec.phase === 'paused' ||
    s.rec.phase === 'stopped' ||
    s.rec.phase === 'compacting' ||
    (s.rec.phase === 'resuming' && !s.rec.delivered)
  )
}

export function compactInstructions(task: string): string {
  return (
    'A usage-limit pause is about to start and work will resume automatically afterwards. ' +
    'In the summary, state verbatim the current task' +
    (task ? ` ("${task.slice(0, 600)}")` : '') +
    ', what is already done, what remains, and the exact next step. Say which commands or background jobs were ' +
    'still running at this point (with their output files): they may finish during the pause, so they must be ' +
    'checked, not run again. Do not restart completed work.'
  )
}

const HELD_MAX = 8
const HELD_CHARS = 2000

// The notices a pause held back, as the model reads them with the continuation (or beside the person's prompt).
export function heldNotices(held: readonly string[]): string {
  return `Background work reported while the session was paused (these notices were held back until now):\n\n${held.join('\n\n')}`
}

// Identifies ONE resume operation: the text is not enough, because every operation shares the same instruction.
export const resumeMarker = (op: number | undefined) => `[quota-guard recovery #${op ?? 0}]`

export function resumePrompt(r: Rec): string {
  const bits = [RESUME_PROMPT]
  if (r.task) bits.push(`Task before the pause: ${r.task.slice(0, 1500)}`)
  if (r.held?.length) bits.push(heldNotices(r.held))
  bits.push(resumeMarker(r.op))
  return bits.join('\n\n')
}

// ---------- the machine ----------

export function step(s0: State, ev: Ev, cfg: Config): Result {
  const s = clone(s0)
  const fx: Fx[] = []
  const toast = (text: string) => fx.push({ t: 'toast', text })
  const r = s.rec
  if (!s.known) s.known = []
  const newOp = () => (s.opSeq = (s.opSeq ?? 0) + 1)
  // the windows a resume must see healthy: those that caused the pause plus every managed one ever seen
  const managedKinds = () => {
    const m = new Set(r.kinds.filter(k => limitFor(k, cfg) !== undefined))
    for (const k of s.known) if (limitFor(k, cfg) !== undefined) m.add(k)
    return m
  }
  // Why a window is in the pause: over its limit (static), or only predicted to be (burn rate). A
  // predictive cause is cleared only by THAT window moving on, never by another window's reset.
  // Records saved before causes existed carry one aggregate flag that cannot describe a mixed pause, so a
  // window is conservatively predictive unless the snapshot taken when the pause began shows it over its limit.
  const causeOf = (k: string): 'static' | 'predictive' => {
    const c = r.causes?.[k]
    if (c) return c
    const snap = r.usage.find(x => x.kind === k)
    if (snap) return snap.percent >= (limitFor(k, cfg) ?? Infinity) ? 'static' : 'predictive'
    return r.predictive ? 'predictive' : 'static'
  }
  const advanced = (k: string, w: Win | undefined) =>
    w !== undefined && w.resetsAt !== undefined && w.resetsAt > (r.resets?.[k] ?? r.expectedReset ?? 0) + 120_000
  const predictiveCleared = (u: Usage) => r.kinds.every(k => causeOf(k) !== 'predictive' || advanced(k, u.windows.find(x => x.kind === k)))
  // a window that breaches after the pause began joins it, with its own cause and baseline
  const join = (w: Win) => {
    // a cause is acquired fresh when the window was not part of the pause, or when its earlier cause was
    // resolved by that window moving on: the baseline (and the reason) belong to the window of THIS breach
    const was = r.kinds.includes(w.kind)
    const fresh = !was || advanced(w.kind, w)
    if (!was) r.kinds.push(w.kind)
    r.causes ??= {}
    r.resets ??= {}
    if (fresh) {
      r.causes[w.kind] = w.percent >= (limitFor(w.kind, cfg) ?? Infinity) ? 'static' : 'predictive'
      if (w.resetsAt !== undefined) r.resets[w.kind] = w.resetsAt
    } else r.causes[w.kind] ??= causeOf(w.kind) // pin what an older record could only imply
  }

  const endOpAs = (reason: Ended) => {
    if (r.phase === 'resuming' && r.op !== undefined) s.ended = { op: r.op, reason }
  }
  const settle = (task = r.task, reason?: Ended) => {
    if (reason) endOpAs(reason)
    s.rec = emptyRec(task)
  }

  const shouldCompact = () => s.ctx === undefined || s.ctx > cfg.compactMinContext

  const compactOrPause = (now: number) => {
    if (shouldCompact()) startCompact()
    else {
      r.compactedAt = undefined
      enterPause(now)
    }
  }

  const startCompact = () => {
    r.phase = 'compacting'
    r.op = newOp()
    fx.push({ t: 'compact', op: r.op, instructions: compactInstructions(r.task) })
  }

  const enterPause = (now: number) => {
    r.phase = 'paused'
    r.op = undefined
    r.pausedAt = now
    const grace = cfg.graceSec * 1000
    r.wakeAt = r.expectedReset === undefined ? now + backoffMs(r.delayCount) : Math.max(r.expectedReset + grace, now + 5000)
    if (r.compactFailed) toast(r.compactError ? `Compaction failed (${r.compactError}); pausing anyway.` : 'Compaction failed; pausing anyway.')
    toast(`Paused until approximately ${fmtClock(r.wakeAt)}.`)
  }

  const arm = (now: number, wins: Win[], all: Usage | null, reasonOverride?: string) => {
    const resets = wins.map(w => w.resetsAt).filter((x): x is number => typeof x === 'number')
    const task = r.task
    const fresh: Rec = {
      ...emptyRec(task),
      phase: 'armed',
      kinds: wins.map(w => w.kind),
      reason: reasonOverride ?? wins.map(w => describeWindow(w, now)).join('; '),
      expectedReset: resets.length ? Math.max(...resets) : undefined,
      usage: all ? all.windows.map(w => ({ ...w })) : wins.map(w => ({ ...w })),
      predictive: wins.every(w => w.percent < (limitFor(w.kind, cfg) ?? Infinity)),
      resets: Object.fromEntries((all ? all.windows : wins).filter(w => w.resetsAt !== undefined).map(w => [w.kind, w.resetsAt as number])),
      causes: Object.fromEntries(wins.map(w => [w.kind, w.percent >= (limitFor(w.kind, cfg) ?? Infinity) ? 'static' : 'predictive'])) as Rec['causes'],
    }
    for (const k of Object.keys(r)) delete (r as Record<string, unknown>)[k]
    Object.assign(r, fresh)
    r.op = newOp()
    // the worst breached window drives the message and the decision to abort a running turn
    const top = wins.reduce<Win | undefined>((m, w) => (m === undefined || w.percent > m.percent ? w : m), undefined)
    if (top) {
      const pct = Math.round(top.percent)
      toast(
        shouldCompact()
          ? `${label(top.kind)} usage reached ${pct}%. Compacting before quota exhaustion.`
          : `${label(top.kind)} usage reached ${pct}%. Context is only ${Math.round(s.ctx ?? 0)}%, so no compaction needed; waiting for the reset.`,
      )
    }
    if (s.busy) {
      if (top && top.percent >= cfg.abortThreshold) {
        r.abortRequested = true
        fx.push({ t: 'abort', op: r.op, turnId: s.turnId })
      }
    } else compactOrPause(now)
  }

  const resumeNow = (now: number, mode: 'confirmed' | 'assumed' | 'forced') => {
    if (r.resumeAttempts >= cfg.maxResumeAttempts) {
      r.phase = 'stopped'
      r.wakeAt = undefined
      toast(`Auto-resume gave up after ${r.resumeAttempts} attempts. Use /quota resume or send a prompt.`)
      return
    }
    r.phase = 'resuming'
    r.op = newOp()
    r.delivered = false
    r.deliveredAt = undefined
    r.started = false
    r.manual = mode === 'forced'
    r.verified = false
    r.verifiedKinds = undefined
    r.olderTurnRunning = s.busy
    r.olderTurnId = s.busy ? s.turnId : undefined
    r.turnId = undefined
    r.foreignTurns = undefined
    r.resumeAttempts++
    r.lastResumeAt = now
    toast(
      mode === 'confirmed'
        ? 'Usage reset confirmed. Preparing to resume task.'
        : mode === 'assumed'
          ? 'Reset time passed (usage not re-measured yet). Preparing a resume attempt to verify.'
          : 'Preparing to resume task.',
    )
    fx.push({ t: 'submit', op: r.op, text: resumePrompt(r), manual: r.manual === true })
  }

  const resumeFailed = (now: number, why: string, nextReset?: number) => {
    endOpAs('failed')
    r.op = undefined
    r.delivered = false
    r.deliveredAt = undefined
    r.started = false
    r.verified = false
    r.verifiedKinds = undefined
    r.olderTurnRunning = false
    r.olderTurnId = undefined
    r.turnId = undefined
    r.foreignTurns = undefined
    r.delayCount++
    if (r.resumeAttempts >= cfg.maxResumeAttempts) {
      r.phase = 'stopped'
      r.wakeAt = undefined
      toast(`Auto-resume gave up (${why}). Use /quota resume when the limit has reset.`)
      return
    }
    r.phase = 'paused'
    if (nextReset !== undefined) r.expectedReset = nextReset
    r.wakeAt = Math.max(nextReset !== undefined ? nextReset + cfg.graceSec * 1000 : 0, now + backoffMs(r.delayCount))
    toast(`Resume did not take (${why}). Trying again around ${fmtClock(r.wakeAt)}.`)
  }

  // The task has resumed only when the continuation's own turn starts: an accepted prompt is not a started one.
  // With the quota already verified the operation is done; otherwise its turn's outcome or a reading decides.
  const continuationStarted = () => {
    r.started = true
    r.delivered = true // a prompt that started was accepted, whichever of the two the adapter reports first
    if (r.verified && [...managedKinds()].every(k => r.verifiedKinds?.includes(k))) {
      settle(r.task, 'verified')
      toast('Quota reset verified; the task is continuing.')
    } else toast('The resume prompt started; the task is continuing.')
  }

  // Accepted but never started: sending it again could run the continuation twice if the first one is merely late
  const stalled = () => {
    endOpAs('stalled')
    r.phase = 'stopped'
    r.op = undefined
    r.wakeAt = undefined
    toast('The resume prompt was accepted but its turn never started, so auto-resume stopped instead of sending it twice. Send a prompt or use /quota resume to continue.')
  }

  const wake = (now: number, usage: Usage | null) => {
    if (!usage || usage.windows.length === 0) {
      r.delayCount++
      const longPast = r.expectedReset !== undefined && now - r.expectedReset >= LONG_PAST_RESET_MS
      const lateAndBlind = longPast || (r.delayCount >= 3 && (r.expectedReset === undefined || r.expectedReset <= now))
      if (lateAndBlind) return resumeNow(now, 'assumed')
      r.wakeAt = now + backoffMs(r.delayCount)
      if (r.delayCount === 1) toast('Usage data unavailable; will retry shortly.')
      return
    }
    // every managed window counts, not only the ones that caused the pause: another one may have
    // been exhausted since (or the pause started on a different window)
    const limited: number[] = []
    let stale = false
    const kinds = new Set(r.kinds.filter(k => limitFor(k, cfg) !== undefined))
    for (const w of usage.windows) if (limitFor(w.kind, cfg) !== undefined) kinds.add(w.kind)
    for (const k of s.known) if (limitFor(k, cfg) !== undefined) kinds.add(k)
    for (const k of kinds) {
      const w = usage.windows.find(x => x.kind === k)
      const lim = limitFor(k, cfg) ?? cfg.threshold
      if (!w) {
        stale = true
        continue
      }
      if (w.percent >= lim) {
        join(w)
        if (w.resetsAt !== undefined && w.resetsAt > now) limited.push(w.resetsAt)
        else stale = true // reading predates the reset; only a fresh response can tell
      } else if (r.kinds.includes(k) && causeOf(k) === 'predictive' && !advanced(k, w)) {
        if (w.resetsAt !== undefined && w.resetsAt > now) limited.push(w.resetsAt) // still the window that was about to run out
        else stale = true
      }
    }
    if (limited.length) {
      const next = Math.max(...limited)
      const moved = r.expectedReset === undefined || Math.abs(next - r.expectedReset) > 60_000
      r.expectedReset = next
      r.wakeAt = next + cfg.graceSec * 1000
      r.delayCount++
      toast(
        moved
          ? `Quota not reset yet; reset time moved to about ${fmtClock(next)}.`
          : `Quota not reset yet; rechecking around ${fmtClock(r.wakeAt)}.`,
      )
      return
    }
    resumeNow(now, stale ? 'assumed' : 'confirmed')
  }

  const tickLike = (now: number, usage: Usage | null) => {
    if (r.phase === 'paused' && cfg.enabled && !s.busy && r.wakeAt !== undefined && now >= r.wakeAt) wake(now, usage)
    // a turn that is running is the resume prompt being answered (or one ahead of it), however slowly: never time
    // it out and never queue a second probe behind it. A prompt never accepted is a failed attempt (retried later);
    // one accepted whose turn never started is stalled (not resent).
    else if (r.phase === 'resuming' && !s.busy && !r.started) {
      if (!r.delivered && r.lastResumeAt !== undefined && now - r.lastResumeAt > RESUME_WATCHDOG_MS) resumeFailed(now, 'no response to the resume prompt')
      else if (r.delivered && now - (r.deliveredAt ?? r.lastResumeAt ?? now) > START_WATCHDOG_MS) stalled()
    }
  }

  // Evidence about a resume in flight. Only a reading that is evidence counts. Under the limit in EVERY
  // managed window we have ever seen (and every predictive cause moved on): the reset happened. Over a
  // limit with a reset still ahead: it did not. Over it with a reset already past, a window missing, or an
  // unchanged snapshot of a burn-rate pause: the old reading again, no evidence either way. Later evidence
  // can contradict earlier evidence, so verification is withdrawn rather than latched.
  const assessResuming = (now: number, u: Usage, hit: Win[]) => {
    const managed = managedKinds()
    const limitedResets: number[] = []
    let allLow = managed.size > 0
    let anyHigh = false
    for (const k of managed) {
      const w = u.windows.find(x => x.kind === k)
      const lim = limitFor(k, cfg) ?? cfg.threshold
      if (!w) {
        allLow = false
        continue
      }
      if (w.percent >= lim) {
        allLow = false
        anyHigh = true
        if (w.resetsAt !== undefined && w.resetsAt > now) limitedResets.push(w.resetsAt)
      }
    }
    // a window that was fine when the pause began but is exhausted now blocks the resume too
    for (const w of hit) {
      if (r.kinds.includes(w.kind) || w.resetsAt === undefined || w.resetsAt <= now) continue
      join(w)
      limitedResets.push(w.resetsAt)
      allLow = false
      anyHigh = true
    }
    if (limitedResets.length) {
      resumeFailed(now, 'quota still exhausted', Math.max(...limitedResets))
    } else if (allLow && predictiveCleared(u)) {
      // quota is verified; the operation is only done once its continuation's turn has actually started
      if (r.started) {
        const task = r.task
        settle(task, 'verified')
        toast('Quota reset verified.')
      } else {
        r.verified = true
        r.verifiedKinds = [...managed]
      }
    } else if (anyHigh) {
      r.verified = false
      r.verifiedKinds = undefined
    }
  }

  const evaluate = (now: number, usage: Usage) => {
    const hit = breaches(usage, s, cfg)
    if (hit.length) arm(now, hit, usage)
  }

  if (ev.type === 'measure' || ev.type === 'tick' || ev.type === 'boot') {
    for (const w of ev.usage?.windows ?? []) if (limitFor(w.kind, cfg) !== undefined && !s.known.includes(w.kind)) s.known.push(w.kind)
  }

  switch (ev.type) {
    case 'measure': {
      if (typeof ev.usage.contextPercent === 'number') s.ctx = ev.usage.contextPercent
      if (!cfg.enabled) break
      const u = ev.usage
      const five = u.windows.find(w => w.kind === FIVE)
      if (five) {
        // burn-rate history is the growth over the last few measurements of THIS window: a new
        // window starts it over, and flat measurements age an old spike out
        const sameWindow = s.last !== undefined && Math.abs((s.last.resetsAt ?? 0) - (five.resetsAt ?? 0)) < 120_000
        if (!sameWindow) s.deltas = []
        // other sessions' spending since this one last looked is not this session's burn rate: it moves the
        // baseline, never the predicted jump
        else if (s.last && !ev.shared) {
          s.deltas.push(Math.max(0, five.percent - s.last.pct))
          s.deltas = s.deltas.slice(-5)
        }
        s.last = { pct: five.percent, resetsAt: five.resetsAt }
      }
      const hit = breaches(u, s, cfg)

      if (r.phase === 'resuming') {
        assessResuming(ev.now, u, hit)
        break
      }
      if (r.phase === 'idle') {
        if (hit.length) {
          arm(ev.now, hit, u)
          break
        }
        if (cfg.notifyAt > 0) {
          for (const w of u.windows) {
            if (limitFor(w.kind, cfg) === undefined && w.kind !== WEEK) continue
            const key = `${w.kind}@${Math.round((w.resetsAt ?? 0) / 60000)}`
            if (w.percent >= cfg.notifyAt && !s.notified.includes(key)) {
              s.notified = [...s.notified, key].slice(-10)
              toast(describeWindow(w, ev.now))
            }
          }
        }
        break
      }
      if (r.phase === 'armed') {
        r.usage = u.windows.map(w => ({ ...w }))
        // a window that is exhausted after arming joins the pause and sets how long it lasts
        for (const w of hit) {
          join(w)
          if (w.resetsAt !== undefined) r.expectedReset = Math.max(r.expectedReset ?? 0, w.resetsAt)
        }
        const worst = hit.reduce((m, w) => Math.max(m, w.percent), 0)
        if (s.busy && !r.abortRequested && worst >= cfg.abortThreshold) {
          r.abortRequested = true
          fx.push({ t: 'abort', op: r.op, turnId: s.turnId })
        }
        break
      }
      if (r.phase === 'paused') {
        for (const w of hit) join(w)
        const managed = managedKinds()
        const blocking: number[] = []
        let allLow = managed.size > 0
        for (const k of managed) {
          const w = u.windows.find(x => x.kind === k)
          const lim = limitFor(k, cfg) ?? cfg.threshold
          if (!w || w.percent >= lim) allLow = false
          if (w && w.percent >= lim && w.resetsAt !== undefined && w.resetsAt > ev.now) blocking.push(w.resetsAt)
          // a predictive cause that has not moved on keeps blocking until ITS OWN reset, whatever joined it
          if (w && r.kinds.includes(k) && causeOf(k) === 'predictive' && !advanced(k, w) && w.resetsAt !== undefined && w.resetsAt > ev.now) {
            blocking.push(w.resetsAt)
          }
        }
        if (blocking.length) {
          // only a reading that is still blocking can move the wake time
          const next = Math.max(...blocking)
          if (r.expectedReset === undefined || Math.abs(next - r.expectedReset) > 60_000) {
            r.expectedReset = next
            r.wakeAt = next + cfg.graceSec * 1000
            toast(`Reset time changed; now paused until approximately ${fmtClock(r.wakeAt)}.`)
          }
        } else if (allLow && predictiveCleared(u) && r.wakeAt !== undefined && r.wakeAt > ev.now) {
          // a fresh reading under every limit, with each burn-rate cause moved on, means the reset already happened
          r.wakeAt = ev.now
        }
      }
      break
    }

    case 'turnStart':
      s.busy = true
      s.turnId = ev.turnId
      if (r.phase === 'resuming') {
        // a turn that begins while resuming is the continuation's only if it is known to be (the adapter
        // recognises our prompt); with no information, one that starts before delivery cannot be
        const own = ev.owns ?? r.delivered === true
        if (own) {
          r.turnId = ev.turnId
          if (!r.started) continuationStarted()
        } else if (ev.turnId !== undefined) r.foreignTurns = [...(r.foreignTurns ?? []), ev.turnId]
      }
      break

    case 'turnComplete': {
      const id = ev.turnId
      const currentEnds = id === undefined || s.turnId === undefined || id === s.turnId
      if (!currentEnds) {
        // a late completion for a turn that is no longer the current one: it ends nothing that is running now
        if (r.phase === 'resuming' && id === r.olderTurnId) r.olderTurnRunning = false
        break
      }
      s.busy = false
      s.turnId = undefined
      if (r.phase === 'armed') {
        if (r.compactedAt !== undefined) enterPause(ev.now)
        else compactOrPause(ev.now)
      } else if (r.phase === 'resuming') {
        const ours =
          id === undefined
            ? !r.olderTurnRunning
            : r.turnId !== undefined
              ? id === r.turnId
              : !(r.foreignTurns ?? []).includes(id) && id !== r.olderTurnId
        if (!ours) {
          // the turn that was already running when this resume began, or another turn: not the continuation
          if (id === undefined || id === r.olderTurnId) r.olderTurnRunning = false
        } else if (ev.reason === 'error') resumeFailed(ev.now, 'API error')
        else if (ev.reason === 'aborted') {
          settle(r.task, 'interrupted')
          toast('Resume turn was interrupted; auto-resume finished.')
        } else {
          settle(r.task, 'completed') // the model answered after the reset: a served request is evidence
          toast('Quota reset verified.')
        }
      }
      break
    }

    case 'userPrompt': {
      if (!ev.isUser) break
      if (r.phase === 'paused' || r.phase === 'stopped') {
        settle(r.task)
        toast('Auto-resume cancelled: you resumed manually.')
      } else if (r.phase === 'resuming') {
        settle(r.task, 'takeover')
      } else if (r.phase === 'armed' || r.phase === 'compacting') {
        settle(r.task)
        toast('Quota pause cancelled: you sent a new prompt.')
      }
      const t = ev.text.trim()
      if (t && !t.startsWith('/') && (t.length >= 12 || !s.rec.task)) s.rec.task = t.slice(0, 4000)
      break
    }

    case 'compactDone': {
      if (ev.external) {
        // anyone's compaction of this conversation (the person's /compact, auto-compact) does the pause's job
        if (r.phase === 'armed' || r.phase === 'compacting') {
          r.compactedAt = ev.now
          r.compactFailed = false
          r.compactError = undefined
          if (!s.busy) enterPause(ev.now)
        }
        break
      }
      if (r.phase === 'compacting' && ev.op === r.op) {
        r.compactedAt = ev.ok ? ev.now : undefined
        r.compactFailed = !ev.ok
        r.compactError = ev.ok ? undefined : ev.detail?.slice(0, 200)
        enterPause(ev.now)
      }
      break
    }

    case 'tick':
      if (r.phase === 'resuming' && ev.usage && cfg.enabled) assessResuming(ev.now, ev.usage, breaches(ev.usage, s, cfg))
      tickLike(ev.now, ev.usage)
      break

    case 'boot': {
      s.busy = false
      if (ev.usage && typeof ev.usage.contextPercent === 'number') s.ctx = ev.usage.contextPercent
      if (r.phase === 'compacting' || r.phase === 'armed') {
        if (r.compactedAt !== undefined) {
          enterPause(ev.now)
        } else {
          settle(r.task)
          if (cfg.enabled && ev.usage) evaluate(ev.now, ev.usage)
        }
      } else if (r.phase === 'paused') {
        toast(
          r.wakeAt !== undefined && ev.now < r.wakeAt
            ? `Restored quota pause; checking again around ${fmtClock(r.wakeAt)}.`
            : 'Restored quota pause; reset time has passed, checking now.',
        )
        tickLike(ev.now, ev.usage)
      } else if (r.phase === 'resuming') {
        tickLike(ev.now, ev.usage)
      } else if (r.phase === 'idle' && cfg.enabled && ev.usage) {
        evaluate(ev.now, ev.usage)
      }
      break
    }

    case 'resumeDelivered': {
      // accepted, not started: the start watchdog runs from here until the continuation's turn begins
      if (r.phase !== 'resuming' || ev.op !== r.op) break
      r.delivered = true
      r.deliveredAt ??= ev.now
      break
    }

    case 'held': {
      // only while automatic prompts are held back; otherwise the notice reached the session normally
      if (!blocksAutomation(s)) break
      r.held = [...(r.held ?? []), ev.text.slice(0, HELD_CHARS)].slice(-HELD_MAX)
      break
    }

    case 'resumeStarted': {
      if (r.phase !== 'resuming' || ev.op !== r.op || r.started) break
      continuationStarted()
      break
    }

    case 'resumeHold': {
      // waiting for an account-wide slot is not silence: keep the no-response watchdog from timing the attempt out
      if (r.phase === 'resuming' && ev.op === r.op && !r.delivered) r.lastResumeAt = ev.now
      break
    }

    case 'resumeBlocked': {
      if (r.phase !== 'resuming' || ev.op !== r.op) break
      resumeFailed(ev.now, ev.why)
      break
    }

    case 'submitFailed': {
      if (r.phase !== 'resuming' || ev.op !== r.op) break
      r.op = undefined
      r.phase = 'stopped'
      r.wakeAt = undefined
      fx.push({ t: 'fill', text: ev.text })
      toast(`Could not submit the resume prompt automatically${ev.detail ? ` (${ev.detail.slice(0, 200)})` : ''}. It is in the prompt box: press Enter to continue.`)
      break
    }

    case 'forcePause': {
      if (r.phase !== 'idle' && r.phase !== 'stopped') {
        toast(`Already ${r.phase}.`)
        break
      }
      const reset = ev.now + ev.minutes * 60_000
      const task = r.task
      for (const k of Object.keys(r)) delete (r as Record<string, unknown>)[k]
      Object.assign(r, {
        ...emptyRec(task),
        phase: 'armed',
        kinds: ['forced'],
        reason: `forced pause for ${ev.minutes}m (testing)`,
        expectedReset: reset,
      })
      toast(`Forced pause: compacting, then waiting until about ${fmtClock(reset)}.`)
      if (!s.busy) compactOrPause(ev.now)
      break
    }

    case 'cancel': {
      if (r.phase === 'idle') {
        toast('Nothing pending to cancel.')
        break
      }
      endOpAs('cancelled')
      r.phase = 'stopped'
      r.op = undefined
      r.wakeAt = undefined
      toast('Auto-resume cancelled. Use /quota resume or send a prompt to continue.')
      break
    }

    case 'resume': {
      if (r.phase === 'paused' || r.phase === 'stopped') {
        r.resumeAttempts = 0
        resumeNow(ev.now, 'forced')
      } else if (r.phase === 'resuming' && !r.delivered) {
        // the automatic attempt is still waiting (for a coordination slot, say): replace it with an explicit one.
        // The old operation is invalidated at once; whoever holds a reservation for it releases it separately.
        endOpAs('cancelled')
        resumeNow(ev.now, 'forced')
      } else if (r.phase === 'resuming' && r.started) toast('The resume prompt was already delivered; it is being answered.')
      else if (r.phase === 'resuming') toast('The resume prompt was accepted and is waiting to start; it is not sent twice.')
      else toast('Nothing to resume.')
      break
    }
  }

  return { state: s, fx }
}

export function needsHeartbeat(s: State): boolean {
  return s.rec.phase === 'paused' || s.rec.phase === 'resuming'
}

export function statusLine(s: State, u: Usage | null, now: number): string | undefined {
  const r = s.rec
  if (r.phase === 'paused' && r.wakeAt !== undefined) return `quota pause until ${fmtClock(r.wakeAt)}`
  if (r.phase === 'resuming') return r.started ? 'quota: continuing task' : r.delivered ? 'quota: resume prompt queued' : 'quota: preparing resume'
  if (r.phase === 'stopped') return 'quota: auto-resume held'
  if (r.phase === 'compacting' || r.phase === 'armed') return 'quota: compacting'
  const five = u?.windows.find(w => w.kind === FIVE)
  if (!five) return undefined
  return `5h ${Math.round(five.percent)}%${five.resetsAt && five.resetsAt > now ? ` · ${fmtDur(five.resetsAt - now)}` : ''}`
}

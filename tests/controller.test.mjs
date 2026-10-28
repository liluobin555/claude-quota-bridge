import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/controller.mjs';
import {inspectSnapshot, trustedBridgeUrl, createClient, isBootstrapBinding} from '../src/contract.mjs';
import {compactVerified} from '../src/compaction.mjs';
import {snapshot} from './snapshot-fixture.mjs';

const T = 1793100000000;
const context = {tokens: 140000, percent: 70};
// Historical pause/resume behavior remains available by explicit selection.
function controller(config = {}) { return new Controller({sessionId: 'session-a', config: {afterCompact: 'pause', ...config}}); }

test('only the initial same-account same-VM attested bootstrap may adopt a live binding', () => {
  const before={...snapshot(),bindingSource:'single_vm_scope',bindingVersion:'bootstrap'};
  const live={...snapshot(),bindingSource:'live_sticky',bindingVersion:'live-1'};
  assert.equal(isBootstrapBinding(before,live),true);
  for(const change of [{accountRef:'other'},{vmId:'other'},{autoReady:false},{routeSafety:'observe_only'},{bindingSource:'last_executed'}])
    assert.equal(isBootstrapBinding(before,{...live,...change}),false);
  assert.equal(isBootstrapBinding(live,{...live,bindingVersion:'live-2'}),false);
});

test('bridge URLs require HTTPS or loopback and reject embedded secrets', () => {
  assert.equal(trustedBridgeUrl('http://127.0.0.1:47824/'), 'http://127.0.0.1:47824');
  for (const url of ['http://evil.example', 'https://user:pass@example.com', 'https://example.com/?secret=x']) assert.throws(() => trustedBridgeUrl(url));
});
test('foreign-session, missing weekly, stale and future readings are rejected', () => {
  for (const change of [{sessionId: 'other'}, {sampledAt: T-121000}, {sampledAt: T+10000}, {windows: []}]) assert.ok(inspectSnapshot({...snapshot(), ...change}, {sessionId: 'session-a', now: T}).reason);
});
test('only fresh official worker evidence may identify a zero-usage inactive window', () => {
  const s = snapshot(0); s.quotaSource = 'official_worker_usage'; s.windows[0].resetsAt = null; s.windows[0].inactive = true;
  assert.ok(inspectSnapshot(s,{sessionId:'session-a',now:T}).usage);
  assert.equal(inspectSnapshot({...s,quotaSource:'passive_headers'},{sessionId:'session-a',now:T}).reason,'reset_unverified');
  assert.equal(inspectSnapshot(s,{sessionId:'session-a',now:T+121000}).reason,'quota_stale');
});
test('85 percent compacts once, successful outcome pauses', () => {
  const c = controller(); const fx = c.ingest(snapshot(85), context, T);
  assert.equal(fx.filter(f => f.t === 'compact').length, 1);
  assert.equal(c.ingest(snapshot(86), context, T).filter(f => f.t === 'compact').length, 0);
  c.compactDone({ok: true, now: T+1}); assert.equal(c.state.rec.phase, 'paused');
});
test('post-compaction missing context keeps a verified manual pause without a permanent error', () => {
  const c=controller();c.ingest(snapshot(85),context,T);c.compactDone({ok:true,now:T+1});
  assert.deepEqual(c.ingest(snapshot(86),{window:1000000},T),[]);
  assert.equal(c.state.rec.phase,'paused');assert.equal(c.hold,undefined);assert.equal(c.blocksPrompts(),true);
});
test('unknown context before compaction recovers only after an actual context measurement', () => {
  const c=controller();assert.deepEqual(c.ingest(snapshot(85),{window:1000000},T),[]);assert.equal(c.hold,'unknown_context');
  assert.equal(c.ingest(snapshot(85),context,T).filter(x=>x.t==='compact').length,1);
  assert.equal(c.hold,undefined);
});
test('running turn arms and limits agents before compacting', () => {
  const c = controller(); c.dispatch({type: 'turnStart', turnId: 't'});
  assert.equal(c.ingest(snapshot(85), context, T).some(f => f.t === 'compact'), false);
  assert.equal(c.state.rec.phase, 'armed'); assert.ok(c.blocksNewAgents());
  assert.ok(c.dispatch({type: 'turnComplete', turnId: 't', reason: 'answer', now: T}).some(f => f.t === 'compact'));
});
test('failed or unsupported compaction never resumes', () => {
  for (const unsupported of [false, true]) {
    const c = controller({autoResume: true}); c.ingest(snapshot(85), context, T);
    c.compactDone({ok: false, unsupported, now: T});
    const s = snapshot(1); s.sampledAt = T+3700000; s.windows[0].resetsAt += 18000000;
    assert.equal(c.ingest(s, context, s.sampledAt).some(f => f.t === 'submit'), false);
  }
});
test('fresh same-account reset resumes only with opt-in', () => {
  for (const autoResume of [false, true]) {
    const c = controller({autoResume}); c.ingest(snapshot(85), context, T); c.compactDone({ok: true, now: T});
    const s = snapshot(1); s.sampledAt = T+3700000; s.windows[0].resetsAt += 18000000;
    assert.equal(c.ingest(s, {tokens: 10000, percent: 5}, s.sampledAt).some(f => f.t === 'submit'), autoResume);
  }
});
test('expired sample never cold-resumes and account changes hold', () => {
  const c = controller({autoResume: true}); c.ingest(snapshot(85), context, T); c.compactDone({ok: true, now: T});
  assert.equal(c.ingest(snapshot(0), context, T+3700000).length, 0); assert.equal(c.hold, 'quota_stale');
  c.ingest({...snapshot(), accountRef: 'other'}, context, T); assert.equal(c.hold, 'account_changed');
});
test('multi-account observe mode limits new agents at the threshold without automatic compaction', () => {
  const c = controller(); c.ingest({...snapshot(50), autoReady: false, routeSafety: 'observe_only'}, context, T);
  assert.equal(c.hold, 'observe_only'); assert.equal(c.blocksPrompts(), false); assert.equal(c.blocksNewAgents(), false);
  c.ingest({...snapshot(85), autoReady: false, routeSafety: 'observe_only'}, context, T); assert.equal(c.blocksNewAgents(), true);
});
test('stale observation mode allows an ordinary prompt to refresh passive headers, never a new agent', () => {
  const c = controller(); c.ingest({...snapshot(50), autoReady: false, routeSafety: 'observe_only', sampledAt: T-121000}, context, T);
  assert.equal(c.blocksPrompts(), false); assert.equal(c.blocksNewAgents(), true);
});
test('restored failed state cannot be cleared by a fresh snapshot', () => {
  const c = controller(); c.ingest(snapshot(85), context, T); c.compactDone({ok: false, now: T});
  const restored = new Controller({sessionId: 'session-a', saved: c.dump(), config: {afterCompact: 'pause'}});
  restored.ingest(snapshot(5), context, T); assert.equal(restored.hold, 'compaction_failed');
});
test('a changed live binding generation cannot silently reuse the same-account cache', () => {
  const c = controller(); c.ingest(snapshot(50), context, T);
  c.ingest({...snapshot(50), bindingVersion: 'generation-2'}, context, T);
  assert.equal(c.hold, 'binding_changed');
});
test('direct compaction needs measured shrink or observed completion', async () => {
  let reads = 0;
  const r = await compactVerified({context: async () => ({tokens: ++reads === 1 ? 140000 : 10000}), direct: async () => ({}), observed: () => false}, 'save progress');
  assert.ok(r.ok); assert.equal(r.route, 'direct');
});
test('headless direct refusal falls back in the same process and proves compaction', async () => {
  let seen = false;
  const r = await compactVerified({context: async () => ({tokens: seen ? 10000 : 140000}), direct: async () => {throw new Error('not available in a headless (-p / SDK) session');}, command: async () => {seen = true; return {};}, observed: () => seen}, 'save progress');
  assert.ok(r.ok); assert.equal(r.route, 'command');
});
test('silent queued command and veto do not count as compaction', async () => {
  const host = {context: async () => ({tokens: 140000}), direct: async () => {throw new Error('unsupported');}, command: async () => ({}), observed: () => false};
  assert.equal((await compactVerified(host, '')).ok, false);
  assert.equal((await compactVerified({...host, direct: async () => ({skip: 'policy'})}, '')).ok, false);
});
test('queued headless command waits for delayed completion evidence', async () => {
  let elapsed = 0;
  const r = await compactVerified({context: async () => ({tokens: elapsed >= 500 ? 10000 : 140000}),
    direct: async () => {throw new Error('unsupported');}, command: async () => ({}),
    observed: () => elapsed >= 500, sleep: async ms => {elapsed += ms;}}, 'save progress');
  assert.equal(r.ok, true); assert.equal(elapsed, 500);
});
test('HTTP adapter rejects redirects and never includes token in returned errors', async () => {
  let init;
  const call = createClient({baseUrl: 'https://quota.example', token: 'sk-test', fetcher: async (_, args) => {init = args; return {status: 409, text: '{"error":"account_busy"}'};}});
  await assert.rejects(call('/v1/lease', {}), /account_busy/); assert.equal(init.redirect, 'error');
});

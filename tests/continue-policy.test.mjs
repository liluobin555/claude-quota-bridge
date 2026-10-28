import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/controller.mjs';
import {snapshot} from './snapshot-fixture.mjs';
const T = 1793100000000;
const context = percent => ({tokens: percent * 10000, window: 1000000, percent});
const controller = saved => new Controller({sessionId: 'session-a', saved});
const compacts = fx => fx.filter(x => x.t === 'compact').length;

test('small high-quota session remains usable and can compact when it later reaches 50 percent', () => {
  const c = controller();
  assert.equal(compacts(c.ingest(snapshot(85), context(49), T)), 0);
  assert.equal(c.blocksPrompts(), false); assert.equal(c.blocksNewAgents(), false);
  assert.equal(compacts(c.ingest(snapshot(86), context(50), T)), 1);
  assert.equal(c.blocksPrompts(), true);
  c.compactDone({ok: true, now: T+1});
  assert.equal(c.blocksPrompts(), false); assert.equal(c.blocksNewAgents(), false);
  assert.equal(c.autoResume, false);
});
test('same window never loops even when context regrows, quota dips, timestamps jitter, and session restarts', () => {
  let c = controller(); c.ingest(snapshot(85), context(70), T); c.compactDone({ok: true, now: T});
  for (const percent of [86, 80, 99, 100]) {
    const s = snapshot(percent); s.windows[0].resetsAt += 30000;
    assert.equal(compacts(c.ingest(s, context(80), T)), 0);
  }
  c = controller(c.dump());
  assert.equal(compacts(c.ingest(snapshot(99), context(80), T)), 0);
  assert.equal(c.blocksPrompts(), false); assert.equal(c.blocksNewAgents(), false);
});
test('a subsequent high-quota window may compact once again', () => {
  const c = controller(); c.ingest(snapshot(85), context(70), T); c.compactDone({ok: true, now: T});
  const next = snapshot(85); next.sampledAt += 18000000; next.windows.forEach(w => w.resetsAt += 18000000);
  assert.equal(compacts(c.ingest(next, context(70), next.sampledAt)), 1);
});
test('simultaneous weekly and five-hour triggers consume one operation, not two', () => {
  const c = controller(), s = snapshot(85); s.windows[1].percent = 90;
  assert.equal(compacts(c.ingest(s, context(70), T)), 1);
  c.compactDone({ok: true, now: T});
  assert.equal(compacts(c.ingest(s, context(70), T)), 0);
  assert.equal(c.attemptedWindows.length, 2);
});
test('active root and children finish before compaction; 95 percent does not abort normal work', () => {
  const c = controller(); c.dispatch({type: 'turnStart', turnId: 'root'}); c.child('child', true);
  assert.deepEqual(c.ingest(snapshot(95), context(70), T), []);
  assert.equal(c.state.rec.phase, 'armed');
  assert.deepEqual(c.dispatch({type: 'turnComplete', turnId: 'root', now: T}), []);
  assert.equal(compacts(c.ingest(snapshot(95), context(70), T)), 0);
  c.child('child', false);
  assert.equal(compacts(c.ingest(snapshot(95), context(70), T)), 1);
});
test('continue mode never submits a recovery prompt or auto-retry', () => {
  const c = new Controller({sessionId: 'session-a', config: {autoResume: true}});
  c.ingest(snapshot(85), context(70), T);
  assert.deepEqual(c.compactDone({ok: true, now: T}), []);
  assert.deepEqual(c.ingest(snapshot(86), {window: 1000000}, T), []);
  assert.equal(c.hold, undefined); assert.equal(c.state.rec.phase, 'idle');
});
test('context, account and quota safety checks remain in force', () => {
  const c = controller(); c.ingest(snapshot(85), {window: 1000000}, T);
  assert.equal(c.hold, 'unknown_context');
  assert.equal(compacts(c.ingest(snapshot(85), context(70), T)), 1);
  c.compactDone({ok: true, now: T});
  assert.deepEqual(c.ingest({...snapshot(85), accountRef: 'other'}, context(70), T), []);
  assert.equal(c.hold, 'account_changed');
});
test('failed compaction stays held rather than issuing repeated billable attempts', () => {
  const c = controller(); c.ingest(snapshot(85), context(70), T); c.compactDone({ok: false, now: T});
  assert.deepEqual(c.ingest(snapshot(86), context(70), T), []);
  assert.equal(c.hold, 'compaction_failed');
});
test('old verified pause migrates without another compact or injected continuation', () => {
  const old = new Controller({sessionId: 'session-a', config: {afterCompact: 'pause'}});
  old.ingest(snapshot(85), context(70), T); old.compactDone({ok: true, now: T});
  const c = controller(old.dump());
  assert.deepEqual(c.ingest(snapshot(86), context(70), T), []);
  assert.equal(c.state.rec.phase, 'idle'); assert.equal(c.blocksPrompts(), false);
});
test('continue policy has no predictive pre-threshold compaction', () => {
  const c = controller();
  c.ingest(snapshot(60), context(70), T);
  assert.equal(compacts(c.ingest(snapshot(84), context(70), T)), 0);
});

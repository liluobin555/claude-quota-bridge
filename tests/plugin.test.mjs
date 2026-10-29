import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {snapshot} from './snapshot-fixture.mjs';

async function engine({headless = false, direct = true, command = true, env: overrides = {}, bridgeDown = false, config = {afterCompact: 'pause'}, bootstrap = false, deferredCompact = false, refreshAvailable = false, refreshFails = false, refreshDelayMs = 0} = {}) {
  const {register} = await import('../hooks/register.mjs?test=' + randomUUID());
  const hooks = new Map(), later = [], ticks = [], store = new Map(), reports = [];
  let now = 1793100000000, sample = snapshot(50), context = {tokens: 140000, percent: 70}, frame = 0;
  if(bootstrap)sample.bindingSource='single_vm_scope';
  let finishCompact;
  let compacts = 0, resumes = 0, agents = 0, httpCalls = 0, credentialReads = 0, refreshCalls = 0;
  if (refreshAvailable) {sample.capabilities = {refresh: true}; sample.fresh = true;}
  function on(name, matcher, callback) {
    if (typeof matcher === 'function') callback = matcher;
    hooks.set(name, callback);
    return {catch: handler => {const orig = callback; hooks.set(name, async ($, e, next) => {try {return await orig($, e, next);} catch {return handler($, e, next);}});}};
  }
  async function emit(name, event = {}, next = async () => ({})) {
    ++frame; try {return await hooks.get(name)($, event, next);} finally {--frame;}
  }
  const $ = {
    env: {get: async name => {
      if (['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'].includes(name)) credentialReads++;
      return {QUOTA_BRIDGE_ENABLED: '1', QUOTA_GATEWAY_BASE_URL: 'https://gateway.example/vm2api', ANTHROPIC_BASE_URL: 'https://gateway.example/vm2api',
        ANTHROPIC_AUTH_TOKEN: 'sk-dummy', ...(headless ? {QUOTA_RUNNER_URL: 'http://127.0.0.1:45678', QUOTA_RUNNER_TOKEN: 'dummy'} : {}), ...overrides}[name];
    }},
    clock: {now: async () => now, sleep: () => new Promise(() => {}), after: (_, f) => {later.push(f); return {cancel() {}};}, every: (_, f) => {ticks.push(f); return {cancel() {}};}},
    store: {get: async k => store.get(k), set: async (k, v) => store.set(k, structuredClone(v))},
    ui: {status: async () => {}, toast: async () => {}},
    http: {fetch: async (url, init) => {
      httpCalls++;
      const path = new URL(url).pathname;
      if (path === '/event') {reports.push(JSON.parse(init.body)); return {status: 200, text: '{}'};}
      if (bridgeDown) throw new Error('connection refused');
      if (path === '/v1/refresh') {
        refreshCalls++;
        if (refreshFails) throw new Error('usage_refresh_failed');
        now += refreshDelayMs;
        sample = {...sample, sampledAt: now, fresh: true};
      }
      if(path==='/v1/lease'&&JSON.parse(init.body).bindingVersion!==sample.bindingVersion)return {status:409,text:'{"error":"automation_not_ready"}'};
      const data = path === '/v1/lease' ? {leaseId: 'lease', expiresAt: now+60000} : path === '/v1/release' || path === '/v1/agent-event' ? {ok: true} : sample;
      return {status: 200, text: JSON.stringify(data)};
    }},
    session: {id: async () => 'session-a', surfaces: async () => headless ? [] : ['terminal'], usage: async () => ({context}), compact: async () => {
      if (!direct) throw new Error('not available in a headless (-p / SDK) session');
      assert.equal(frame, 0, 'compaction must occur outside hook frames');
      if(deferredCompact)await new Promise(resolve=>{finishCompact=resolve});
      compacts++; context = {tokens: 10000, percent: 5}; return {};
    }},
    command: {register: async () => {}, run: async () => {
      if (!command) throw new Error('no command named /compact');
      assert.equal(frame, 0); return emit('session.compact', {}, async () => {compacts++; context = {tokens: 10000, percent: 5}; return {};});
    }},
    prompt: {submit: async ({text}) => {resumes++; return emit('prompt.submit', {text, origin: {kind: 'plugin', name: 'vm2api-quota-guard'}}, async () => {await emit('turn.start', {turnId: 'resume-turn'}); return {text};});}},
    turn: {abort: async () => {}},
  };
  register(on, {autoResume: false, ...config});
  const flush = async () => {for (let i=0;i<50;i++) {while (later.length) later.shift()(); await new Promise(resolve => setImmediate(resolve));}};
  await emit('session.start'); await flush();
  return {emit, flush, reports, ticks, get httpCalls() {return httpCalls;}, get refreshCalls() {return refreshCalls;}, get credentialReads() {return credentialReads;}, get writes() {return store.size;}, get compacts() {return compacts;}, get resumes() {return resumes;},
    high() {sample = {...snapshot(85),bindingSource:sample.bindingSource};}, setContext(value) {context = value;}, setLive() {sample={...sample,bindingSource:'live_sticky',bindingVersion:'live-2'};}, finishCompact() {finishCompact();}, reset() {now += 3700000; sample = snapshot(1); sample.sampledAt = now; sample.windows[0].resetsAt = now+18000000;},
    stale() {now += 121000; sample = {...sample, fresh: false};}, status: async () => JSON.parse((await emit('command.run', {args: 'status'})).text),
    async spawn() {return emit('agent.spawn', {}, async () => ({agentId: 'child-'+(++agents)}));},
    async finish() {await emit('turn.complete', {turnId: 'main-turn', reason: 'answer'}); await flush();},
  };
}

test('interactive hooks compact outside frames, pause, then resume on fresh reset', async () => {
  const e = await engine({config: {afterCompact: 'pause', autoResume: true}}); await e.emit('turn.start', {turnId: 'main-turn'}); e.high();
  await e.emit('session.measure'); await e.flush(); assert.equal((await e.status()).phase, 'armed');
  await e.finish(); assert.equal(e.compacts, 1); assert.equal((await e.status()).phase, 'paused');
  e.reset(); e.ticks[0](); await e.flush(); assert.equal(e.resumes, 1);
});
test('globally loaded plugin is inert for subscription CLI/Desktop even when bridge is down', async () => {
  for (const env of [{QUOTA_BRIDGE_ENABLED: undefined, ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: undefined},
    {QUOTA_BRIDGE_ENABLED: undefined}, {ANTHROPIC_BASE_URL: undefined}, {ANTHROPIC_BASE_URL: 'https://api.anthropic.com'},
    {ANTHROPIC_BASE_URL: 'https://unrelated-gateway.example'}]) {
    const e = await engine({env, bridgeDown: true});
    const prompt = await e.emit('prompt.submit', {text: 'normal subscription prompt'}, async () => ({text: 'passed'}));
    assert.equal(prompt.text, 'passed'); assert.equal((await e.spawn()).agentId, 'child-1');
    await e.emit('turn.start', {turnId: 'ordinary'}); await e.emit('session.measure'); await e.flush();
    assert.equal(e.httpCalls, 0); assert.equal(e.credentialReads, 0); assert.equal(e.writes, 0); assert.equal(e.compacts, 0);
  }
});
test('an explicitly managed API process holds when the quota bridge is unavailable', async () => {
  const e = await engine({bridgeDown: true});
  assert.equal((await e.status()).hold, 'bridge_unavailable');
  const result = await e.emit('prompt.submit', {text: 'guarded job'});
  assert.ok(result.drop); assert.equal(e.compacts, 0);
});
test('supervised headless hooks use in-session command fallback', async () => {
  const e = await engine({headless: true, direct: false});
  await e.emit('turn.start', {turnId: 'main-turn'}); e.high(); await e.emit('session.measure'); await e.flush(); await e.finish();
  assert.equal(e.compacts, 1); assert.equal((await e.status()).phase, 'paused');
  assert.ok(e.reports.some(r => r.ready)); assert.ok(e.reports.some(r => r.compaction?.ok));
});
test('headless unsupported fallback holds without an automatic continuation', async () => {
  const e = await engine({headless: true, direct: false, command: false});
  await e.emit('turn.start', {turnId: 'main-turn'}); e.high(); await e.emit('session.measure'); await e.flush(); await e.finish();
  assert.equal((await e.status()).hold, 'compaction_unsupported'); e.reset(); e.ticks[0](); await e.flush(); assert.equal(e.resumes, 0);
});
test('child usage lifecycle is recorded; high quota denies new agents', async () => {
  const e = await engine(); const child = await e.spawn(); assert.equal(child.agentId, 'child-1');
  await e.emit('turn.start', {turnId: 'main-turn'}); e.high();
  const denied = await e.spawn(); assert.match(denied.deny, /no new agent/);
  await e.finish(); assert.equal(e.compacts, 0); assert.equal((await e.status()).hold, 'children_still_running');
  await e.emit('turn.complete', {agentId: 'child-1', turnId: 'child-turn', reason: 'answer'}); await e.flush();
  assert.equal(e.compacts, 1);
});
test('a background completion during quota pause is saved rather than lost', async () => {
  const e = await engine(); await e.emit('turn.start', {turnId: 'main-turn'}); e.high();
  await e.emit('session.measure'); await e.flush(); await e.finish();
  const result = await e.emit('prompt.submit', {text: 'Background build finished; results in build.log', origin: {kind: 'task-notification'}});
  assert.ok(result.drop); assert.equal((await e.status()).heldNotifications, 1);
});
test('continue policy permits user, background and agent requests after a single compact while quota stays high', async () => {
  const e = await engine({config: {}});
  await e.emit('turn.start', {turnId: 'main-turn'}); e.high();
  await e.emit('session.measure'); await e.flush(); await e.finish();
  assert.equal(e.compacts, 1); assert.equal((await e.status()).phase, 'idle');
  for (const origin of [undefined, {kind: 'task-notification'}, {kind: 'peer'}]) {
    const r = await e.emit('prompt.submit', {text: 'Continue the existing work', origin}, async () => ({accepted: true}));
    assert.equal(r.accepted, true);
  }
  assert.equal((await e.spawn()).agentId, 'child-1');
  e.setContext({tokens: 800000, window: 1000000, percent: 80});
  e.ticks[0](); await e.flush();
  assert.equal(e.compacts, 1); assert.equal(e.resumes, 0);
});
test('headless continue policy uses the same-session fallback and reports idle without requiring auto-resume', async () => {
  const e = await engine({headless: true, direct: false, config: {}});
  await e.emit('turn.start', {turnId: 'main-turn'}); e.high(); await e.emit('session.measure'); await e.flush(); await e.finish();
  assert.equal(e.compacts, 1); assert.equal((await e.status()).phase, 'idle');
  assert.ok(e.reports.some(r => r.compaction?.ok && r.phase === 'idle'));
  assert.equal(e.resumes, 0);
});
test('per-process environment explicitly selects the context threshold and continuation policy', async () => {
  const e = await engine({env: {QUOTA_AFTER_COMPACT: 'continue', QUOTA_COMPACT_MIN_CONTEXT: '75'}});
  e.high(); await e.emit('session.measure'); await e.flush();
  assert.equal(e.compacts, 0); assert.equal((await e.status()).compactMinContext, 75);
  e.setContext({tokens: 750000, window: 1000000, percent: 75});
  await e.emit('session.measure'); await e.flush();
  assert.equal(e.compacts, 1); assert.equal((await e.status()).phase, 'idle');
});
test('long first compaction renews across same-account bootstrap binding establishment', async () => {
  const e=await engine({config:{},bootstrap:true,deferredCompact:true});
  e.high();await e.emit('session.measure');await e.flush();
  assert.equal((await e.status()).phase,'compacting');
  e.setLive();e.ticks.at(-1)();await e.flush();
  e.finishCompact();await e.flush();
  assert.equal((await e.status()).hold,undefined);assert.equal((await e.status()).compaction.ok,true);
  assert.equal((await e.status()).phase,'idle');
});
test('a generation change after an existing live binding still loses the compaction lease', async () => {
  const e=await engine({config:{},deferredCompact:true});
  e.high();await e.emit('session.measure');await e.flush();
  e.setLive();e.ticks.at(-1)();await e.flush();
  e.finishCompact();await e.flush();
  assert.equal((await e.status()).hold,'compaction_failed');
  assert.equal((await e.status()).compaction.ok,false);
});

test('usage-only quota refresh recovers stale data even when a main turn is marked busy', async () => {
  const e=await engine({refreshAvailable:true,config:{afterCompact:'continue'}});
  await e.emit('turn.start',{turnId:'waiting-or-restored-turn'});
  e.stale();e.ticks[0]();await e.flush();
  assert.equal(e.refreshCalls,1);
  assert.equal((await e.status()).hold,undefined);
  const r=await e.emit('prompt.submit',{text:'human retry'},async()=>({accepted:true}));
  assert.equal(r.accepted,true);
  assert.equal(e.compacts,0);assert.equal(e.resumes,0);
  e.ticks[0]();await e.flush();assert.equal(e.refreshCalls,1);
});

test('failed usage refresh stays protected and respects retry cooldown while busy', async () => {
  const e=await engine({refreshAvailable:true,refreshFails:true,config:{afterCompact:'continue'}});
  await e.emit('turn.start',{turnId:'waiting-turn'});e.stale();e.ticks[0]();await e.flush();
  assert.equal(e.refreshCalls,1);assert.equal((await e.status()).hold,'bridge_unavailable');
  const r=await e.emit('prompt.submit',{text:'retry'});
  assert.ok(r.drop);assert.equal(e.refreshCalls,1);
  assert.equal(e.compacts,0);assert.equal(e.resumes,0);
});


test('slow successful usage refresh is validated against the completion time', async () => {
  const e=await engine({refreshAvailable:true,refreshDelayMs:15000,config:{afterCompact:'continue'}});
  e.stale();e.ticks[0]();await e.flush();
  assert.equal(e.refreshCalls,1);
  assert.equal((await e.status()).hold,undefined);
  assert.equal((await e.emit('prompt.submit',{text:'retry'},async()=>({accepted:true}))).accepted,true);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {run} from '../bin/claude-quota-run.mjs';
const claude = fileURLToPath(new URL('./mock-cli.mjs', import.meta.url));
async function withRun(mode, options, check) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'quota-run-'));
  let output = '';
  try {
    const stateFile = path.join(tmp, 'job.json');
    const result = await run({claude, prompt: 'Test job', stateFile, gatewayUrl: 'https://gateway.example/vm2api', env: {...process.env, QUOTA_MOCK_MODE: mode}, stdout: {write: b => {output += b;}}, stderr: {write: () => {}}, healthTimeoutMs: 3000, maxWaitMs: 10000, ...options});
    await check(result, JSON.parse(readFileSync(stateFile, 'utf8')), output, stateFile);
  } finally {rmSync(tmp, {recursive: true, force: true});}
}
test('runner completes only after plugin handshake and settled result', () => withRun('normal', {}, (r, state, out) => {
  assert.equal(r.code, 0); assert.equal(state.phase, 'complete'); assert.match(out, /"result"/);
  assert.doesNotMatch(JSON.stringify(state), /QUOTA_RUNNER_TOKEN|Bearer|Test job/);
}));
test('non-auto paused job exits 75 with compacted state intact', () => withRun('pause', {}, (r, s) => {assert.equal(r.code, 75); assert.equal(s.compaction.ok, true); assert.equal(s.phase, 'paused');}));
test('auto mode stays alive through pause and completes after reset', () => withRun('resume', {autoResume: true, healthTimeoutMs: 5000}, r => assert.equal(r.code, 0)));
test('unsupported compaction never retries task automatically', () => withRun('unsupported', {autoResume: true}, (r, s) => {assert.equal(r.code, 75); assert.equal(s.hold, 'compaction_unsupported');}));
test('a normal CLI result without plugin handshake is not success', () => withRun('no-handshake', {healthTimeoutMs: 1000}, r => assert.equal(r.code, 69)));
test('invalid plugin is rejected before launching a task process', () => withRun('invalid-plugin', {}, (r,s,out)=>{
  assert.equal(r.code,69);assert.equal(s.hold,'plugin_validation_failed');assert.equal(out,'');
}));
test('unexpected CLI exit does not start a duplicate process', () => withRun('early-exit', {}, (r, s) => {assert.equal(r.code, 69); assert.equal(s.hold, 'unexpected_cli_exit');}));
test('quota bridge outage saves a protected job and exits 75', () => withRun('bridge-down', {}, (r, s) => {assert.equal(r.code, 75); assert.equal(s.hold, 'bridge_unavailable');}));
test('runner waits for an in-flight manual command before closing stdin', () => withRun('command', {}, (r,s,out)=>{
  assert.equal(r.code,0); assert.match(out, /"state":"completed"/); assert.match(out,/"local_command":"compact"/);
}));
test('runner rejects session-changing flags', async () => {
  await assert.rejects(run({prompt: 'x', stateFile: '/unused', extraArgs: ['--fork-session']}), /runner_manages/);
});
test('runner refuses a missing gateway before launching a process', async () => {
  await assert.rejects(run({prompt: 'x', stateFile: '/unused', env: {}}), /gateway_required/);
});
test('HTTPS bridge requires no SSH and a compacted continuing job finishes normally with auto-resume off', () =>
  withRun('https-continue', {bridgeUrl: 'https://quota.example/quota-bridge'}, (r, s) => {
    assert.equal(r.code, 0); assert.equal(s.phase, 'complete'); assert.equal(s.compaction.ok, true);
  }));
test('runner rejects remote plaintext HTTP before starting any client process', async () => {
  await assert.rejects(run({prompt: 'x', stateFile: '/unused', gatewayUrl: 'https://gateway.example', bridgeUrl: 'http://quota.example'}), /https_or_loopback_required/);
});

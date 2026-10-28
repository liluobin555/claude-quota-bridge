import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activation} from '../src/scope.mjs';
import {scopedEnvironment} from '../bin/claude-quota.mjs';

test('opt-in and exact gateway match are both required', () => {
  const base = {enabled: '1', expectedGateway: 'https://gateway.example/vm2api', actualGateway: 'https://gateway.example/vm2api/'};
  assert.equal(activation(base).active, true);
  for (const change of [{enabled: undefined}, {actualGateway: undefined}, {actualGateway: 'https://api.anthropic.com'},
    {actualGateway: 'https://another.example/vm2api'}, {actualGateway: 'https://gateway.example/other'}, {expectedGateway: undefined}]) {
    assert.equal(activation({...base, ...change}).active, false);
  }
});
test('interactive launcher scopes flags to child and preserves subscription credentials and parent environment', () => {
  const env = {CLAUDE_CODE_OAUTH_TOKEN: 'dummy-subscription', QUOTA_RUNNER_URL: 'http://127.0.0.1:1', QUOTA_RUNNER_TOKEN: 'stale'};
  const before = structuredClone(env);
  const child = scopedEnvironment(env, 'https://gateway.example/vm2api');
  assert.deepEqual(env, before); assert.equal(child.QUOTA_BRIDGE_ENABLED, '1'); assert.equal(child.QUOTA_RUNNER_URL, undefined);
  assert.equal(child.ANTHROPIC_BASE_URL, undefined); assert.equal(child.CLAUDE_CODE_OAUTH_TOKEN, 'dummy-subscription');
});
test('interactive HTTPS bridge selection is process-scoped and rejects public plaintext HTTP', () => {
  const env = {ANTHROPIC_BASE_URL: 'https://gateway.example'};
  const child = scopedEnvironment(env, undefined, 'https://quota.example/quota-bridge/');
  assert.equal(child.QUOTA_BRIDGE_URL, 'https://quota.example/quota-bridge');
  assert.equal(env.QUOTA_BRIDGE_URL, undefined);
  assert.throws(() => scopedEnvironment(env, undefined, 'http://quota.example'), /https_or_loopback_required/);
});

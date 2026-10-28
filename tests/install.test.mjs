import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeSettings} from '../scripts/install-client.mjs';
test('installer preserves credentials, model settings, MCP and other plugin paths', () => {
  const current = {env: {ANTHROPIC_AUTH_TOKEN: 'sk-dummy', ANTHROPIC_BASE_URL: 'https://gateway.example', CLAUDE_CODE_PLUGIN_DIRS: 'C:/other'}, modelSettings: {opus: {autoCompactWindow: 700000}}, mcpServers: {x: {command: 'x'}}};
  const before = structuredClone(current);
  const result = mergeSettings(current, 'C:/quota', 'http://127.0.0.1:47824', ';');
  assert.deepEqual(current, before); assert.deepEqual(result.modelSettings, before.modelSettings); assert.deepEqual(result.mcpServers, before.mcpServers);
  assert.equal(result.env.ANTHROPIC_AUTH_TOKEN, 'sk-dummy'); assert.equal(result.env.CLAUDE_CODE_PLUGIN_DIRS, 'C:/other;C:/quota');
  assert.deepEqual(mergeSettings(result, 'C:/quota', 'http://127.0.0.1:47824', ';'), result);
});

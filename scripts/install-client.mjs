#!/usr/bin/env node
// Explicit installer: merges settings, backs them up, never reads/displays credentials individually.
import {readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, copyFileSync, chmodSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {trustedBridgeUrl} from '../src/contract.mjs';
export function mergeSettings(current, root, bridge, separator = path.delimiter) {
  const settings = structuredClone(current);
  settings.env ??= {};
  if (typeof settings.env !== 'object' || Array.isArray(settings.env)) throw new Error('settings.env must be an object');
  const entries = String(settings.env.CLAUDE_CODE_PLUGIN_DIRS || '').split(separator).filter(Boolean);
  if (!entries.includes(root)) entries.push(root);
  settings.env.CLAUDE_CODE_PLUGIN_DIRS = entries.join(separator);
  settings.env.QUOTA_BRIDGE_URL = trustedBridgeUrl(bridge);
  return settings;
}
export function main(args) {
  let file = path.join(os.homedir(), '.claude', 'settings.json'), bridge = 'http://127.0.0.1:47824', dry = false;
  for (let i=0;i<args.length;i++) {
    if (args[i] === '--settings') file = path.resolve(args[++i]);
    else if (args[i] === '--bridge-url') bridge = args[++i];
    else if (args[i] === '--dry-run') dry = true;
    else throw new Error('unknown installer argument');
  }
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const result = mergeSettings(current, root, bridge);
  if (!dry) {
    mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    if (existsSync(file)) {const backup = file + '.quota-bridge-' + Date.now() + '.bak'; copyFileSync(file, backup); chmodSync(backup, 0o600);}
    const tmp = file + '.quota-bridge.tmp';
    writeFileSync(tmp, JSON.stringify(result, null, 2)+'\n', {mode: 0o600}); renameSync(tmp, file);
  }
  console.log(dry ? 'Settings parsed; two environment entries would be merged. No changes.' : 'Plugin path and bridge URL merged; other configuration preserved. Restart Claude Code.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {main(process.argv.slice(2));} catch (error) {console.error(error.message); process.exitCode = 1;}
}

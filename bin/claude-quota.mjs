#!/usr/bin/env node
// Scope quota control to one interactive process. Never mutate parent/user settings.
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalGateway} from '../src/scope.mjs';
import {trustedBridgeUrl} from '../src/contract.mjs';

export function scopedEnvironment(env, gateway, bridge) {
  const expected = canonicalGateway(gateway || env.QUOTA_GATEWAY_BASE_URL || env.ANTHROPIC_BASE_URL);
  if (!expected) throw new Error('Provide --gateway-url for the intended vm2api endpoint');
  const child = {...env, QUOTA_BRIDGE_ENABLED: '1', QUOTA_GATEWAY_BASE_URL: expected};
  if (bridge || env.QUOTA_BRIDGE_URL) child.QUOTA_BRIDGE_URL = trustedBridgeUrl(bridge || env.QUOTA_BRIDGE_URL);
  delete child.QUOTA_RUNNER_URL; delete child.QUOTA_RUNNER_TOKEN;
  return child;
}
export function main(argv = process.argv.slice(2)) {
  let claude = 'claude', gateway, bridge, args = [];
  for (let i=0;i<argv.length;i++) {
    if (argv[i] === '--gateway-url') gateway = argv[++i];
    else if (argv[i] === '--bridge-url') bridge = argv[++i];
    else if (argv[i] === '--claude') claude = argv[++i];
    else if (argv[i] === '--') {args = argv.slice(i+1); break;}
    else throw new Error('Usage: claude-quota --gateway-url https://your-vm2api [--bridge-url https://your-quota-bridge] [--claude executable] [-- Claude arguments]');
  }
  if (args.some(a => a === '-p' || a === '--print' || a.startsWith('--print='))) throw new Error('For -p use claude-quota-run');
  const env = scopedEnvironment(process.env, gateway, bridge);
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const script = /\.[cm]?js$/i.test(claude);
  const childArgs = ['--plugin-dir', root, ...args];
  const child = spawn(script ? process.execPath : claude, script ? [claude, ...childArgs] : childArgs, {stdio: 'inherit', env, shell: false});
  child.on('error', () => {console.error('Unable to start Claude'); process.exitCode = 69;});
  child.on('exit', code => {process.exitCode = code ?? 1;});
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {main();} catch (e) {console.error(e.message); process.exitCode = 64;}
}

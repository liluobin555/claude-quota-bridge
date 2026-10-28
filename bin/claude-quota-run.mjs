#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalGateway} from '../src/scope.mjs';
import {trustedBridgeUrl} from '../src/contract.mjs';

export function saveState(file, state) {
  mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = file + '.' + randomUUID() + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', {mode: 0o600});
  renameSync(tmp, file);
}

export async function run({prompt, stateFile, resume = false, claude = 'claude', extraArgs = [], autoResume = false,
  cwd = process.cwd(), env = process.env, stdout = process.stdout, stderr = process.stderr,
  gatewayUrl, bridgeUrl, settleDelayMs = 300, healthTimeoutMs = 120000, maxWaitMs = 6 * 3600000, pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))}) {
  if (extraArgs.some(a => /^(--(?:bare|continue|resume|session-id|fork-session|input-format|output-format|plugin-dir|no-session-persistence)|-c|-r|-p|--print)(=|$)/.test(a))) throw new Error('runner_manages_session_and_plugin_flags');
  const expectedGateway = canonicalGateway(gatewayUrl || env.QUOTA_GATEWAY_BASE_URL || env.ANTHROPIC_BASE_URL);
  if (!expectedGateway) throw new Error('gateway_required: pass --gateway-url or an explicit gateway environment variable');
  const bridge = bridgeUrl || env.QUOTA_BRIDGE_URL;
  const bridgeEnv = bridge ? {QUOTA_BRIDGE_URL: trustedBridgeUrl(bridge)} : {};
  const file = path.resolve(stateFile);
  mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const lockPath = file + '.lock';
  let lock;
  try { lock = openSync(lockPath, 'wx', 0o600); } catch { throw new Error('state_locked: remove a stale lock only after verifying the previous process has exited'); }
  writeFileSync(lock, String(process.pid));
  let server, child, interval, hardStop, forceStop, finished = false;
  try {
    if (existsSync(file) && !resume) throw new Error('state_exists: use --resume-state explicitly');
    if (resume && !existsSync(file)) throw new Error('resume_state_missing');
    let state = resume ? JSON.parse(readFileSync(file, 'utf8')) : {version: 1, sessionId: randomUUID(), cwd: path.resolve(cwd)};
    if (state.version !== 1 || !/^[0-9a-f-]{36}$/i.test(state.sessionId) || state.cwd !== path.resolve(cwd)) throw new Error('invalid_session_or_working_directory');
    const token = randomBytes(32).toString('hex');
    let ready = false, result, lastEvent = Date.now(), phase = 'starting', hold, busy = true, evaluating = false, expectedClose = false, compactBoundaries = 0;
    const pendingCommands = new Set();
    const persist = () => saveState(file, {...state, phase, hold, updatedAt: new Date().toISOString()});
    persist();
    // A manifest can appear in init.plugins even when invalid hooks were disabled.
    // Validate the actual module graph before any task input reaches the CLI.
    const isScript = /\.[cm]?js$/i.test(claude);
    const validation = spawn(isScript ? process.execPath : claude,
      [...(isScript ? [claude] : []), 'plugin', 'validate', pluginDir],
      {cwd, env: {...env, QUOTA_BRIDGE_ENABLED: '0'}, stdio: 'ignore', shell: false});
    const valid = await new Promise(resolve => {
      const deadline=setTimeout(()=>{validation.kill('SIGTERM');resolve(false);},10000);
      validation.once('error',()=>{clearTimeout(deadline);resolve(false);});
      validation.once('exit',code=>{clearTimeout(deadline);resolve(code===0);});
    });
    if(!valid){hold='plugin_validation_failed';persist();return {code:69,sessionId:state.sessionId,phase,hold};}
    server = createServer(async (req, res) => {
      const expected = Buffer.from('Bearer ' + token), auth = Buffer.from(req.headers.authorization || '');
      if (req.headers.origin || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {res.writeHead(403); res.end(); return;}
      if (req.method === 'GET' && req.url === '/status') {
        res.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'});
        res.end(JSON.stringify({sessionId: state.sessionId, compactBoundaries})); return;
      }
      if (req.method !== 'POST' || req.url !== '/event') {res.writeHead(404); res.end(); return;}
      try {
        let raw = ''; for await (const part of req) {raw += part; if (raw.length > 16384) throw new Error('large');}
        const event = JSON.parse(raw);
        if (event.sessionId !== state.sessionId) throw new Error('wrong session');
        if (expectedClose) {res.writeHead(200); res.end('{"ok":true}'); return;}
        ready ||= event.ready === true;
        phase = event.phase; hold = event.hold;
        busy = event.busy ?? (phase === 'idle' ? false : busy);
        evaluating = event.evaluating === true;
        state = {...state, compaction: event.compaction, accountRef: event.accountRef, children: event.children};
        lastEvent = Date.now(); persist();
        res.writeHead(200, {'content-type': 'application/json'}); res.end('{"ok":true}');
      } catch {res.writeHead(400); res.end();}
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--plugin-dir', pluginDir,
      ...(resume ? ['--resume', state.sessionId] : ['--session-id', state.sessionId]), ...extraArgs];
    const script = /\.[cm]?js$/i.test(claude);
    child = spawn(script ? process.execPath : claude, script ? [claude, ...args] : args, {cwd, env: {...env, ...bridgeEnv, QUOTA_BRIDGE_ENABLED: '1', QUOTA_GATEWAY_BASE_URL: expectedGateway, QUOTA_RUNNER_URL: `http://127.0.0.1:${server.address().port}`, QUOTA_RUNNER_TOKEN: token, QUOTA_AUTO_RESUME: autoResume ? '1' : '0'}, stdio: ['pipe', 'pipe', 'pipe'], shell: false});
    // A process using stream-json stays open for control/compaction; never launch a second /compact process.
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify({type: 'user', session_id: state.sessionId,
      message: {role: 'user', content: prompt}}) + '\n');
    let buffered = '';
    child.stdout.on('data', bytes => {
      stdout.write(bytes);
      buffered += bytes.toString();
      if (buffered.length > 4 * 1024 * 1024) {hold = 'oversized_cli_record'; child.kill(); return;}
      let end;
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        try {
          const row = JSON.parse(line);
          if (row.type === 'command_lifecycle' && row.command_uuid) {
            if (row.state === 'started') pendingCommands.add(row.command_uuid);
            if (['completed','failed','cancelled','canceled','aborted','interrupted'].includes(row.state)) pendingCommands.delete(row.command_uuid);
          }
          if (row.type === 'system' && row.subtype === 'compact_boundary' && row.session_id === state.sessionId) compactBoundaries++;
          if (row.type === 'result') result = {subtype: row.subtype, at: Date.now()};
        } catch { /* pass through CLI output, never execute it */ }
      }
    });
    child.stderr.on('data', b => stderr.write(b));
    let stopCode;
    const stop = (code, reason) => {
      if (expectedClose) return;
      expectedClose = true; stopCode = code;
      if (reason) hold = reason;
      persist(); child.stdin.end();
      hardStop = setTimeout(() => {
        child.kill('SIGTERM');
        forceStop = setTimeout(() => child.kill('SIGKILL'), 5000);
      }, 2000);
    };
    const started = Date.now();
    interval = setInterval(() => {
      const now = Date.now();
      if (!ready && now - started > Math.min(healthTimeoutMs, 10000)) return stop(69, 'plugin_handshake_missing');
      if (now - lastEvent > healthTimeoutMs) return stop(69, 'plugin_heartbeat_lost');
      if (now - started > maxWaitMs) return stop(75, 'runner_wait_timeout');
      if (hold && hold !== 'observe_only') return stop(75, hold);
      if (!autoResume && phase === 'paused') return stop(75);
      if (ready && result && !busy && !evaluating && pendingCommands.size === 0 && phase === 'idle' && now - result.at > Math.max(300,settleDelayMs)) {
        phase = 'complete'; stop(result.subtype === 'success' ? 0 : 1);
      }
    }, 50);
    const onSignal = () => stop(130, 'interrupted');
    process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
    try {
      const exit = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({code, signal}));
      });
      if (!expectedClose) {
        hold = ready ? 'unexpected_cli_exit' : 'plugin_handshake_missing'; persist();
      }
      finished = true;
      return {code: stopCode ?? (exit.code || 69), sessionId: state.sessionId, phase, hold};
    } finally {process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);}
  } finally {
    clearInterval(interval); clearTimeout(hardStop); clearTimeout(forceStop);
    if (child && !finished) child.kill('SIGTERM');
    if (server) await new Promise(resolve => server.close(resolve));
    closeSync(lock); unlinkSync(lockPath);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = {extraArgs: []};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--') {options.extraArgs = argv.slice(i + 1); break;}
    if (flag === '--state' || flag === '--resume-state') {options.stateFile = argv[++i]; options.resume = flag === '--resume-state';}
    else if (flag === '--prompt-file') options.prompt = readFileSync(argv[++i], 'utf8');
    else if (flag === '--claude') options.claude = argv[++i];
    else if (flag === '--gateway-url') options.gatewayUrl = argv[++i];
    else if (flag === '--bridge-url') options.bridgeUrl = argv[++i];
    else if (flag === '--cwd') options.cwd = argv[++i];
    else if (flag === '--auto-resume') options.autoResume = true;
    else throw new Error('Usage: claude-quota-run --state job.json --prompt-file task.txt [--bridge-url https://your-quota-bridge] [--auto-resume] [--claude executable] [-- --model model]');
  }
  if (!options.stateFile || !options.prompt) throw new Error('--state/--resume-state and --prompt-file are required');
  const result = await run(options);
  process.stderr.write(`quota runner: ${result.phase}${result.hold ? ' / ' + result.hold : ''}; exit ${result.code}\n`);
  return result.code;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => {process.exitCode = code;}).catch(error => {console.error('quota runner:', error.message); process.exitCode = 64;});
}

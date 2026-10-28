"""Opt-in native Claude runtime check against localhost fakes only. No real SK/model calls.
Usage: python3 tests/native-smoke.py --claude /absolute/path/to/claude [--pressure]
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import sys
import uuid
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from server.bridge import handler_for
from fixtures import fixture, extra, TOKEN


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--claude', required=True)
    parser.add_argument('--pressure', action='store_true')
    parser.add_argument('--resume-test', action='store_true')
    parser.add_argument('--deny-agent-test', action='store_true')
    parser.add_argument('--bridge-down', action='store_true')
    parser.add_argument('--unmanaged', action='store_true')
    parser.add_argument('--invalid-plugin', action='store_true')
    parser.add_argument('--continue-test', action='store_true', help='v0.1.5 50-percent threshold, compact once and complete without pause')
    args = parser.parse_args()
    count = [0]
    requests = []
    sandbox = tempfile.TemporaryDirectory(prefix='quota-native-db-')
    backend, db, config = fixture(sandbox.name, lambda: int(time.time()*1000))
    db.close()
    import sqlite3
    db = sqlite3.connect(Path(sandbox.name)/'kin.sqlite', check_same_thread=False)
    now = int(time.time()*1000)
    db.execute('UPDATE accounts SET extra=? WHERE id=?', (extra(50, now, now+3600000), 'account-a')); db.commit()
    root_session = ['']
    class Handler(handler_for(backend)):
        def log_message(self, *a): pass
        def reply_model(self, value):
            raw = json.dumps(value).encode(); self.send_response(200)
            self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(raw)))
            self.end_headers(); self.wfile.write(raw)
        def do_GET(self):
            from urllib.parse import parse_qs, urlsplit
            query = parse_qs(urlsplit(self.path).query)
            root_session[0] = query.get('sessionId', [root_session[0]])[0]
            self.dispatch()
        def do_POST(self):
            if '/messages' not in self.path:
                return self.dispatch()
            raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            body = json.loads(raw)
            count[0] += 1
            now = int(time.time()*1000)
            percent = (1 if args.resume_test and count[0] >= 2 else 85) if args.pressure or args.deny_agent_test or args.continue_test else 50
            db.execute('UPDATE accounts SET extra=? WHERE id=?', (extra(percent, now, now+(18000000 if args.resume_test and count[0] >= 2 else 3600000)), 'account-a'))
            db.execute('INSERT OR REPLACE INTO sticky_sessions VALUES(?,?,?,?,?)', ('sess:'+root_session[0], now+86400000, 'vm-a', 'account-a', 1))
            simulated_input = (600000 if args.continue_test else 300000) if (args.pressure or args.continue_test) and count[0] == 1 else 1000
            db.execute('INSERT INTO usage_logs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', ('log-'+str(uuid.uuid4()), time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'key-a', root_session[0], 200, 'vm-a', 'account-a', 'account-a', simulated_input, 5, 0, 0)); db.commit()
            requests.append({'path': self.path.split('?')[0], 'model': body.get('model'), 'stream': body.get('stream'), 'messages': len(body.get('messages', [])),
                'agentRequest': bool(self.headers.get('x-claude-code-agent-id')), 'quotaDenialInHistory': 'quota bridge: no new agent' in json.dumps(body.get('messages', []))})
            usage = {'input_tokens': simulated_input, 'output_tokens': 5,
                     'cache_creation_input_tokens': 0, 'cache_read_input_tokens': 0}
            text = 'Task complete. No files changed. No pending work.'
            message = {'id': 'msg_fake_'+str(count[0]), 'type': 'message', 'role': 'assistant', 'model': body.get('model'),
                'content': [{'type': 'text', 'text': text}], 'stop_reason': 'end_turn', 'stop_sequence': None, 'usage': usage}
            if not body.get('stream'): return self.reply_model(message)
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
            events = [
                ('message_start', {'type': 'message_start', 'message': {**message, 'content': [], 'stop_reason': None, 'usage': {**usage, 'output_tokens': 0}}}),
                ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}}),
                ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': text}}),
                ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
                ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 5}}),
                ('message_stop', {'type': 'message_stop'}),
            ]
            if args.deny_agent_test and count[0] == 1:
                tool = next((t['name'] for t in body.get('tools', []) if t['name'] in ('Task', 'Agent')), 'Task')
                events[1] = ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'tool_use', 'id': 'toolu_quota_fixture', 'name': tool, 'input': {}}})
                events[2] = ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps({'description': 'fixture child', 'prompt': 'Reply OK without tools.', 'subagent_type': 'Explore'})}})
                events[4][1]['delta']['stop_reason'] = 'tool_use'
            for event, data in events:
                self.wfile.write(('event: '+event+'\ndata: '+json.dumps(data)+'\n\n').encode()); self.wfile.flush()
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix='quota-native-') as temp:
        tmp = Path(temp); (tmp/'task.txt').write_text('Reply with a short acknowledgement. Do not use tools or modify files.')
        env = {**os.environ, 'CLAUDE_CONFIG_DIR': str(tmp/'config'), 'ANTHROPIC_AUTH_TOKEN': TOKEN,
               'ANTHROPIC_BASE_URL': 'http://127.0.0.1:'+str(server.server_address[1]), 'QUOTA_BRIDGE_URL': 'http://127.0.0.1:'+str(server.server_address[1]),
               'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_TELEMETRY': '1', 'DISABLE_ERROR_REPORTING': '1'}
        env.update(QUOTA_AFTER_COMPACT='continue' if args.continue_test else 'pause',
                   QUOTA_COMPACT_MIN_CONTEXT='50' if args.continue_test else '20', QUOTA_AUTO_RESUME='0')
        for key in ('ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDE_CODE_PLUGIN_DIR_WATCH'):
            env.pop(key, None)
        if args.bridge_down: env['QUOTA_BRIDGE_URL'] = 'http://127.0.0.1:1'
        for key in ('QUOTA_BRIDGE_ENABLED', 'QUOTA_GATEWAY_BASE_URL', 'QUOTA_RUNNER_URL', 'QUOTA_RUNNER_TOKEN'):
            env.pop(key, None)
        try:
            command = [args.claude, '-p', 'Reply OK without tools.', '--output-format', 'stream-json', '--verbose', '--plugin-dir', str(root), '--model', 'claude-opus-4-6[1m]'] if args.unmanaged else [
                'node', str(root/'bin/claude-quota-run.mjs'), '--state', str(tmp/'job.json'), '--prompt-file', str(tmp/'task.txt'),
                '--claude', args.claude, '--cwd', temp, *(['--auto-resume'] if args.resume_test else []), '--', '--model', 'claude-opus-4-6[1m]']
            if args.invalid_plugin:
                invalid=tmp/'invalid-plugin'
                (invalid/'.claude-plugin').mkdir(parents=True);(invalid/'hooks').mkdir()
                (invalid/'.claude-plugin/plugin.json').write_text('{"name":"invalid-guard-test","version":"0.0.1","description":"Intentional duplicate hook fixture."}')
                (invalid/'hooks/hooks.json').write_text('{"modules":["./register.mjs"]}')
                (invalid/'hooks/register.mjs').write_text("export function register(on){on('session.start',($,e,next)=>next(e));on('session.start',($,e,next)=>next(e));}")
                program="import {run} from "+json.dumps((root/'bin/claude-quota-run.mjs').as_uri())+"; const r=await run({prompt:'Do not call a model.',stateFile:"+json.dumps(str(tmp/'job.json'))+",cwd:"+json.dumps(temp)+",claude:"+json.dumps(args.claude)+",pluginDir:"+json.dumps(str(invalid))+",gatewayUrl:process.env.ANTHROPIC_BASE_URL,env:process.env,maxWaitMs:15000}); process.exitCode=r.code;"
                command=['node','--input-type=module','-e',program]
            result = subprocess.run(command, cwd=temp, env=env, capture_output=True, timeout=80, text=True)
            state = {'phase': 'unmanaged_complete'} if args.unmanaged else json.loads((tmp/'job.json').read_text())
            report = {'nativeExitCode': result.returncode, 'state': state, 'localMockRequests': requests,
                      'realUpstreamModelCalls': 0, 'pressure': args.pressure, 'bridge': 'real_backend_with_fixture_database_and_SK_auth', 'stderrTail': result.stderr[-2000:], 'stdoutTail': result.stdout[-5000:]}
        except subprocess.TimeoutExpired:
            report = {'error': 'native_runtime_timeout', 'localMockRequests': requests, 'realUpstreamModelCalls': 0}
        expected = 75 if args.deny_agent_test or args.pressure and not args.resume_test else 0
        if args.continue_test: expected = 0
        if args.bridge_down: expected = 0 if args.unmanaged else 75
        if args.invalid_plugin: expected=69
        report['passed'] = report.get('nativeExitCode') == expected
        if args.pressure or args.continue_test:
            report['passed'] = report['passed'] and report.get('state', {}).get('compaction', {}).get('ok') is True
        if args.deny_agent_test:
            report['passed'] = report['passed'] and any(r['quotaDenialInHistory'] for r in requests) and not any(r['agentRequest'] for r in requests)
        if args.bridge_down:
            report['passed'] = report['passed'] and (len(requests) == 1 if args.unmanaged else len(requests) == 0)
        if args.invalid_plugin:
            report['passed']=report['passed'] and not requests and report.get('state',{}).get('hold')=='plugin_validation_failed'
        filename = 'native-continue.json' if args.continue_test else 'native-invalid-plugin.json' if args.invalid_plugin else 'native-unmanaged-bridge-down.json' if args.bridge_down and args.unmanaged else 'native-bridge-down.json' if args.bridge_down else 'native-agent-gate.json' if args.deny_agent_test else 'native-resume.json' if args.resume_test else 'native-pressure.json' if args.pressure else 'native-smoke.json'
        (root/'reports').mkdir(exist_ok=True)
        (root/'reports'/filename).write_text(json.dumps(report, indent=2)+'\n')
        print(json.dumps(report, indent=2))
    server.shutdown(); server.server_close(); thread.join()
    backend.close(); db.close(); sandbox.cleanup()
    if not report['passed']: raise SystemExit(1)


if __name__ == '__main__': main()

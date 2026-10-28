import concurrent.futures
import json
import socket
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from server.bridge import Backend, Denied, agent_session, epoch, handler_for
from fixtures import fixture, extra, NOW, TOKEN, OTHER


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.backend, self.db, self.config = fixture(self.tmp.name)

    def tearDown(self):
        self.db.close(); self.backend.close(); self.tmp.cleanup()

    def snap(self, token=TOKEN, session='session-a'):
        return self.backend.snapshot(token, session)

    def test_single_vm_mapping_and_percent(self):
        s = self.snap()
        self.assertEqual(s['windows'][0]['percent'], 50)
        self.assertTrue(s['autoReady'])
        self.assertFalse(s['schedulerPin'])
        self.assertEqual(s['bindingSource'], 'live_sticky')

    def test_never_write_vm2api_database(self):
        before = self.db.iterdump()
        before = '\n'.join(before)
        s = self.snap()
        self.backend.lease(TOKEN, {**s, 'kind': 'compact'})
        self.assertEqual('\n'.join(self.db.iterdump()), before)
        c = self.backend.connect()
        with self.assertRaises(sqlite3.OperationalError): c.execute('DELETE FROM accounts')
        c.close()

    def test_state_database_cannot_point_at_vm2api(self):
        with self.assertRaises(ValueError): Backend({**self.config, 'stateDb': self.config['vm2apiDb']})

    def test_invalid_key(self):
        with self.assertRaises(Denied): self.snap('sk-invalid')

    def test_disabled_expired_owner(self):
        for field, value in [('status', 'disabled'), ('deleted_at', 'now'), ('expires_at', '2020-01-01T00:00:00Z')]:
            self.db.execute('UPDATE api_keys SET '+field+'=? WHERE id=?', (value, 'key-a')); self.db.commit()
            with self.assertRaises(Denied): self.snap()
            self.db.execute('UPDATE api_keys SET status=?,deleted_at=NULL,expires_at=NULL WHERE id=?', ('active', 'key-a')); self.db.commit()
        self.db.execute("INSERT INTO users VALUES('user-a','disabled',NULL)")
        self.db.execute("UPDATE api_keys SET user_id='user-a' WHERE id='key-a'"); self.db.commit()
        with self.assertRaises(Denied): self.snap()

    def test_other_key_cannot_read_same_session_account(self):
        a, b = self.snap(), self.snap(OTHER)
        self.assertNotEqual(a['accountRef'], b['accountRef'])
        self.assertEqual(b['bindingSource'], 'single_vm_scope')
        self.assertEqual(b['vmId'], 'vm-b')

    def test_global_key_does_not_leak_foreign_session(self):
        self.db.execute("UPDATE api_keys SET group_type='all' WHERE id='key-b'"); self.db.commit()
        s = self.snap(OTHER)
        self.assertIsNone(s['accountRef']); self.assertFalse(s['autoReady'])

    def test_scope_changed_is_denied(self):
        self.db.execute("UPDATE api_keys SET allowed_vms='[]' WHERE id='key-a'"); self.db.commit()
        with self.assertRaises(Denied): self.snap()

    def test_stale_and_elapsed_reset_never_fabricate_zero(self):
        self.db.execute('UPDATE accounts SET extra=? WHERE id=?', (extra(99, NOW-400000, NOW-1), 'account-a')); self.db.commit()
        s = self.snap()
        self.assertEqual(s['windows'][0]['percent'], 99)
        self.assertFalse(s['fresh']); self.assertFalse(s['autoReady'])

    def test_official_probe_uses_data_at_not_checked_at(self):
        e = json.loads(extra(99, NOW-400000))
        u = e['unified']; u['official'] = {'5h': {'utilization': .01, 'reset': NOW+3600000}, '7d': {'utilization': .3, 'reset': NOW+86400000}, 'updated_at': NOW}
        u['last_probe_check'] = {'ok': True, 'via': 'go-worker', 'at': NOW, 'data_at': NOW-300000}
        self.db.execute('UPDATE accounts SET extra=? WHERE id=?', (json.dumps(e), 'account-a')); self.db.commit()
        self.assertFalse(self.snap()['fresh'])
        u['last_probe_check']['data_at'] = NOW
        self.db.execute('UPDATE accounts SET extra=? WHERE id=?', (json.dumps(e), 'account-a')); self.db.commit()
        self.assertTrue(self.snap()['fresh']); self.assertEqual(self.snap()['windows'][0]['percent'], 1)

    def test_private_usage_cache_accepts_an_official_inactive_window_without_inventing_reset(self):
        path = self.tmp.name+'/official.json'
        self.backend.cfg['officialQuotaFile'] = path
        self.db.execute('UPDATE accounts SET extra=? WHERE id=?',(extra(50,NOW-1000),'account-a')); self.db.commit()
        cached = {'entries':{'vm-a':{'accountId':'account-a','source':'slot-worker-usage','success':True,'sampledAt':NOW,
            'windows':[{'kind':'five_hour','percent':0,'resetsAt':None,'inactive':True},
                       {'kind':'seven_day','percent':35,'resetsAt':NOW+86400000,'inactive':False}]}}}
        from pathlib import Path
        Path(path).write_text(json.dumps(cached))
        s = self.snap(); self.assertTrue(s['autoReady']); self.assertEqual(s['quotaSource'],'official_worker_usage')
        self.assertIsNone(s['windows'][0]['resetsAt'])
        cached['entries']['vm-a']['accountId'] = 'other-account'; Path(path).write_text(json.dumps(cached))
        self.assertEqual(self.snap()['quotaSource'],'passive_headers')

    def test_vm_disabled_blocks_automation(self):
        self.db.execute("UPDATE vms SET schedulable=0 WHERE id='vm-a'"); self.db.commit()
        self.assertFalse(self.snap()['autoReady'])

    def test_usage_socket_refresh_is_fixed_scoped_fresh_and_throttled(self):
        from pathlib import Path
        path = self.tmp.name+'/official.json'
        sock_path = self.tmp.name+'/usage.sock'
        self.backend.cfg.update(officialQuotaFile=path, usageRefreshSocket=sock_path,
            allowRefresh=True, refreshAllowedKeyIds=['key-a'], refreshVmId='vm-a')
        self.db.execute('UPDATE accounts SET extra=? WHERE id=?', (extra(90,NOW-400000),'account-a')); self.db.commit()
        self.assertFalse(self.snap()['fresh'])
        with self.assertRaises(Denied) as denied:
            self.backend.refresh(OTHER, {'sessionId':'session-b'})
        self.assertEqual(denied.exception.code, 'refresh_disabled')
        requests=[]
        server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); server.bind(sock_path);server.listen(1);server.settimeout(3)
        def respond():
            with server.accept()[0] as peer:
                requests.append(peer.recv(512))
                Path(path).write_text(json.dumps({'entries':{'vm-a':{'accountId':'account-a','source':'slot-worker-usage','success':True,'sampledAt':NOW,
                    'windows':[{'kind':'five_hour','percent':45,'resetsAt':NOW+3600000},
                               {'kind':'seven_day','percent':35,'resetsAt':NOW+86400000}]}}}))
                peer.sendall(b'{"ok":true}\n')
        thread=threading.Thread(target=respond);thread.start()
        try:
            s=self.backend.refresh(TOKEN, {'sessionId':'session-a','vmId':'attacker-chosen'})
            self.assertTrue(s['fresh']); self.assertEqual(s['quotaSource'],'official_worker_usage')
            self.assertEqual(s['windows'][0]['percent'],45)
            self.assertEqual(requests,[b'{"op":"usage"}\n'])
            shared=self.backend.refresh(TOKEN, {'sessionId':'session-a'})
            self.assertTrue(shared['fresh'])
            self.assertEqual(requests,[b'{"op":"usage"}\n'])
        finally:
            thread.join(3);server.close()

    def test_usage_socket_success_without_fresh_data_is_not_success(self):
        from unittest.mock import MagicMock, patch
        self.backend.cfg.update(usageRefreshSocket='/not-contacted',allowRefresh=True,
            refreshAllowedKeyIds=['key-a'],refreshVmId='vm-a')
        self.db.execute('UPDATE accounts SET extra=? WHERE id=?', (extra(90,NOW-400000),'account-a'));self.db.commit()
        peer=MagicMock();peer.recv.return_value=b'{"ok":true}\n'
        peer.__enter__.return_value=peer
        with patch('server.bridge.socket.socket',return_value=peer):
            with self.assertRaises(Denied) as denied:
                self.backend.refresh(TOKEN,{'sessionId':'session-a'})
        self.assertEqual(denied.exception.code,'quota_refresh_no_fresh_sample')

    def test_concurrent_usage_refreshes_share_one_fixed_worker_operation(self):
        from pathlib import Path
        import time
        path=self.tmp.name+'/shared-official.json';sock_path=self.tmp.name+'/shared.sock'
        self.backend.cfg.update(officialQuotaFile=path,usageRefreshSocket=sock_path,allowRefresh=True,
            refreshAllowedKeyIds=['key-a'],refreshVmId='vm-a')
        self.db.execute('UPDATE accounts SET extra=? WHERE id=?',(extra(90,NOW-400000),'account-a'));self.db.commit()
        server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);server.bind(sock_path);server.listen(8);server.settimeout(3)
        requests=[]
        def respond():
            with server.accept()[0] as peer:
                requests.append(peer.recv(512));time.sleep(.15)
                Path(path).write_text(json.dumps({'entries':{'vm-a':{'accountId':'account-a','source':'slot-worker-usage','success':True,'sampledAt':NOW,
                    'windows':[{'kind':'five_hour','percent':45,'resetsAt':NOW+3600000},{'kind':'seven_day','percent':35,'resetsAt':NOW+86400000}]}}}))
                peer.sendall(b'{"ok":true}\n')
        worker=threading.Thread(target=respond);worker.start()
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                results=list(pool.map(lambda i:self.backend.refresh(TOKEN,{'sessionId':'parallel-'+str(i)}),range(8)))
            self.assertTrue(all(r['fresh'] and r['windows'][0]['percent']==45 for r in results))
            self.assertEqual(len({r['sampledAt'] for r in results}),1)
            self.assertEqual(requests,[b'{"op":"usage"}\n'])
            self.assertEqual(self.backend.refresh_inflight,{})
        finally:
            worker.join(3);server.close()

    def test_attestation_is_required(self):
        self.backend.cfg['verifiedSingleVmKeyIds'] = []
        self.assertFalse(self.snap()['autoReady'])

    def test_last_executed_not_current_binding(self):
        self.db.execute('DELETE FROM sticky_sessions'); self.db.commit()
        s = self.snap(); self.assertEqual(s['bindingSource'], 'last_executed'); self.assertFalse(s['autoReady'])

    def test_concurrent_leases_are_atomic(self):
        s = self.snap()
        def reserve(i):
            try: return self.backend.lease(TOKEN, self.backend.snapshot(TOKEN, 'new-'+str(i)))
            except Denied: return None
        # Each caller is authorized by the same explicit single-VM scope.
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            grants = list(pool.map(reserve, range(8)))
        self.assertEqual(sum(g is not None for g in grants), 1)

    def test_lease_owner_renew_release_and_expiry(self):
        s = self.snap(); body = {**s, 'kind': 'compact'}
        grant = self.backend.lease(TOKEN, body)
        self.assertEqual(self.backend.lease(TOKEN, {**body, **grant})['leaseId'], grant['leaseId'])
        self.backend.release(OTHER, {'sessionId': 'session-a', **grant})
        with self.assertRaises(Denied): self.backend.lease(TOKEN, {**body, 'sessionId': 'another'})
        self.backend.release(TOKEN, {'sessionId': 'session-a', **grant})
        self.assertIn('leaseId', self.backend.lease(TOKEN, body))

    def test_agent_stats_use_derived_session_and_real_logs(self):
        child = agent_session('session-a', 'agent-1')
        self.backend.agent_event(TOKEN, {'sessionId': 'session-a', 'agentId': 'agent-1', 'event': 'start'})
        self.db.execute('INSERT INTO usage_logs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', ('log-child', '2026-10-27T11:21:00Z', 'key-a', child, 200, 'vm-a', 'account-a', 'account-a', 40, 20, 60000, 300)); self.db.commit()
        stats = self.backend.stats(TOKEN, 'session-a')['agents'][0]
        self.assertEqual(stats['cacheReadTokens'], 60000)
        self.assertEqual(stats['requests'], 1)
        self.assertEqual(self.backend.stats(OTHER, 'session-a')['agents'], [])

    def test_no_refresh_without_explicit_opt_in(self):
        with self.assertRaises(Denied): self.backend.refresh(TOKEN, {'sessionId': 'session-a'})

    def test_numeric_and_iso_timestamps(self):
        self.assertEqual(epoch(NOW), epoch(NOW/1000))
        self.assertEqual(epoch('2026-10-27T11:20:00Z'), NOW)
        self.assertIsNone(epoch('invalid'))

    def test_http_auth_origin_and_secret_redaction(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(self.backend))
        worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
        base = 'http://127.0.0.1:'+str(server.server_address[1])
        try:
            request = urllib.request.Request(base+'/v1/session?sessionId=session-a', headers={'Authorization': 'Bearer '+TOKEN})
            data = urllib.request.urlopen(request).read().decode()
            self.assertNotIn('_key', data); self.assertNotIn('account-a', data); self.assertNotIn(TOKEN, data)
            request.add_header('Origin', 'https://evil.example')
            with self.assertRaises(urllib.error.HTTPError) as error: urllib.request.urlopen(request)
            self.assertEqual(error.exception.code, 403)
        finally: server.shutdown(); server.server_close(); worker.join()

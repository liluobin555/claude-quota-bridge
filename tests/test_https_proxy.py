"""Real local TLS/reverse-proxy/auth test. Dummy keys, local fixtures, no models."""
import json
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from fixtures import fixture, TOKEN, OTHER
from server.bridge import handler_for


@unittest.skipUnless(shutil.which('nginx') and shutil.which('openssl'), 'local nginx and openssl are optional test tools')
class HttpsProxyTests(unittest.TestCase):
    def test_tls_auth_scope_and_private_upstream(self):
        with tempfile.TemporaryDirectory(prefix='quota-tls-') as temp:
            root = Path(temp)
            backend, db, _ = fixture(root)
            upstream = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(backend))
            thread = threading.Thread(target=upstream.serve_forever, daemon=True)
            thread.start()
            nginx = None
            try:
                (root/'cert.conf').write_text('[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n')
                subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                                '-config', str(root/'cert.conf'), '-keyout', str(root/'key.pem'), '-out', str(root/'cert.pem')],
                               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
                with socket.socket() as s:
                    s.bind(('127.0.0.1', 0))
                    port = s.getsockname()[1]
                template = (Path(__file__).resolve().parent.parent/'deploy/nginx-quota-bridge.conf.example').read_text()
                zone, location = template.split('location /quota-bridge/', 1)
                location = 'location /quota-bridge/' + location
                location = location.replace('127.0.0.1:47824', '127.0.0.1:' + str(upstream.server_address[1]))
                config = (f'pid {root}/nginx.pid; error_log {root}/error.log; events {{}} http {{\n{zone}\n'
                          f'client_body_temp_path {root}/body; proxy_temp_path {root}/proxy; access_log off;\n'
                          f'server {{ listen 127.0.0.1:{port} ssl; ssl_certificate {root}/cert.pem; ssl_certificate_key {root}/key.pem;\n'
                          f'{location}\n}} }}')
                (root/'nginx.conf').write_text(config)
                command = ['nginx', '-e', str(root/'bootstrap.log'), '-p', str(root), '-c', str(root/'nginx.conf')]
                checked = subprocess.run(command + ['-t'], capture_output=True, text=True, timeout=5)
                if checked.returncode and 'sysctlbyname(net.inet.tcp.sendspace) failed (1: Operation not permitted)' in checked.stderr:
                    self.skipTest('nginx startup blocked by macOS sandbox sysctl rule; template not validated here')
                self.assertEqual(checked.returncode, 0, checked.stderr)
                nginx = subprocess.Popen(command + ['-g', 'daemon off;'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                for _ in range(100):
                    try:
                        with socket.create_connection(('127.0.0.1', port), timeout=.1): break
                    except OSError:
                        if nginx.poll() is not None: self.fail((root/'error.log').read_text())
                        time.sleep(.02)
                context = ssl.create_default_context(cafile=str(root/'cert.pem'))
                base = f'https://127.0.0.1:{port}/quota-bridge/'

                def get(token, path='v1/session?sessionId=session-a', tls=context, origin=None):
                    headers = {'Authorization': 'Bearer ' + token} if token else {}
                    if origin: headers['Origin'] = origin
                    return urllib.request.urlopen(urllib.request.Request(base+path, headers=headers), context=tls, timeout=5)

                with get(TOKEN) as r:
                    a = json.load(r)
                    self.assertIn('no-store', r.headers['Cache-Control'])
                with get(OTHER) as r: b = json.load(r)
                self.assertNotEqual(a['accountRef'], b['accountRef'])
                self.assertEqual(a['vmId'], 'vm-a'); self.assertEqual(b['vmId'], 'vm-b')
                for token in [None, 'invalid']:
                    with self.assertRaises(urllib.error.HTTPError) as e: get(token)
                    self.assertEqual(e.exception.code, 401)
                with self.assertRaises(urllib.error.HTTPError) as e: get(TOKEN, path='health')
                self.assertEqual(e.exception.code, 404)
                with self.assertRaises(urllib.error.HTTPError) as e: get(TOKEN, origin='https://untrusted.example')
                self.assertEqual(e.exception.code, 403)
                with self.assertRaises(urllib.error.URLError): get(TOKEN, tls=ssl.create_default_context())
                self.assertEqual(upstream.server_address[0], '127.0.0.1')
                self.assertNotIn(TOKEN, (root/'error.log').read_text())
                self.assertNotIn('session-a', (root/'error.log').read_text())
            finally:
                if nginx is not None:
                    nginx.terminate()
                    try: nginx.wait(timeout=5)
                    except subprocess.TimeoutExpired: nginx.kill(); nginx.wait()
                upstream.shutdown(); upstream.server_close(); thread.join(timeout=3)
                db.close(); backend.close()


@unittest.skipUnless(shutil.which('openssl'), 'openssl is needed for a temporary test certificate')
class HttpsTransportTests(unittest.TestCase):
    def test_real_tls_backend_auth_and_scope_without_ssh(self):
        # Exercise TLS and real backend auth independently of nginx availability.
        # This does not claim validation of the nginx configuration template.
        with tempfile.TemporaryDirectory(prefix='quota-transport-') as temp:
            root = Path(temp)
            backend, db, _ = fixture(root)
            server = None
            try:
                (root/'cert.conf').write_text('[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n')
                subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                                '-config', str(root/'cert.conf'), '-keyout', str(root/'key.pem'), '-out', str(root/'cert.pem')],
                               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
                server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(backend))
                tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                tls.load_cert_chain(str(root/'cert.pem'), str(root/'key.pem'))
                server.socket = tls.wrap_socket(server.socket, server_side=True)
                thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
                trusted = ssl.create_default_context(cafile=str(root/'cert.pem'))
                url = f'https://127.0.0.1:{server.server_address[1]}/v1/session?sessionId=session-a'
                def get(token, context=trusted, origin=None):
                    headers = {'Authorization': 'Bearer ' + token} if token else {}
                    if origin: headers['Origin'] = origin
                    return urllib.request.urlopen(urllib.request.Request(url, headers=headers), context=context, timeout=5)
                with get(TOKEN) as r: a = json.load(r)
                with get(OTHER) as r: b = json.load(r)
                self.assertEqual(a['vmId'], 'vm-a'); self.assertEqual(b['vmId'], 'vm-b')
                self.assertNotEqual(a['accountRef'], b['accountRef'])
                for token in [None, 'invalid']:
                    with self.assertRaises(urllib.error.HTTPError) as e: get(token)
                    self.assertEqual(e.exception.code, 401)
                with self.assertRaises(urllib.error.HTTPError) as e: get(TOKEN, origin='https://untrusted.example')
                self.assertEqual(e.exception.code, 403)
                with self.assertRaises(urllib.error.URLError): get(TOKEN, context=ssl.create_default_context())
            finally:
                if server is not None:
                    server.shutdown(); server.server_close(); thread.join(timeout=3)
                db.close(); backend.close()

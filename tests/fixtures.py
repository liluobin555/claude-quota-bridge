import hashlib
import hmac
import json
import sqlite3
from pathlib import Path
from server.bridge import Backend

NOW = 1793100000000
TOKEN = 'sk-test-account-a-not-a-real-secret'
OTHER = 'sk-test-account-b-not-a-real-secret'


def fixture(root, clock=None):
    root = Path(root)
    secret = 'testing-hash-secret-32-characters!'
    (root/'hash').write_text(secret)
    (root/'ref').write_text('different-reference-secret-32-chars!')
    db = sqlite3.connect(root/'kin.sqlite')
    db.executescript('''
    CREATE TABLE api_keys(id TEXT PRIMARY KEY,name TEXT,key_hash TEXT,status TEXT,deleted_at TEXT,expires_at TEXT,user_id TEXT,group_type TEXT,allowed_vms TEXT,vm_pool_id TEXT);
    CREATE TABLE users(id TEXT PRIMARY KEY,status TEXT,deleted_at TEXT);
    CREATE TABLE accounts(id TEXT PRIMARY KEY,vm_id TEXT,extra TEXT,status TEXT,deleted_at TEXT);
    CREATE TABLE vms(id TEXT PRIMARY KEY,status TEXT,schedulable INTEGER);
    CREATE TABLE usage_logs(id TEXT PRIMARY KEY,created_at TEXT,api_key_id TEXT,session_id TEXT,status INTEGER,vm_id TEXT,account_id TEXT,final_account_id TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_creation_tokens INTEGER);
    CREATE TABLE sticky_sessions(key TEXT PRIMARY KEY,expires_at INTEGER,vm_id TEXT,account_id TEXT,generation INTEGER);
    CREATE TABLE vm_pools(id TEXT PRIMARY KEY,enabled INTEGER);
    CREATE TABLE vm_pool_members(pool_id TEXT,vm_id TEXT);
    ''')
    for token, kid, aid, vm in ((TOKEN, 'key-a', 'account-a', 'vm-a'), (OTHER, 'key-b', 'account-b', 'vm-b')):
        hashed = hmac.new(secret.encode(), token.encode(), hashlib.sha256).hexdigest()
        db.execute('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?,?,?,?)', (kid, kid, hashed, 'active', None, None, None, 'anthropic', json.dumps([vm]), None))
        db.execute('INSERT INTO accounts VALUES(?,?,?,?,?)', (aid, vm, extra(50), 'active', None))
        db.execute('INSERT INTO vms VALUES(?,?,?)', (vm, 'running', 1))
    db.execute('INSERT INTO usage_logs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', ('log-a', '2026-10-27T11:20:00Z', 'key-a', 'session-a', 200, 'vm-a', 'account-a', 'account-a', 20, 10, 50000, 200))
    db.execute('INSERT INTO sticky_sessions VALUES(?,?,?,?,?)', ('sess:session-a', NOW+86400000, 'vm-a', 'account-a', 1))
    db.commit()
    config = {'vm2apiDb': str(root/'kin.sqlite'), 'stateDb': str(root/'state.sqlite'),
              'hashSecretFile': str(root/'hash'), 'referenceSecretFile': str(root/'ref'),
              'verifiedSingleVmKeyIds': ['key-a', 'key-b']}
    return Backend(config, clock or (lambda: NOW)), db, config


def extra(percent, sample=NOW, reset=NOW+3600000):
    return json.dumps({'unified': {'headers': {'sampled_at': sample,
        '5h': {'utilization': percent/100, 'reset': str(reset/1000)},
        '7d': {'utilization': .3, 'reset': NOW+86400000}}}})

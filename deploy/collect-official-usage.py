"""Root-only, single verified VM collector. Calls existing usage operation, no model probes."""
import datetime as dt
import grp
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time

if os.geteuid() != 0:
    raise SystemExit('collector requires the configured system service')
cfg = json.loads(Path('/etc/claude-quota-bridge/usage-refresh.json').read_text())
vm_id, key_id = cfg['vmId'], cfg['keyId']
if not re.fullmatch(r'[A-Za-z0-9_.-]+', vm_id): raise SystemExit('invalid VM')
c = sqlite3.connect('file:/opt/vm2api/data/kin.db?mode=ro', uri=True)
c.row_factory = sqlite3.Row
key = c.execute('SELECT status,expires_at,allowed_vms FROM api_keys WHERE id=? AND deleted_at IS NULL', (key_id,)).fetchone()
accounts = c.execute("SELECT id FROM accounts WHERE vm_id=? AND status='active' AND deleted_at IS NULL", (vm_id,)).fetchall()
if not key or key['status'] != 'active' or json.loads(key['allowed_vms']) != [vm_id] or len(accounts) != 1:
    raise SystemExit('verified scope disabled or scope changed; no query performed')
if key['expires_at'] and dt.datetime.fromisoformat(key['expires_at'].replace('Z', '+00:00')).timestamp() <= time.time():
    raise SystemExit(0)
program = """
import {getVm} from './src/lib/vm/vm-registry.mjs';
import {probeVmUsage} from './src/lib/oauth/crs-usage-probe.mjs';
const vm=getVm('/opt/vm2api',VM_ID);
const r=await probeVmUsage({exec:{vmId:vm.id,vm,homeDir:'/opt/vm2api/vms/'+vm.id+'/cli-home',oauth:vm.claude},includeFable:false,timeoutMs:15000});
console.log(JSON.stringify({ok:r.ok,status:r.usage_status,via:r.via,scopeMissing:r.usage_scope_missing,five_hour:r.five_hour,seven_day:r.seven_day,probed_at:r.probed_at}));
""".replace('VM_ID', json.dumps(vm_id))
result = subprocess.run(['docker', 'exec', '-i', 'vm2api', 'node', '--input-type=module', '-'], input=program, capture_output=True, text=True, timeout=25)
try: data = json.loads(result.stdout.strip().splitlines()[-1])
except Exception: raise SystemExit('usage collector failed; previous sample left unchanged')
if result.returncode or not data.get('ok') or data.get('status') != 200 or data.get('scopeMissing'):
    raise SystemExit('usage unavailable; previous sample left unchanged')
windows = []
for key, kind in [('five_hour','five_hour'), ('seven_day','seven_day')]:
    w = data.get(key) or {}
    pct = float(w['utilization'])*100
    if not math.isfinite(pct) or not 0 <= pct <= 100: raise SystemExit('invalid quota response')
    reset = w.get('resets_at')
    reset_ms = int(dt.datetime.fromisoformat(reset.replace('Z','+00:00')).timestamp()*1000) if reset else None
    inactive = pct == 0 and reset_ms is None and w.get('status') == 'allowed'
    if reset_ms is None and not inactive: raise SystemExit('incomplete quota response')
    windows.append({'kind':kind,'percent':round(pct,6),'resetsAt':reset_ms,'inactive':inactive})
at = int(dt.datetime.fromisoformat(data['probed_at'].replace('Z','+00:00')).timestamp()*1000)
entry = {'accountId':accounts[0]['id'],'source':'slot-worker-usage','success':True,'sampledAt':at,'windows':windows}
target = Path('/var/cache/claude-quota-bridge/official-usage.json')
cache = {'version':1,'entries':{vm_id:entry}}
tmp = target.with_suffix('.tmp')
fd = os.open(tmp, os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o640)
with os.fdopen(fd,'w') as f: json.dump(cache,f)
os.chmod(tmp,0o640)
os.chown(tmp,0,grp.getgrnam('quota-bridge').gr_gid)
os.replace(tmp,target)
print(json.dumps({'ok':True,'vmId':vm_id,'sampledAt':at,'windows':windows,'modelCalls':0}))

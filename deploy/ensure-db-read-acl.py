"""Root-only fixed-path ACL repair. No DB writes, recursive grants or arguments."""
import os
from pathlib import Path
import subprocess

if os.geteuid() != 0: raise SystemExit('ACL repair requires the fixed system service')
base=Path('/opt/vm2api/data')
for name in ['kin.db','kin.db-wal','kin.db-shm']:
    p=base/name
    if not p.exists(): continue
    if p.is_symlink() or p.resolve().parent!=base.resolve(): raise SystemExit('unexpected database path')
    acl=subprocess.check_output(['/usr/bin/getfacl','-cp',str(p)],text=True)
    entry=next((line for line in acl.splitlines() if line.startswith('user:quota-bridge:')), '')
    mask=next((line.split(':')[-1] for line in acl.splitlines() if line.startswith('mask::')), '')
    if entry.split('\t')[0]!='user:quota-bridge:r--' or not mask.startswith('r'):
        subprocess.run(['/usr/bin/setfacl','-m','u:quota-bridge:r--',str(p)],check=True)

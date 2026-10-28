"""Socket-activated fixed usage command. No caller-chosen VM, path or arguments."""
import json
from pathlib import Path
import subprocess
import sys
import time

request = sys.stdin.buffer.readline(513)
try:
    if len(request)>512 or json.loads(request) != {'op':'usage'}: raise ValueError()
    path = Path('/var/cache/claude-quota-bridge/official-usage.json')
    recent = False
    if path.exists():
        entries = json.loads(path.read_text()).get('entries',{})
        recent = any(0 <= time.time()*1000-e.get('sampledAt',0) < 60000 for e in entries.values())
    if not recent:
        r = subprocess.run(['/usr/bin/python3','/opt/claude-quota-bridge/current/deploy/collect-official-usage.py'],capture_output=True,timeout=27)
        if r.returncode: raise ValueError()
    sys.stdout.write('{"ok":true}\n');sys.stdout.flush()
except Exception:
    sys.stdout.write('{"ok":false}\n');sys.stdout.flush()

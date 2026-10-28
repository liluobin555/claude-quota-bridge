#!/usr/bin/env python3
"""Heuristic public-source guard. Reports categories/locations, never matched values."""
import argparse
import ipaddress
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = {
    'provider-key': r'\bsk-(?:ant|vm)-[A-Za-z0-9_-]{20,}',
    'github-token': r'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})',
    'aws-key': r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b',
    'private-key': r'-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----',
    'credential-url': r'https?://[^\s/:]+:[^\s/@]+@',
    'personal-home': r'(?:[/]Users[/]|[A-Za-z]:[/\\]Users[/\\])[^/\\\s]+',
}
IPV4 = re.compile(r'(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])')
EMAIL = re.compile(r'(?<![\w.+-])[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+')
IGNORED = {'.git', 'node_modules', '__pycache__', 'reports', '.gray-canary', 'types'}


def inspect(name, text):
    found = []
    for n, line in enumerate(text.splitlines(), 1):
        # Deliberate invalid URL fixture; no usable credential.
        line = line.replace('https://' + 'user:pass@example.com', '')
        for kind, pattern in PATTERNS.items():
            if re.search(pattern, line): found.append((name, n, kind))
        for m in IPV4.finditer(line):
            try:
                if not ipaddress.ip_address(m.group()).is_loopback: found.append((name, n, 'non-loopback-ip'))
            except ValueError:
                pass
        for m in EMAIL.finditer(line):
            domain = m.group().rsplit('@', 1)[-1].lower()
            if m.group().lower() == 'noreply@github.com':
                continue  # GitHub's public web-flow committer address.
            if domain not in {'example.com', 'example.net', 'example.org'} and not domain.endswith('.example') and not domain.endswith('.noreply.github.com'):
                found.append((name, n, 'unexpected-email'))
    return sorted(set(found))


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--history', action='store_true', help='Also scan all reachable Git blobs and commit metadata')
    args = parser.parse_args()
    findings, count = [], 0
    for p in sorted(ROOT.rglob('*')):
        rel = p.relative_to(ROOT)
        if any(part in IGNORED for part in rel.parts) or not p.is_file(): continue
        if p.name.endswith('.local.json'): findings.append((str(rel), 1, 'local-config-file'))
        data = p.read_bytes()
        if b'\0' in data: findings.append((str(rel), 1, 'unexpected-binary')); continue
        count += 1
        findings.extend(inspect(str(rel), data.decode('utf-8', errors='replace')))
    if args.history:
        # Enumerate every reachable object, including deleted/renamed file versions.
        for row in git('rev-list', '--objects', '--all').decode().splitlines():
            oid = row.split(' ', 1)[0]
            kind = git('cat-file', '-t', oid).strip()
            if kind not in (b'blob', b'commit'): continue
            data = git('cat-file', '-p', oid)
            if b'\0' in data: findings.append((oid[:12], 1, 'binary-in-history')); continue
            findings.extend(inspect('git:'+oid[:12], data.decode('utf-8', errors='replace')))
    for name, line, kind in sorted(set(findings)):
        print(f'{name}:{line}: {kind}')
    print(f'Privacy heuristic: {count} working-tree files; {len(set(findings))} findings. Manual review still required.')
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())

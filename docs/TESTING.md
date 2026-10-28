# Testing

## Local fixtures

```sh
npm test
npm run privacy
claude plugin validate .
```

The JS tests use mock CLI processes, and the Python tests use temporary SQLite databases and loopback HTTP/TLS. They cover scope matching, account isolation, binding changes, quota freshness, same-account leases, active refresh merging, model-window changes, 50% threshold boundaries, one-shot compaction, post-compaction continuation, and supervised print-mode holds.

The optional Nginx test needs `nginx` and `openssl` and can skip where unavailable or sandbox-restricted. Do not count a skipped check as an accepted deployment.

## Native CLI smoke test

With the tested Claude Code executable available:

```sh
python3 tests/native-smoke.py --help
python3 tests/native-smoke.py --claude /path/to/claude --continue-test
```

This is opt-in. It uses a temporary Claude config, a local mock model endpoint, a fixture database and synthetic SKs. It writes ignored reports under `reports/`. Review local network restrictions and the native CLI's behavior before running it. It does not validate an actual provider's billing, limits or account status.

## Your deployment acceptance

1. Back up configuration and establish a rollback path. Keep the sidecar separate from vm2api.
2. Start with a dedicated SK confined to one verified VM and one active account, and `allowRefresh:false`.
3. Confirm that the bridge resolves only that SK's session, account and fresh quota. A different SK must not inherit the session.
4. Validate an interactive session and managed print mode, then account/binding changes and bridge-down behavior. Ensure ordinary subscription sessions remain inert.
5. Use mock quota/context thresholds for repeatable tests; do not burn provider quota to reach 85% or stress-test the usage endpoint.
6. Enable the optional usage-only helper only after checking the actual vm2api worker API, egress and refresh budget. Leave automatic recovery off.

This public export contains no private live-acceptance reports. Passing local tests is not a production deployment or an account-safety guarantee.

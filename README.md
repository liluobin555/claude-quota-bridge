# Claude Quota Bridge

An opt-in Claude Code plugin and read-only vm2api sidecar that compact a large conversation when the account approaches its quota. Supports interactive Claude Code and supervised `claude -p` without changing vm2api core code.

[中文说明](README.zh-CN.md) · [Client setup](docs/CLIENT-SETUP.md) · [Server setup](docs/SERVER-SETUP.md) · [Integration](docs/VM2API-ADOPTION.md) · [Security](SECURITY.md)

## Current behavior

- Default trigger: account 5h quota **>=85%** or 7d quota **>=90%**, and current conversation context **>=50%** of its runtime model window.
- Waits for the root turn and tracked child agents to finish. Compacts once per session/account/quota window, then permits ordinary user and agent continuation.
- Reads the context window and tokens from the running CLI on each evaluation; no fixed model-to-window lookup.
- Automatic recovery is **off**. Does not switch accounts, create keepalive model calls, or bypass provider limits.
- Separate sidecar reads vm2api SQLite in read-only mode; its leases and agent counters live in a separate state database.
- Explicit per-process activation and gateway matching keep unrelated subscription and API sessions inert.

This is experimental quota coordination, not an account safety guarantee or a scheduler pin. Stale quota, changed bindings, and failed compaction can hold managed sessions. See [failure behavior](docs/CLIENT-SETUP.md#failure-behavior).

## Compatibility

Validated during development with vm2api **v1.3.219**, Claude Code **2.1.303** on macOS, Node.js 22+, and Python 3.9+. The package minimum is Node 20.11. The Claude Code Mods API and vm2api schema are version-sensitive; validate your actual versions before enabling automatic actions. Native Windows execution is not yet acceptance-tested.

## Quick start

No npm or Python runtime dependencies are required. Install Claude Code separately, clone this repository, and run:

```sh
npm test
npm run privacy
claude plugin validate .
```

First deploy your own sidecar using [Server setup](docs/SERVER-SETUP.md). Use your existing gateway credentials through your own secure per-process configuration; do not put keys in commands, repository files, or shell history. Then launch from the repository root:

```sh
node bin/claude-quota.mjs   --gateway-url https://gateway.example/vm2api   --bridge-url https://quota.example/quota-bridge
```

The wrapper supplies `--plugin-dir` and enables the plugin only for the child process. It does not configure API authentication. Check `/quota-bridge status` in that session. Do not enable `QUOTA_BRIDGE_ENABLED` globally.

For supervised noninteractive work:

```sh
node bin/claude-quota-run.mjs   --state /secure/jobs/job.json --prompt-file /secure/jobs/task.txt   --gateway-url https://gateway.example/vm2api   --bridge-url https://quota.example/quota-bridge   -- --model YOUR_SUPPORTED_MODEL_ID
```

The `.example` hosts above are placeholders. No live deployment, API keys, account data, private test reports, or original development history are included.

## Tests and limits

`npm test` runs local fixtures, mock CLIs, SQLite authorization checks, compaction state tests, and loopback HTTPS tests. It makes no real model calls. The optional Nginx integration test skips when its platform prerequisites are unavailable. Native smoke tests are opt-in and use a temporary CLI config and local mock endpoints; see [Testing](docs/TESTING.md).

Multi-account scheduling is not modified. Automatic compaction requires a verified single-VM route, one active account, fresh quota, and a matching session binding. Child agents are tracked and new spawns can be gated; individual child compaction is not implemented. An optional fixed usage helper is a deployment adapter for a single verified slot, not a general multi-tenant management API.

Review [quota query frequency and risks](docs/QUOTA-QUERIES-AND-RISK.md) before enabling active refresh. Default examples leave active refresh disabled. Using this code does not grant permission to use or relay a provider's subscription credentials; follow applicable provider terms.

## License

MIT. The vendored quota-guard core retains its upstream license and public attribution. See [provenance](docs/PROVENANCE.md).

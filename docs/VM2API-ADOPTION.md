# vm2api adoption and upgrades

## Standalone integration

Run this repository as a sidecar. No vm2api source patch is required. Public clients reach a trusted HTTPS reverse proxy with their own vm2api SK; the backend reads the same instance's SQLite database in read-only mode. Do not give clients SSH keys, Docker access, OAuth credentials or a gateway admin token.

The current adapter targets v1.3.219 tables `api_keys`, `users`, `accounts`, `vms`, `usage_logs`, `sticky_sessions`, `vm_pools` and `vm_pool_members`, including key hashing and the stored account-usage format. It does not issue SQL migrations or writes. See `tests/fixtures.py` for the expected columns and `server/bridge.py` for the queries.

`verifiedSingleVmKeyIds` is an operator attestation: the SK is confined to one VM, that VM has one active account, and fallback routes have been checked. It is not an atomic lock in vm2api's scheduler. Multi-account/global routes stay observe-only. Successful logs and a live sticky binding are checked; historical execution alone does not authorize automatic actions. The transition from initial single-VM scope to a matching live binding is allowed; later generation changes hold.

The optional root usage helper is a fixed single-slot adapter. Configure its exact key/VM pair and audit the worker's implementation. It cannot be generalized to arbitrary tenants by accepting caller-supplied VM IDs or commands.

## Upgrading vm2api

Pin the tested vm2api and CLI versions. Before upgrading, inspect schema changes, hashing, session identity rewriting, scheduler/fallback behavior, usage units and reset timestamps. The usage helper imports internal worker modules, so it needs separate compatibility testing. Run local tests, then a dedicated test SK and one slot; do not infer compatibility from the management UI version alone.

## Optional upstream merge

This repository can be integrated without importing deployment secrets or private histories. Preserve both MIT notices. Propose isolated components: quota snapshot contract, per-account refresh provider/cache, authorization, compaction leases, then client integration.

A native vm2api implementation should resolve the actual scheduled account atomically, share the scheduler's session generation, expose only caller-scoped quota, and unify refresh budgets with its own probes. Persist provider Retry-After/backoff and negative results. Do not merely copy the sidecar's verified-key list into the scheduler or claim strict session pinning.

The current release does not implement those upstream changes. It also does not automatically discover model-window limits from vm2api: the client reads the running CLI's context API.

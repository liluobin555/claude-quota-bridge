# Server setup

This is an operator-guided sidecar deployment, not a replacement vm2api installer. The examples target Linux/systemd and the v1.3.219 adapter. Verify your actual paths, schema, key-hash algorithm, scheduler fallback and container name first. Start with one dedicated test SK restricted to one VM and one active account.

## 1. Install the read-only service

Install a clean checkout at `/opt/claude-quota-bridge/current` and create a dedicated `quota-bridge` system user. Keep the checkout owned by the administrator and not writable by that service user. Python 3.9+ is required; the bridge has no third-party Python dependencies.

Create `/etc/claude-quota-bridge` with restricted permissions and `/var/lib/claude-quota-bridge` owned by the service user (mode 0700). Copy `examples/bridge.example.json` to `/etc/claude-quota-bridge/config.json` and set:

| Field | Required operator action |
|---|---|
| `vm2apiDb` | Actual live vm2api SQLite file; service gets read access only |
| `stateDb` | Separate service-owned state database; never the vm2api database |
| `hashSecretFile` | Protected raw secret matching vm2api's SK HMAC-SHA256 key hashing |
| `referenceSecretFile` | Independent random secret, at least 32 characters |
| `verifiedSingleVmKeyIds` | Empty for observation; add only an audited single-VM test SK ID |
| `allowRefresh` | Keep false for first deployment |
| `listen`, `port` | Loopback only; default port 47824 |

Do not use the admin API token, an OAuth token, or an API key as the key-hash secret. Obtain the correct secret through your gateway's protected server configuration. Do not print or commit it. Generate the reference secret locally, for example using `openssl rand -hex 32` redirected to the protected destination. Grant the service read permission on these two files, not on other gateway credentials.

SQLite WAL mode also requires read access to the current `kin.db-wal` and `kin.db-shm`, plus directory traversal. Grant access only to those exact files. The optional ACL path/service examples maintain those fixed permissions if files are recreated; inspect them and adapt paths before enabling. Never grant recursive write access or change the database owner. Use an existing populated database and verify all expected tables before starting.

Install `deploy/claude-quota-bridge.service`, inspect its paths and systemd hardening, then run `systemctl daemon-reload` and enable/start the service. Check local `/health` and service logs. A healthy process does not prove a caller's route is verified.

## 2. Add HTTPS

Use a domain you control and a valid TLS certificate. Keep the bridge bound to loopback and firewall its port from the Internet. `deploy/caddy-quota-bridge.caddy` and `deploy/nginx-quota-bridge.conf.example` are alternative snippets to merge into an existing HTTPS server. Match the upstream port to your JSON config; the public client base is then `https://quota.example/quota-bridge`.

Before reloading the proxy, validate its configuration. Preserve existing gateway routes. Do not publish `/health`, admin routes or arbitrary helper endpoints through the public quota prefix. Do not log Authorization headers, request bodies, or session query strings; configure outer proxy access logs accordingly. Use a valid certificate rather than disabling client TLS verification.

For public deployments set the bounded `publicRateLimit` object shown in `bridge.usage-socket.example.json`, even when refresh is disabled. The proxy must overwrite the trusted client-IP header rather than accept the caller's value. Unauthorized SKs must return 401/403; browser Origin requests must be rejected. End users need only their own scoped SK, never SSH or administrator credentials.

## 3. Verify the route before automatic actions

Use a securely provided test SK to request its own `/v1/session?sessionId=...`. Check `accountRef`, `vmId`, `bindingSource`, fresh 5h/7d samples and reset times. Only after auditing single-account fallback paths add the test SK ID to `verifiedSingleVmKeyIds` and restart the bridge. `routeSafety:single_vm_attested` is an operator assertion, not a scheduler pin. A multi-account/global route remains observe-only.

Do not post the raw response or session identifier in a public issue. Test another SK cannot inherit the session. Follow the [acceptance steps](TESTING.md) before real workloads.

## 4. Optional usage-only refresh

Passive mode does not create extra official requests. If stale sampling makes it unsuitable, the fixed root helper can query an existing slot worker's usage operation. This adapter is intended for one verified slot and one key, not an arbitrary account pool.

- Inspect `deploy/collect-official-usage.py`. It uses the internal v1.3.219 `probeVmUsage` operation, container `vm2api`, paths under `/opt/vm2api`, and `includeFable:false`. Adapt and revalidate those assumptions for your installation.
- Install a root-owned `/etc/claude-quota-bridge/usage-refresh.json` from `examples/usage-refresh.example.json` with the exact allowed key and VM IDs. Never accept those IDs from a public caller.
- Create `/var/cache/claude-quota-bridge` for root to write and the bridge group to read (0750). Install and inspect the socket and instance service units. The public bridge user must not gain Docker access.
- Merge the socket, official cache, refresh allowlist and rate limits from `examples/bridge.usage-socket.example.json` into your config. Keep the same key/VM pairing across both files and add the audited key ID to `verifiedSingleVmKeyIds`.
- Start the socket, then test that `/v1/refresh` returns a new usage-only sample. The helper checks one active account and exact key scope before querying. No model probe is required.

Do not enable `allowRefresh:true` without this socket on a public deployment. The legacy admin-probe fallback in the adapter uses `credentialsFile` and can invoke gateway probing; it is not the usage-only path documented here. Do not hand it a master credential simply to suppress an error.

Review [refresh frequency and limitations](QUOTA-QUERIES-AND-RISK.md). Leave automatic recovery off. Deploying this service does not make third-party subscription intermediation permitted or safe.

## Rollback

Stop/disable the bridge and optional usage/ACL units, remove only their reverse-proxy route and validate/reload the proxy. Revert the client's explicit launcher use. Preserve service state for investigation outside the repository. No vm2api database migration or source rollback is required because this sidecar makes no vm2api writes.

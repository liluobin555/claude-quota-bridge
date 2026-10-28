# Security and privacy

This is experimental software. Use your own authorized accounts and review applicable provider terms. It does not prevent account suspension, bypass usage limits, or provide an atomic scheduler pin.

## Trust boundaries

- Client: opt-in per process and exact intended gateway matching. No global authentication edits are required.
- Public edge: valid HTTPS only, bounded request size/rate, no credentials in URLs, no Authorization/body logging. Never expose the sidecar or Docker socket publicly.
- Bridge: loopback binding, own-SK authentication, read-only vm2api database, separate state database, account references derived with a distinct HMAC secret.
- Refresh helper: optional fixed root-owned configuration and socket command; no caller-selected shell commands, paths or account IDs. Clients never receive OAuth or admin credentials.

The gateway key-hash secret is sensitive; the bridge needs a protected copy matching its gateway instance to validate SK hashes. The reference secret must be independent. Keep both out of source control and restrict the service user's access.

Passive-only mode (`allowRefresh:false`) creates no extra official usage queries from this component. Active refresh is opt-in and has known limits: provider Retry-After and failure backoff are not fully persisted end to end, and other tools/instances can query the same account independently. See [frequency and risk](docs/QUOTA-QUERIES-AND-RISK.md).

## Public-source hygiene

The public export excludes deployment credentials, personal/company identifiers, live domains and non-loopback IPs, account identities, runtime databases, local configs and private reports. Tests contain explicitly synthetic keys and loopback addresses. Reserved example hosts and required public upstream license attribution are retained.

`npm run privacy` checks common secret formats, non-loopback IP literals, personal home paths and unexpected email addresses. It is a heuristic guard, not a complete DLP system. Review every new file and all Git history before publishing; deleting a secret in a later commit does not remove it from history. Rotate accidentally disclosed credentials and follow the hosting provider's secret-removal guidance.

Please do not post secrets, private logs, account emails or transcripts in public issues. For a sensitive report, use a private reporting channel offered by the repository host, or first request one without posting the payload.

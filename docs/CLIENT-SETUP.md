# Client setup

## Scope and credentials

Use a supported Claude Code installation with Mods/module hooks. Run `claude plugin validate .` from the repository before connecting to your gateway. A successful manifest load alone does not prove the hooks work.

The interactive wrapper adds this checkout with `--plugin-dir`. No global installation or settings edit is required. The intended gateway must match the child process's actual `ANTHROPIC_BASE_URL`. The SK comes from the existing `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` environment/configuration used by that process. Use your own scoped, low-privilege test SK first. The wrapper does not obtain credentials or change subscription logins.

Use a dedicated shell or secure launcher for API credentials. Do not place SKs on the command line, in documentation, or in version control. Avoid setting `QUOTA_BRIDGE_ENABLED=1` in user-wide settings.

```sh
node bin/claude-quota.mjs --gateway-url https://gateway.example/vm2api --bridge-url https://quota.example/quota-bridge
```

The bridge uses HTTPS with certificate verification, or HTTP on loopback only. Remote plaintext HTTP, userinfo, query strings and fragments in the bridge base URL are rejected. SSH tunnels are optional local transport, not a requirement for public users. HTTPS users need their own SK and no VPS SSH key.

## Supervised print mode

Use `bin/claude-quota-run.mjs` for `-p`; do not add `-p` to the interactive wrapper. The runner owns input/output formats, session ID, plugin flags, and persistence. It sends the prompt through stdin and keeps the same CLI process alive through compaction.

```sh
node bin/claude-quota-run.mjs --state /secure/jobs/job.json --prompt-file /secure/jobs/task.txt --gateway-url https://gateway.example/vm2api --bridge-url https://quota.example/quota-bridge -- --model YOUR_SUPPORTED_MODEL_ID
```

Normal completion exits 0; a quota/identity hold exits 75 and preserves state; validation/handshake failures use 69; invalid arguments/state use 64. Inspect the state file before resuming with `--resume-state /secure/jobs/job.json` instead of `--state`. Keep the same working directory and provide the prompt file again. A stale lock may be removed only after verifying the original process has exited. Automatic recovery remains off: do not pass `--auto-resume`.

State files and CLI output may contain task/session metadata. Store them outside the repository with restrictive permissions. Never commit them.

## Defaults and overrides

| Setting | Default | Meaning |
|---|---|---|
| Plugin `threshold` | 85 | 5h quota percentage |
| Plugin `weeklyThreshold` | 90 | 7d quota percentage |
| `QUOTA_COMPACT_MIN_CONTEXT` | 50 | Inclusive context percentage |
| `QUOTA_AFTER_COMPACT` | continue | Permit normal continuation after verified compaction |
| Plugin `pollSeconds` | 30 | Read bridge snapshots, not official usage each time |
| `QUOTA_AUTO_RESUME` | 0 | No autonomous resume/model retry |
| `QUOTA_BRIDGE_URL` | loopback port 47824 | Your trusted bridge base URL |

The model window and context tokens are read from `session.usage().context` for every evaluation. After compaction the runtime may temporarily omit counters; the plugin does not assume zero. At high quota and unknown context it holds instead of guessing. Small contexts below the threshold continue and may qualify later; they are not marked as already compacted.

`/quota-bridge status` shows scope, binding, quota freshness, phase and compaction evidence. Resume is deliberate and checks fresh quota/identity again; it is not a bypass.

## Failure behavior

An installed but unenabled plugin is inert. Gateway mismatch prevents managed task input. Unmanaged plain `claude -p` does not silently receive the managed behavior; use the runner for protection.

In an opted-in session, bridge unavailability, stale quota, changed account/binding, lost lease, unknown required context, or failed compaction can block further managed prompts/agents. The runner returns a saved hold rather than silently falling back to unprotected execution. Inspect and fix the recorded reason. This does not alter other subscription sessions or their authentication.

Successful compression returns to idle and permits ordinary user/agent continuation. It does not create a keepalive or an infinite retry loop. The provider may still reject further work at its actual limit.

Children contribute to root accounting; new spawns are gated during protected operations. Child contexts are not automatically compacted. Already running children are allowed to settle before root compaction.

## Optional settings installer

`scripts/install-client.mjs` can merge the plugin directory and bridge URL into a specified settings file, preserving other fields and creating a backup. It is optional and changes the chosen file. Review with `--dry-run` first. Prefer process-local wrappers if the same computer runs subscription and API sessions. The installer does not enable quota control or configure authentication.

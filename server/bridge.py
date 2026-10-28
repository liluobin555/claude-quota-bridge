"""vm2api v1.3.219 quota bridge. stdlib only; vm2api database is always read-only."""
import argparse
import datetime as dt
import hashlib
import hmac
import json
import math
import os
import re
import socket
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
import uuid
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SERVICE_VERSION = '0.1.6'


class Denied(Exception):
    def __init__(self, code, status=403):
        self.code, self.status = code, status


class HttpRateLimiter:
    """Bounded in-memory token buckets; enabled only on the public bridge."""
    def __init__(self, config, clock=time.monotonic):
        self.cfg, self.clock = config, clock
        self.buckets, self.lock = OrderedDict(), threading.Lock()

    def accept(self, address, authorization):
        now = self.clock()
        token_ref = hashlib.sha256(authorization.encode()).hexdigest()
        specs = [('ip:' + address, self.cfg.get('ipRate', 2), self.cfg.get('ipBurst', 30)),
                 ('key:' + token_ref, self.cfg.get('keyRate', 1), self.cfg.get('keyBurst', 20))]
        with self.lock:
            values = []
            for key, rate, burst in specs:
                old, at = self.buckets.pop(key, (burst, now))
                value = min(burst, old + max(0, now-at)*rate)
                self.buckets[key] = (value, now)
                values.append((key, value))
            allowed = all(value >= 1 for _, value in values)
            if allowed:
                for key, value in values: self.buckets[key] = (value-1, now)
            while len(self.buckets) > self.cfg.get('maxBuckets', 4096): self.buckets.popitem(last=False)
            return allowed


def epoch(value):
    if value is None or value == "":
        return None
    try:
        n = float(value)
        return int(n if n > 1e12 else n * 1000) if math.isfinite(n) else None
    except (ValueError, TypeError):
        try:
            return int(dt.datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp() * 1000)
        except (ValueError, TypeError):
            return None


def agent_session(root, agent):
    if not agent:
        return root
    h = hashlib.sha256(("kin-claude-code-agent:" + root + "#" + agent).encode()).hexdigest()
    return "-".join((h[:8], h[8:12], "4" + h[13:16],
                     format((int(h[16:18], 16) & 0x3f) | 0x80, "02x") + h[18:20], h[20:32]))


def json_value(value, default):
    try:
        return json.loads(value) if value else default
    except (ValueError, TypeError):
        return default


class Backend:
    def __init__(self, config, clock=None):
        self.cfg = config
        self.clock = clock or (lambda: int(time.time() * 1000))
        self.secret = Path(config["hashSecretFile"]).read_text().strip()
        self.ref_secret = Path(config["referenceSecretFile"]).read_text().strip()
        if len(self.secret) < 16 or len(self.ref_secret) < 32:
            raise ValueError("secret files are missing or too short")
        self.lock = threading.RLock()
        self.state_path = config["stateDb"]
        source_path, target_path = Path(config["vm2apiDb"]).resolve(), Path(self.state_path).resolve()
        if source_path == target_path or (source_path.exists() and target_path.exists() and os.path.samefile(source_path, target_path)):
            raise ValueError("state database must be separate from vm2api")
        Path(self.state_path).parent.mkdir(parents=True, exist_ok=True)
        self.state = sqlite3.connect(self.state_path, check_same_thread=False)
        os.chmod(self.state_path, 0o600)
        self.state.execute("CREATE TABLE IF NOT EXISTS leases (account TEXT PRIMARY KEY, token TEXT, key_id TEXT, session TEXT, expires INTEGER)")
        self.state.execute("CREATE TABLE IF NOT EXISTS agents (key_id TEXT, root TEXT, agent TEXT, state TEXT, updated INTEGER, PRIMARY KEY(key_id,root,agent))")
        self.state.commit()
        self.refresh_times = {}
        self.refresh_inflight = {}
        self.http_limiter = HttpRateLimiter(config['publicRateLimit']) if config.get('publicRateLimit') else None

    def close(self):
        self.state.close()

    def connect(self):
        uri = Path(self.cfg["vm2apiDb"]).resolve().as_uri() + "?mode=ro"
        c = sqlite3.connect(uri, uri=True, timeout=3)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA query_only=ON")
        c.execute("BEGIN")
        return c

    def ref(self, text):
        return hmac.new(self.ref_secret.encode(), str(text).encode(), hashlib.sha256).hexdigest()[:24]

    def authenticate(self, c, token):
        if not token or len(token) > 512:
            raise Denied("invalid_credentials", 401)
        hashed = hmac.new(self.secret.encode(), token.encode(), hashlib.sha256).hexdigest()
        row = c.execute("SELECT * FROM api_keys WHERE key_hash=?", (hashed,)).fetchone()
        if not row:
            # Legacy plaintext keys are deliberately not migrated by this read-only service.
            raise Denied("invalid_credentials", 401)
        key = dict(row)
        if key.get("status") != "active" or key.get("deleted_at"):
            raise Denied("key_disabled")
        if key.get("expires_at") and (epoch(key["expires_at"]) or 0) <= self.clock():
            raise Denied("key_expired")
        if key.get("user_id"):
            user = c.execute("SELECT status,deleted_at FROM users WHERE id=?", (key["user_id"],)).fetchone()
            if not user or user["status"] != "active" or user["deleted_at"]:
                raise Denied("owner_disabled")
        return key

    def scope(self, c, key):
        if key.get("vm_pool_id"):
            pool = c.execute("SELECT enabled FROM vm_pools WHERE id=?", (key["vm_pool_id"],)).fetchone()
            return [r[0] for r in c.execute("SELECT vm_id FROM vm_pool_members WHERE pool_id=?", (key["vm_pool_id"],))] if pool and pool[0] else []
        if key.get("group_type") in ("anthropic", "claude"):
            ids = json_value(key.get("allowed_vms"), [])
            return ids if isinstance(ids, list) else []
        return None  # global scope is never treated as a single-account guarantee

    def snapshot(self, token, root, agent=""):
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,200}", str(root)) or not re.fullmatch(r"[A-Za-z0-9_.:-]{0,160}", str(agent)):
            raise Denied("invalid_session", 400)
        c = self.connect()
        try:
            key = self.authenticate(c, token)
            sid = agent_session(root, agent)
            allowed = self.scope(c, key)
            log = c.execute("SELECT * FROM usage_logs WHERE api_key_id=? AND session_id=? AND status BETWEEN 200 AND 299 ORDER BY created_at DESC,id DESC LIMIT 1", (key["id"], sid)).fetchone()
            bind = c.execute("SELECT * FROM sticky_sessions WHERE key=? AND expires_at>?", ("sess:" + sid, self.clock())).fetchone() if log else None
            source, vm_id, account_id, generation = "unbound", None, None, None
            if bind:
                source, vm_id, account_id, generation = "live_sticky", bind["vm_id"], bind["account_id"], bind["generation"]
            elif log:
                source, vm_id, account_id = "last_executed", log["vm_id"], log["final_account_id"] or log["account_id"]
            elif allowed is not None and len(allowed) == 1:
                accounts = c.execute("SELECT id FROM accounts WHERE vm_id=? AND deleted_at IS NULL AND status='active'", (allowed[0],)).fetchall()
                if len(accounts) == 1:
                    source, vm_id, account_id = "single_vm_scope", allowed[0], accounts[0][0]
            # A caller must own a historical session, or independently have single-VM authority.
            if allowed is not None and vm_id and vm_id not in allowed:
                raise Denied("scope_changed")
            account = c.execute("SELECT id,vm_id,extra,status,deleted_at FROM accounts WHERE id=?", (account_id,)).fetchone() if account_id else None
            if account and account["vm_id"] != vm_id:
                raise Denied("binding_invalid")
            unified = json_value(account["extra"], {}).get("unified", {}) if account else {}
            headers = unified.get("headers", {})
            sampled = epoch(headers.get("sampled_at"))
            # A cached probe's checked-at time is NOT evidence of a new sample.
            check, official = unified.get("last_probe_check", {}), unified.get("official", {})
            official_at = epoch(check.get("data_at"))
            quota_source = "passive_headers"
            if check.get("ok") and check.get("via") != "passive-headers" and official_at and official_at > (sampled or 0) and all(official.get(k, {}).get("utilization") is not None for k in ("5h", "7d")):
                headers, sampled, quota_source = official, official_at, "official_usage"
            windows = []
            for source_kind, kind in (("5h", "five_hour"), ("7d", "seven_day")):
                w = headers.get(source_kind, {})
                try:
                    pct = float(w["utilization"]) * 100
                except (KeyError, TypeError, ValueError):
                    continue
                if not math.isfinite(pct) or not 0 <= pct <= 100:
                    continue
                windows.append({"kind": kind, "percent": round(pct, 6), "resetsAt": epoch(w.get("reset"))})
            # Optional private cache from the separate, usage-only slot collector.
            # It never writes to vm2api or uses the panel's model-probing endpoint.
            if self.cfg.get("officialQuotaFile"):
                try:
                    cached = json.loads(Path(self.cfg["officialQuotaFile"]).read_text()).get("entries", {}).get(vm_id, {})
                    at = epoch(cached.get("sampledAt"))
                    ws = cached.get("windows", [])
                    valid = cached.get("accountId") == account_id and cached.get("source") == "slot-worker-usage" and cached.get("success") is True
                    valid = valid and len(ws) == 2 and {w.get("kind") for w in ws} == {"five_hour", "seven_day"}
                    valid = valid and all(isinstance(w.get("percent"), (int, float)) and math.isfinite(w["percent"]) and 0 <= w["percent"] <= 100 for w in ws)
                    if valid and at and at > (sampled or 0) and at <= self.clock()+5000:
                        windows, sampled, quota_source = ws, at, "official_worker_usage"
                except (OSError, ValueError, TypeError, AttributeError):
                    pass
            active_count = c.execute("SELECT COUNT(*) FROM accounts WHERE vm_id=? AND status='active' AND deleted_at IS NULL", (vm_id,)).fetchone()[0] if vm_id else 0
            # Operator attestation covers the gateway's fallback paths. This is NOT an atomic scheduler pin.
            verified = key["id"] in self.cfg.get("verifiedSingleVmKeyIds", []) and allowed == [vm_id] and active_count == 1
            vm = c.execute("SELECT status,schedulable FROM vms WHERE id=?", (vm_id,)).fetchone() if vm_id else None
            active = account and account["status"] == "active" and not account["deleted_at"] and vm and vm["schedulable"] and vm["status"] not in ("paused", "disabled", "banned", "error")
            fresh = sampled is not None and 0 <= self.clock() - sampled <= self.cfg.get("maxSampleAgeMs", 120000)
            complete = len(windows) == 2 and all((w.get("resetsAt") and w["resetsAt"] > self.clock()) or
                (quota_source == "official_worker_usage" and w.get("inactive") is True and w["percent"] == 0 and w.get("resetsAt") is None) for w in windows)
            current = source in ("live_sticky", "single_vm_scope")
            ready = bool(active and current and fresh and complete and verified)
            with self.lock:
                agents = self.state.execute("SELECT agent,state FROM agents WHERE key_id=? AND root=? AND updated>?", (key["id"], root, self.clock()-86400000)).fetchall()
            return {"version": 1, "sessionId": root, "agentId": agent or None,
                    "accountRef": self.ref(account_id) if account_id else None, "vmId": vm_id,
                    "bindingVersion": self.ref(f"{account_id}:{vm_id}:{generation}"), "bindingSource": source,
                    "sampledAt": sampled, "observedAt": self.clock(), "windows": windows, "quotaSource": quota_source,
                    "fresh": fresh, "autoReady": ready, "routeSafety": "single_vm_attested" if verified else "observe_only",
                    "schedulerPin": False, "accountActive": bool(active),
                    "agents": {"running": sum(r[1] == "start" for r in agents)},
                    "capabilities": {"refresh": bool(self.cfg.get("allowRefresh")) and
                        (not self.cfg.get("usageRefreshSocket") or key["id"] in self.cfg.get("refreshAllowedKeyIds", []) and vm_id == self.cfg.get("refreshVmId")), "childCompaction": False},
                    "_key": key["id"], "_account": account_id}
        finally:
            c.close()

    @staticmethod
    def public(snapshot):
        return {k: v for k, v in snapshot.items() if not k.startswith("_")}

    def lease(self, token, data):
        snap = self.snapshot(token, data.get("sessionId", ""))
        if not snap["autoReady"] or data.get("accountRef") != snap["accountRef"] or data.get("bindingVersion") != snap["bindingVersion"]:
            raise Denied("automation_not_ready", 409)
        kind = data.get("kind", "compact")
        if kind not in ("compact", "resume"):
            raise Denied("invalid_lease_kind", 400)
        limit = 85 if kind == "compact" else 75
        # Do not reserve compaction once fully exhausted; reserve still isn't a budget guarantee.
        if any(w["percent"] >= (98 if kind == "compact" else limit) for w in snap["windows"]):
            raise Denied("insufficient_quota", 409)
        now = self.clock()
        with self.lock:
            self.state.execute("BEGIN IMMEDIATE")
            try:
                old = self.state.execute("SELECT token,key_id,session,expires FROM leases WHERE account=?", (snap["accountRef"],)).fetchone()
                same = old and old[0] == data.get("leaseId") and old[1] == snap["_key"] and old[2] == snap["sessionId"]
                if old and old[3] > now and not same:
                    raise Denied("account_busy", 409)
                lease_id = old[0] if same else str(uuid.uuid4())
                self.state.execute("INSERT OR REPLACE INTO leases VALUES (?,?,?,?,?)", (snap["accountRef"], lease_id, snap["_key"], snap["sessionId"], now + 60000))
                self.state.commit()
                return {"leaseId": lease_id, "expiresAt": now + 60000}
            except Exception:
                self.state.rollback()
                raise

    def release(self, token, data):
        c = self.connect()
        try:
            key = self.authenticate(c, token)
        finally:
            c.close()
        with self.lock:
            self.state.execute("DELETE FROM leases WHERE token=? AND key_id=? AND session=?", (data.get("leaseId"), key["id"], data.get("sessionId")))
            self.state.commit()
        return {"ok": True}

    def agent_event(self, token, data):
        root, agent = data.get("sessionId", ""), data.get("agentId", "")
        snap = self.snapshot(token, root)
        if not agent or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", agent) or data.get("event") not in ("start", "stop"):
            raise Denied("invalid_agent_event", 400)
        with self.lock:
            self.state.execute("INSERT OR REPLACE INTO agents VALUES (?,?,?,?,?)", (snap["_key"], root, agent, data["event"], self.clock()))
            self.state.commit()
        return {"ok": True}

    def stats(self, token, root):
        snap = self.snapshot(token, root)
        c = self.connect()
        try:
            with self.lock:
                agents = self.state.execute("SELECT agent,state FROM agents WHERE key_id=? AND root=?", (snap["_key"], root)).fetchall()
            result = []
            for agent, state in agents:
                sid = agent_session(root, agent)
                row = c.execute("SELECT COUNT(*),COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0),COALESCE(SUM(cache_read_tokens),0),COALESCE(SUM(cache_creation_tokens),0) FROM usage_logs WHERE api_key_id=? AND session_id=?", (snap["_key"], sid)).fetchone()
                result.append({"agentId": agent, "state": state, "requests": row[0], "inputTokens": row[1], "outputTokens": row[2], "cacheReadTokens": row[3], "cacheCreationTokens": row[4]})
            return {"sessionId": root, "agents": result, "note": "Recorded lifecycle agents only; quota percentage remains account-wide, not additive per agent."}
        finally:
            c.close()

    def refresh(self, token, data):
        snap = self.snapshot(token, data.get("sessionId", ""))
        if self.cfg.get("usageRefreshSocket"):
            if not self.cfg.get("allowRefresh") or snap["_key"] not in self.cfg.get("refreshAllowedKeyIds", []) or snap["vmId"] != self.cfg.get("refreshVmId"):
                raise Denied("refresh_disabled", 409)
            with self.lock:
                last = self.refresh_times.get(snap["accountRef"], 0)
                event = self.refresh_inflight.get(snap["accountRef"])
                owner = event is None and self.clock()-last >= 60000
                if owner:
                    event = threading.Event()
                    self.refresh_inflight[snap["accountRef"]] = event
                    self.refresh_times[snap["accountRef"]] = self.clock()
                elif event is None:
                    # Another caller may have completed after our initial read.
                    updated = self.snapshot(token, data["sessionId"])
                    if updated["fresh"]: return self.public(updated)
                    raise Denied("refresh_throttled", 429)
            if not owner:
                # Share the fixed usage operation; never launch another probe or
                # treat its normal cooldown as an account/model failure.
                if not event.wait(29): raise Denied("quota_refresh_failed", 502)
                updated = self.snapshot(token, data["sessionId"])
                if not updated["fresh"]: raise Denied("quota_refresh_no_fresh_sample", 502)
                return self.public(updated)
            try:
                try:
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
                        peer.settimeout(28)
                        peer.connect(self.cfg["usageRefreshSocket"])
                        peer.sendall(b'{"op":"usage"}\n')
                        raw = b''
                        while b'\n' not in raw and len(raw) < 4096:
                            chunk = peer.recv(1024)
                            if not chunk: break
                            raw += chunk
                    if json.loads(raw).get("ok") is not True: raise ValueError('usage unavailable')
                except Exception:
                    raise Denied("quota_refresh_failed", 502)
                updated = self.snapshot(token, data["sessionId"])
                if not updated["fresh"]:
                    raise Denied("quota_refresh_no_fresh_sample", 502)
                return self.public(updated)
            finally:
                with self.lock:
                    self.refresh_inflight.pop(snap["accountRef"], None)
                    event.set()
        if not self.cfg.get("allowRefresh") or not snap.get("vmId") or snap["routeSafety"] != "single_vm_attested":
            raise Denied("refresh_disabled", 409)
        with self.lock:
            last = self.refresh_times.get(snap["accountRef"], 0)
            if self.clock() - last < 60000:
                raise Denied("refresh_throttled", 429)
            self.refresh_times[snap["accountRef"]] = self.clock()
        # Loopback ONLY; no caller-chosen URL, VM, or upstream credentials.
        master = json.loads(Path(self.cfg["credentialsFile"]).read_text())["master_api_key"]
        url = "http://127.0.0.1:8787/admin/vms/" + urllib.parse.quote(snap["vmId"], safe="") + "/probe"
        request = urllib.request.Request(url, data=b'{"hop":true}', headers={"Authorization": "Bearer " + master, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                response.read(1024 * 1024)
        except Exception:
            raise Denied("quota_refresh_failed", 502)
        return self.public(self.snapshot(token, data["sessionId"]))


def handler_for(backend):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # No URL/session/token access log.

        def reply(self, status, data):
            body = json.dumps(data, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            if status == 429: self.send_header("Retry-After", "5")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self.dispatch()

        def do_POST(self):
            self.dispatch()

        def dispatch(self):
            try:
                if backend.http_limiter:
                    # Only Caddy's loopback upstream can supply this header; its
                    # config overwrites any external client-supplied value.
                    address = self.headers.get('X-Quota-Client-IP', self.client_address[0])
                    if not backend.http_limiter.accept(address, self.headers.get('Authorization', '')):
                        raise Denied('rate_limited', 429)
                if self.headers.get("Origin"):
                    raise Denied("browser_origin_forbidden")
                path = urllib.parse.urlsplit(self.path)
                if self.command == "GET" and path.path == "/health":
                    return self.reply(200, {"service": "claude-quota-bridge", "version": SERVICE_VERSION})
                authorization = self.headers.get("Authorization", "")
                if not authorization.startswith("Bearer "):
                    raise Denied("invalid_credentials", 401)
                token = authorization[7:]
                query = urllib.parse.parse_qs(path.query)
                if self.command == "GET" and path.path == "/v1/session":
                    return self.reply(200, backend.public(backend.snapshot(token, query.get("sessionId", [""])[0], query.get("agentId", [""])[0])))
                if self.command == "GET" and path.path == "/v1/agents":
                    return self.reply(200, backend.stats(token, query.get("sessionId", [""])[0]))
                size = int(self.headers.get("Content-Length", "0"))
                if size < 0 or size > 8192:
                    raise Denied("body_too_large", 413)
                if self.command != "POST" or path.path not in ("/v1/lease", "/v1/release", "/v1/agent-event", "/v1/refresh"):
                    raise Denied("not_found", 404)
                data = json.loads(self.rfile.read(size))
                if not isinstance(data, dict):
                    raise Denied("invalid_body", 400)
                action = {"/v1/lease": backend.lease, "/v1/release": backend.release, "/v1/agent-event": backend.agent_event, "/v1/refresh": backend.refresh}[path.path]
                return self.reply(200, action(token, data))
            except Denied as error:
                self.reply(error.status, {"error": error.code})
            except (ValueError, TypeError, UnicodeError):
                self.reply(400, {"error": "invalid_request"})
            except Exception:
                self.reply(503, {"error": "bridge_unavailable"})
    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    if config.get("listen", "127.0.0.1") != "127.0.0.1":
        raise ValueError("bind loopback only; use SSH or a trusted HTTPS reverse proxy")
    backend = Backend(config)
    server = ThreadingHTTPServer(("127.0.0.1", config.get("port", 47824)), handler_for(backend))
    server.daemon_threads = True
    try:
        server.serve_forever()
    finally:
        server.server_close()
        backend.close()


if __name__ == "__main__":
    main()

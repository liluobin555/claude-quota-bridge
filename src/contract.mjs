export function trustedBridgeUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('invalid_bridge_url');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('https_or_loopback_required');
  return url.href.replace(/\/$/, '');
}

// The first response establishes a live generation for a previously unused
// session. This single transition is safe only within the attested account/VM.
export function isBootstrapBinding(previous, next) {
  return previous?.bindingSource === 'single_vm_scope' && next?.bindingSource === 'live_sticky' &&
    previous.routeSafety === 'single_vm_attested' && next.routeSafety === 'single_vm_attested' &&
    next.autoReady === true && previous.accountRef === next.accountRef && !!previous.accountRef &&
    previous.vmId === next.vmId && !!previous.vmId && previous.sessionId === next.sessionId && !!previous.sessionId;
}

export function inspectSnapshot(s, {sessionId, now, accountRef, maxAgeMs = 120000}) {
  if (!s || s.version !== 1 || s.sessionId !== sessionId) return {reason: 'session_mismatch'};
  if (accountRef && accountRef !== s.accountRef) return {reason: 'account_changed'};
  if (!s.accountRef) return {reason: 'unbound'};
  if (!Number.isFinite(s.sampledAt) || s.sampledAt > now + 5000 || now - s.sampledAt > maxAgeMs) return {reason: 'quota_stale'};
  if (!['live_sticky', 'single_vm_scope'].includes(s.bindingSource)) return {reason: 'binding_unknown'};
  if (!s.accountActive) return {reason: 'account_inactive'};
  if (!Array.isArray(s.windows) || ['five_hour', 'seven_day'].some(k => !s.windows.some(w => w.kind === k))) return {reason: 'quota_incomplete'};
  if (s.windows.some(w => !Number.isFinite(w.percent) || w.percent < 0 || w.percent > 100 ||
    !(s.quotaSource === 'official_worker_usage' && w.inactive === true && w.percent === 0 && w.resetsAt === null) &&
    (!Number.isFinite(w.resetsAt) || w.resetsAt <= now))) return {reason: 'reset_unverified'};
  return {usage: {windows: s.windows}, automation: s.autoReady === true && s.routeSafety === 'single_vm_attested', reason: s.autoReady ? undefined : 'observe_only'};
}

export function createClient({baseUrl, token, fetcher}) {
  const base = trustedBridgeUrl(baseUrl);
  if (!token) throw new Error('missing_gateway_key');
  return async (path, body) => {
    const r = await fetcher(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {authorization: `Bearer ${token}`, ...(body === undefined ? {} : {'content-type': 'application/json'})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}), redirect: 'error',
    });
    const result = typeof r.text === 'function' ? await r.text() : r.text;
    let data;
    try { data = JSON.parse(result); } catch { throw new Error('invalid_bridge_response'); }
    if (r.status < 200 || r.status >= 300) throw new Error(data.error || 'bridge_unavailable');
    return data;
  };
}

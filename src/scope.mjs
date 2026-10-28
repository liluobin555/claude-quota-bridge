// A loaded plugin is inert unless this particular process explicitly opts in.
// Never infer subscription/API mode from the presence of a leftover key alone.
export function canonicalGateway(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return undefined;
    if (['anthropic.com', 'claude.ai', 'claude.com'].some(d => url.hostname === d || url.hostname.endsWith('.' + d))) return undefined;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) return undefined;
    return url.origin + (url.pathname.replace(/\/+$/, '') || '');
  } catch { return undefined; }
}

export function activation({enabled, expectedGateway, actualGateway}) {
  if (enabled !== '1') return {active: false, reason: 'not_opted_in'};
  const expected = canonicalGateway(expectedGateway), actual = canonicalGateway(actualGateway);
  if (!expected) return {active: false, reason: 'gateway_not_configured'};
  if (!actual || actual !== expected) return {active: false, reason: 'gateway_not_matched'};
  return {active: true};
}

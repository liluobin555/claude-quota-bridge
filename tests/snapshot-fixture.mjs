export function snapshot(pct = 50) {
  const T = 1793100000000;
  return {version: 1, sessionId: 'session-a', vmId: 'vm-a', accountRef: 'account-ref-a', bindingVersion: 'v1', bindingSource: 'live_sticky', routeSafety: 'single_vm_attested', accountActive: true, autoReady: true, sampledAt: T,
    windows: [{kind: 'five_hour', percent: pct, resetsAt: T+3600000}, {kind: 'seven_day', percent: 30, resetsAt: T+86400000}]};
}

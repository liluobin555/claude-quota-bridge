export async function compactVerified(host, instructions) {
  const before = await host.context();
  if (!Number.isFinite(before?.tokens) || before.tokens <= 0) return {ok: false, detail: 'unknown_context'};
  let route = 'direct';
  let reply;
  try {
    reply = await host.direct(instructions);
  } catch (error) {
    if (!/not available in a headless|\(-p \/ SDK\)|unsupported/i.test(String(error.message))) return {ok: false, detail: 'direct_compaction_failed'};
    route = 'command';
    try { reply = await host.command(instructions); }
    catch { return {ok: false, unsupported: true, detail: 'command_compaction_unavailable', route}; }
  }
  if (reply?.skip || reply?.deny) return {ok: false, detail: 'compaction_vetoed', route};
  let after = await host.context();
  let evidence = await host.observed() || Array.isArray(reply?.messages) && reply.messages.length > 0;
  const waitBudgetMs = Math.min(120000, Math.max(30000, Math.ceil(before.tokens / 100000) * 30000));
  // command.run may acknowledge enqueueing before the command runs. Wait for actual
  // completion evidence, but never manufacture success from a timeout or silence.
  for (let waited = 0; !evidence && !(Number.isFinite(after?.tokens) && after.tokens < before.tokens * 0.7) && host.sleep && waited < waitBudgetMs; waited += 250) {
    await host.sleep(250);
    evidence = await host.observed();
    after = await host.context();
  }
  // Silence, a queued command, or a textual "compacted" reply is not sufficient.
  if (!evidence && !(Number.isFinite(after?.tokens) && after.tokens < before.tokens * 0.7)) return {ok: false, detail: 'compaction_not_observed', route};
  const shrank = Number.isFinite(after?.tokens) && after.tokens < before.tokens * 0.7;
  return {ok: true, route, evidence: shrank ? 'measured_shrink' : 'engine_compaction_completion',
    tokensBefore: before.tokens, tokensAfter: shrank ? after.tokens : undefined};
}

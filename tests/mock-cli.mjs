// Process fixture: exercises real pipes, loopback auth and runner lifecycle, no models.
const args = process.argv.slice(2);
if(args[0]==='plugin'&&args[1]==='validate')process.exit(process.env.QUOTA_MOCK_MODE==='invalid-plugin'?1:0);
const sessionId = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
const mode = process.env.QUOTA_MOCK_MODE || 'normal';
let done = false;
const interval = setInterval(() => {}, 1000);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
async function event(value) {
  const r = await fetch(process.env.QUOTA_RUNNER_URL + '/event', {method: 'POST', headers: {authorization: 'Bearer ' + process.env.QUOTA_RUNNER_TOKEN}, body: JSON.stringify({sessionId, phase: 'idle', ...value})});
  if (!r.ok) throw new Error('event refused');
}
process.stdin.on('end', () => {clearInterval(interval); process.exit(0);});
process.stdin.on('data', async bytes => {
  if (done) return; done = true;
  const input = JSON.parse(bytes.toString().trim());
  if (input.session_id !== sessionId) process.exit(2);
  if (mode === 'no-handshake') {emit({type: 'result', subtype: 'success'}); return;}
  await event({ready: true, busy: true});
  if (mode === 'early-exit') process.exit(0);
  if (mode === 'bridge-down') {await event({hold: 'bridge_unavailable', busy: false}); return;}
  if (mode === 'https-continue') {
    if (process.env.QUOTA_BRIDGE_URL !== 'https://quota.example/quota-bridge') process.exit(3);
    await event({phase: 'compacting', busy: false});
    await new Promise(resolve => setTimeout(resolve, 600));
    emit({type: 'system', subtype: 'compact_boundary', session_id: sessionId});
    await event({phase: 'idle', busy: false, compaction: {ok: true}});
    emit({type: 'result', subtype: 'success'});
    return;
  }
  emit({type: 'result', subtype: 'success'});
  if (mode === 'command') {
    emit({type:'command_lifecycle',command_uuid:'compact-test',state:'started'});
    await event({phase:'idle',busy:false});
    await new Promise(resolve=>setTimeout(resolve,700));
    emit({type:'command_lifecycle',command_uuid:'compact-test',state:'completed'});
    emit({type:'result',subtype:'success',local_command:'compact'});
  }
  if (mode === 'unsupported') {await event({phase: 'paused', hold: 'compaction_unsupported', busy: false}); return;}
  if (mode === 'pause' || mode === 'resume') {
    await event({phase: 'paused', compaction: {ok: true}, busy: false});
    if (mode === 'pause') return;
    await new Promise(resolve => setTimeout(resolve, 600));
    await event({phase: 'resuming', busy: true, compaction: {ok: true}});
    emit({type: 'result', subtype: 'success'});
  }
  await event({phase: 'idle', busy: false});
});

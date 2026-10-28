import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/controller.mjs';
import {snapshot} from './snapshot-fixture.mjs';
const T=1793100000000;
const compact=effects=>effects.filter(x=>x.t==='compact').length;

test('50 percent follows the runtime model window, not a hard-coded million-token window',()=>{
 for(const window of [128000,200000,1000000,2000000]){
  const c=new Controller({sessionId:'session-a'});
  c.ingest(snapshot(85),{window,tokens:window*.49,percent:49},T);
  assert.equal(c.state.rec.phase,'idle');
  assert.equal(compact(c.ingest(snapshot(85),{window,tokens:window*.5,percent:50},T)),1);
  assert.equal(c.view().context.window,window);
 }
});
test('a model switch before the first compaction uses its new percentage immediately',()=>{
 const c=new Controller({sessionId:'session-a'});
 assert.equal(compact(c.ingest(snapshot(85),{window:1000000,tokens:100000,percent:10},T)),0);
 assert.equal(compact(c.ingest(snapshot(85),{window:200000,tokens:100000,percent:50},T)),1);
 assert.equal(c.view().context.window,200000);
});
test('model changes after a successful compaction do not bypass same-window deduplication',()=>{
 const c=new Controller({sessionId:'session-a'});
 c.ingest(snapshot(85),{window:1000000,tokens:500000,percent:50},T);c.compactDone({ok:true,now:T});
 assert.equal(compact(c.ingest(snapshot(95),{window:200000,tokens:160000,percent:80},T)),0);
 assert.equal(c.blocksPrompts(),false);assert.equal(c.blocksNewAgents(),false);
});
test('unknown post-switch usage is exposed as unknown and not replaced by old tokens',()=>{
 const c=new Controller({sessionId:'session-a'});
 c.ingest(snapshot(50),{window:1000000,tokens:490000,percent:49},T);
 c.ingest(snapshot(85),{window:200000},T);
 assert.equal(c.hold,'unknown_context');assert.equal(c.view().context.tokens,undefined);
 assert.equal(c.view().context.window,200000);
});

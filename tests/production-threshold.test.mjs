import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/controller.mjs';
import {snapshot} from './snapshot-fixture.mjs';
import {compactVerified} from '../src/compaction.mjs';
const T=1793100000000;
const ctx=tokens=>({tokens,window:1000000,percent:tokens/10000});
for(const tokens of [100000,200000,490000,500000,510000,700000]){
 test('production 5h threshold 84.99 → 85 at '+tokens+' tokens',()=>{
  const c=new Controller({sessionId:'session-a'});
  assert.equal(c.config.threshold,85);assert.equal(c.config.weeklyThreshold,90);assert.equal(c.config.compactMinContext,50);assert.equal(c.autoResume,false);
  assert.equal(c.ingest(snapshot(84.99),ctx(tokens),T).some(x=>x.t==='compact'),false);
  assert.equal(c.state.rec.phase,'idle');
  const fx=c.ingest(snapshot(85),ctx(tokens),T);
  assert.equal(fx.filter(x=>x.t==='compact').length,tokens>=500000?1:0);
  if(tokens<500000)assert.equal(c.state.rec.phase,'idle');
  else{
   c.compactDone({ok:true,now:T+1});assert.equal(c.state.rec.phase,'idle');
   assert.deepEqual(c.ingest(snapshot(86),ctx(1000),T+1),[]);
  }
  assert.equal(c.blocksPrompts(),false);assert.equal(c.blocksNewAgents(),false);
 });
}
test('production 7d boundary is 90 percent, independent of 5h',()=>{
 for(const [weekly,expected]of[[89.99,0],[90,1]]){
  const c=new Controller({sessionId:'session-a'}),s=snapshot(20);s.windows[1].percent=weekly;
  assert.equal(c.ingest(s,ctx(500000),T).filter(x=>x.t==='compact').length,expected);
 }
});
test('legacy pause policy retains the emergency boundary for an owned active turn',()=>{
 const c=new Controller({sessionId:'session-a',config:{afterCompact:'pause'}});c.dispatch({type:'turnStart',turnId:'fixture-owned'});
 const fx=c.ingest(snapshot(95),ctx(700000),T);
 assert.ok(fx.some(x=>x.t==='abort'));assert.equal(c.state.rec.phase,'armed');
 assert.ok(c.dispatch({type:'turnComplete',now:T,reason:'answer',turnId:'fixture-owned'}).some(x=>x.t==='compact'));
});
test('large context alone at low real quota never causes quota compaction',()=>{
 const c=new Controller({sessionId:'session-a'});
 assert.deepEqual(c.ingest(snapshot(2),ctx(700000),T),[]);
 assert.equal(c.state.rec.phase,'idle');
});
test('high-water stale or changed-account evidence cannot start compaction',()=>{
 for(const change of [{sampledAt:T-121000},{accountActive:false},{autoReady:false,routeSafety:'observe_only'}]){
  const c=new Controller({sessionId:'session-a'});
  assert.equal(c.ingest({...snapshot(85),...change},ctx(700000),T).some(x=>x.t==='compact'),false);
 }
 const c=new Controller({sessionId:'session-a'});c.ingest(snapshot(2),ctx(700000),T);
 assert.deepEqual(c.ingest({...snapshot(85),accountRef:'foreign'},ctx(700000),T),[]);
});
test('long command compaction waits for a 45s completion without upstream traffic',async()=>{
 let elapsed=0;
 const r=await compactVerified({context:async()=>({tokens:elapsed>=45000?1500:215000}),direct:async()=>{throw new Error('unsupported')},
  command:async()=>({}),observed:async()=>elapsed>=45000,sleep:async ms=>{elapsed+=ms}},'Preserve recovery information.');
 assert.equal(r.ok,true);assert.equal(elapsed,45000);
});
test('long context still fails closed when bounded completion evidence never arrives',async()=>{
 let elapsed=0;
 const r=await compactVerified({context:async()=>({tokens:215000}),direct:async()=>{throw new Error('unsupported')},
  command:async()=>({}),observed:async()=>false,sleep:async ms=>{elapsed+=ms}},'Preserve recovery information.');
 assert.equal(r.ok,false);assert.equal(r.detail,'compaction_not_observed');assert.equal(elapsed,90000);
});
test('700K completion wait remains capped at two minutes',async()=>{
 let elapsed=0;
 const r=await compactVerified({context:async()=>({tokens:700000}),direct:async()=>{throw new Error('unsupported')},
  command:async()=>({}),observed:async()=>false,sleep:async ms=>{elapsed+=ms}},'Preserve recovery information.');
 assert.equal(r.ok,false);assert.equal(elapsed,120000);
});

import { db } from './helpers/sqlite.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { validatePms, ingestPms, totals, revenueView, scenario, bkkDay } from '../src/revenue.js';
import { operatorView, followup, approveDecision, updateDecision, evidenceId } from '../src/operator.js';
import { groundAnswer, context } from '../src/copilot.js';
const now = new Date('2026-10-23T17:00:00Z');
const meta = (id='a', as_of='2026-10-20') => ({id:id.repeat(64),source_sha256:id.repeat(64),as_of,currency:null,
  scope:'property',source:'opera_history_forecast',precision:'source_report',projection_semantics:'pms_report_projection_not_rms_demand_forecast'});
const row = (stay_date='2026-11-01', rooms=50) => ({stay_date,kind:'pms_projection',inventory:100,rooms_sold:rooms,room_revenue:rooms*1000,reported_adr:1000,reported_occupancy:rooms});
const payload = () => ({schema_version:1,snapshot:meta(),rows:[row()]});
test('strict PMS schema rejects PII, invalid dates, booleans, duplicate scopes and future actuals',()=>{
  assert.deepEqual(validatePms(payload(),'2026-10-23'),[]);
  for(const change of [p=>p.rows[0].guest_name='bad',p=>p.snapshot.guest_list=[],p=>p.rows[0].stay_date='2026-02-30',p=>p.rows[0].rooms_sold=true,p=>p.rows.push({...p.rows[0]}),p=>p.rows[0].inventory=0,p=>p.snapshot.as_of='2026-12-01',p=>p.rows[0].kind='actual',p=>p.rows[0].room_revenue=Infinity,p=>delete p.rows[0].inventory,p=>p.snapshot.currency='']){const p=payload();change(p);assert.ok(validatePms(p,'2026-10-23').length);}
});
test('weighted KPIs use sums; missing inputs and zero denominators never become zero',()=>{
  const t=totals([{inventory:100,rooms_sold:10,room_revenue:1000},{inventory:200,rooms_sold:100,room_revenue:20000}]);
  assert.equal(t.adr,21000/110);assert.equal(t.occupancy,110/300*100);assert.equal(t.revpar,70);
  assert.equal(totals([{inventory:null,rooms_sold:10,room_revenue:1000}]).occupancy,null);
  assert.equal(totals([{inventory:100,rooms_sold:0,room_revenue:0}]).adr,null);assert.equal(totals([]).room_revenue,null);
});
test('re-uploading July reports in October cannot make them current or convert projections to actuals',()=>{
  const s={...meta('a','2026-07-28'),received_at:'2026-10-23T12:00:00Z'};
  const v=revenueView([s],[{...row('2026-10-01'),snapshot_id:s.id}],'2026-10-23');
  assert.equal(v.status,'stale');assert.equal(v.age_days,87);assert.equal(v.days[0].kind,'pms_projection');assert.equal(v.days[0].projection_change,null);assert.equal(v.source.currency,null);assert.equal(revenueView().status,'missing');
});
test('same-date report changes require strictly older comparable snapshot; same-day reimports and actual corrections are not pickup',()=>{
  const a={...meta('a','2026-10-23'),received_at:'2026-10-23T12:00:00Z'},b={...meta('b','2026-10-22'),received_at:'2026-10-22T12:00:00Z'};
  const rows=[{...row('2026-11-01',60),snapshot_id:a.id},{...row('2026-11-01',50),snapshot_id:b.id}];
  assert.equal(revenueView([b,a],rows,'2026-10-23').days[0].projection_change,10);
  assert.equal(revenueView([a,{...b,as_of:a.as_of}],rows,'2026-10-23').days[0].projection_change,null);
  assert.equal(revenueView([a,{...b,currency:'THB'}],rows,'2026-10-23').days[0].projection_change,null);
  assert.equal(revenueView([a,b],rows.map(r=>({...r,kind:'actual'})),'2026-10-23').days[0].projection_change,null);
});
test('real SQL schema, immutable PMS ingestion, API auth, PII rejection and end-to-end state',async()=>{
  const DB=db(),env={DB,OTA_INGEST_TOKEN:'token'},body=payload();
  assert.equal((await ingestPms(DB,body)).duplicate,false);assert.equal((await ingestPms(DB,body)).duplicate,true);
  assert.equal((await DB.prepare('select count(*) as n from pms_daily').first()).n,1);
  const req=(auth,p)=>new Request('https://x/api/pms',{method:'POST',headers:{Authorization:auth},body:JSON.stringify(p)});
  assert.equal((await worker.fetch(req('',body),env)).status,401);
  assert.equal((await worker.fetch(req('Bearer token',{...body,guest_name:'bad'}),env)).status,400);
  assert.equal((await worker.fetch(req('Bearer token',body),env)).status,200);
  const s=await(await worker.fetch(new Request('https://x/api/state',{headers:{Authorization:'Bearer token'}}),env)).json();
  assert.equal(s.revenue.days.length,1);assert.ok(s.operator.cards.length);DB.close();
});
test('what-if arithmetic is bounded and explicit, not an elasticity forecast',()=>{
  const s=scenario({inventory:100,rooms:50,adr:1000,rate_change:10,room_change:-5,commission:15});
  assert.equal(s.before_revenue,50000);assert.equal(s.after_revenue,49500);assert.equal(s.delta,-500);assert.equal(s.net_after,42075);assert.equal(s.break_even_rooms,50000/1100);assert.match(s.disclaimer,/不是需求预测/);
  assert.equal(scenario({inventory:100,rooms:50,adr:1000,rate_change:-100}).break_even_rooms,null);
  for(const inventory of [NaN,'100',null])assert.throws(()=>scenario({inventory,rooms:50,adr:1000}));
  assert.throws(()=>scenario({inventory:100,rooms:90,adr:1000,room_change:11}));
});
const m={platform:'booking',metric:'click_rate',period:'funnel',day:'2026-10-23',value:2,benchmark:3,unit:'%',label:'点击率',page:'analytics'};
const state=()=>({metrics:[m],revenue:{status:'missing'},monitor:{alerts:[{id:'gap:click',title:'点击率低',metric:'booking|click_rate@funnel',owner:'市场/内容'}]}});
test('operator facts bind real evidence and stale source dates force investigation gates',()=>{
  const o=operatorView(state(),[],'2026-10-23');assert.equal(o.cards[1].kind,'investigation');assert.equal(o.cards[1].baseline.value,2);assert.deepEqual(o.cards[1].evidence_ids,[evidenceId(m)]);
  assert.equal(operatorView(state(),[],'2026-10-25').cards[1].kind,'data_gate');
});
test('confirmed investigation != execution; baseline freeze, idempotency and event audit',async()=>{
  const DB=db(),s=state();s.operator=operatorView(s,[],'2026-10-23');const first=await approveDecision(DB,{source_ref:'gap:click'},s,now);
  assert.equal((await approveDecision(DB,{source_ref:'gap:click'},s,now)).duplicate,true);
  const d=await DB.prepare('select * from operator_decisions where id=?').bind(first.id).first();assert.equal(JSON.parse(d.baseline).value,2);assert.equal(d.status,'investigating');
  await assert.rejects(()=>updateDecision(DB,first.id,{status:'reviewed',note:'没有执行'},now));
  await assert.rejects(()=>updateDecision(DB,first.id,{status:'reported',note:'好'},now));
  await updateDecision(DB,first.id,{status:'reported',note:'人工核对首图和来源样本'},now);
  await assert.rejects(()=>updateDecision(DB,first.id,{status:'reviewed',note:'宣称完成'},now),/可比新采样/);
  assert.equal((await DB.prepare('select count(*) as n from operator_events').first()).n,2);DB.close();
});
test('effect observation needs post-action same platform, period and unit; delta is not causality',()=>{
  const d={baseline:JSON.stringify(m),status:'reported',updated_at:'2026-10-24T01:00:00Z'};
  assert.equal(followup(d,[{...m,day:'2026-10-24',value:3}],'2026-10-25').status,'awaiting_data');
  for(const wrong of [{period:'last_30_days'},{platform:'agoda'},{unit:'ratio'}])assert.equal(followup(d,[{...m,...wrong,day:'2026-10-25'}],'2026-10-25').status,'awaiting_data');
  const f=followup(d,[{...m,day:'2026-10-25',value:2.5}],'2026-10-25');assert.equal(f.delta,.5);assert.match(f.message,/不代表.*因果/);
});
test('Copilot firewall rejects invented evidence, absent references and executable pricing; PMS time reaches prompt',()=>{
  const live={...m,day:bkkDay()},id=evidenceId(live),s={operator:{evidence:[{...live,id}]}},a={title:'核对首图',detail:'查看后台样本',evidence_ids:[id]};
  assert.equal(groundAnswer({actions:[a]},s).actions.length,1);
  assert.equal(groundAnswer({actions:[{...a,evidence_ids:['invented']}]},s).actions.length,0);
  assert.equal(groundAnswer({actions:[{...a,title:'涨价 10%'}]},s).actions.length,0);
  assert.equal(groundAnswer({actions:[{title:'核对首图'}]},s).actions.length,0);
  assert.match(context({...state(),operator:operatorView(state()),revenue:{status:'stale',source:{as_of:'2026-07-28'},months:[],gaps:[]}},{}),/2026-07-28/);
});
test('hotel source and action dates honor Bangkok midnight',()=>assert.equal(bkkDay(now),'2026-10-24'));

test('new same-period post-action evidence permits a human review; action day and events survive closure',async()=>{
  const DB=db(),s=state();s.operator=operatorView(s,[],'2026-10-23');
  const {id}=await approveDecision(DB,{source_ref:'gap:click'},s,now);
  await updateDecision(DB,id,{status:'reported',note:'已人工修正首页说明'},now);
  await DB.prepare(`insert into metrics (day, platform, metric, period, label, value, unit, run_id, page)
    values ('2026-10-25','booking','click_rate','funnel','点击率',2.5,'%', 'synthetic-test','analytics')`).run();
  const reviewTime=new Date('2026-10-27T12:00:00Z');
  await updateDecision(DB,id,{status:'reviewed',note:'新采样提升 0.5 个百分点，暂不做因果结论'},reviewTime);
  const record=await DB.prepare('select * from operator_decisions where id=?').bind(id).first();
  assert.equal(record.status,'reviewed');assert.equal(record.action_at,now.toISOString());
  const f=followup(record,[{...m,day:'2026-10-25',value:2.5}],'2026-10-27');assert.equal(f.status,'observed');assert.equal(f.delta,.5);
  assert.equal((await DB.prepare('select count(*) as n from operator_events where decision_id=?').bind(id).first()).n,3);DB.close();
});

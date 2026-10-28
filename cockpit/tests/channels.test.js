import {test} from 'node:test';
import assert from 'node:assert/strict';
import {channelView,windowLabel} from '../src/channels.js';
import {operatorView,approveDecision} from '../src/operator.js';
import {db} from './helpers/sqlite.js';
import worker,{validateIngest} from '../src/worker.js';
import {followup} from '../src/operator.js';
import {context} from '../src/copilot.js';
const day='2026-10-24';
const m=(platform,metric,value,period,page='traffic',extra={})=>({platform,metric,value,period,page,day,unit:'',label:metric,run_id:'20261024-160000',...extra});
test('complete native funnels align stages without mixing windows, days, pages or capture runs',()=>{
 const rows=[m('booking','search_views',1000,'last_90_days','rank90'),m('booking','page_visits',40,'last_90_days','rank90'),m('booking','bookings',4,'funnel','rank'),
 m('ctrip','search_views',100,'last_30_days'),m('ctrip','page_visits',50,'last_30_days'),m('ctrip','bookings',2,'last_30_days'),m('ctrip','click_rate',50,'last_30_days','traffic',{unit:'%'})];
 const v=channelView(rows,[],day),b=v.funnels.find(x=>x.platform==='booking'),c=v.funnels.find(x=>x.platform==='ctrip');
 assert.equal(b.fields.bookings,null);assert.equal(b.complete,false);assert.equal(c.complete,true);assert.equal(c.fields.bookings.value,2);assert.match(c.window,/30/);
 const wrong=structuredClone(rows);wrong[5].run_id='other';
 assert.equal(channelView(wrong,[],day).funnels.find(x=>x.platform==='ctrip').complete,false);
});
test('ranks never fill counts; missing Expedia remains missing; zero is valid and stale evidence stays dated',()=>{
 const rows=[m('agoda','unique_visitors_rank_30d',1,'last_30_days','dashboard'),m('ctrip','bookings',0,'last_30_days','traffic',{day:'2026-10-20'})];
 const v=channelView(rows,[{platform:'expedia',page:'data-insights',status:'error',detail:'loading failed'}],day);
 assert.equal(v.funnels[2].fields.visits,undefined);assert.equal(v.funnels[2].ranks[0].value,1);
 assert.equal(v.funnels[3].fields.visits,null);assert.equal(v.funnels[3].unavailable[0].status,'error');
 assert.equal(v.funnels[1].fields.bookings.value,0);assert.equal(v.funnels[1].fields.bookings.stale,true);
 assert.equal(windowLabel('dates_2026-09-24_2026-10-23'),'2026-09-24 至 2026-10-23');
});
test('OTB never borrows historic revenue or combines different captures; pace cohort is separate',()=>{
 const rows=[m('ctrip','otb_room_nights_30d',140,'next_30_days','performance',{benchmark:246.9}),m('ctrip','otb_revenue_30d',500,'last_30_days','performance'),
 m('booking','otb_room_nights_30d',100,'next_30_days','analytics'),m('booking','otb_adr_30d',900,'next_30_days','other'),m('booking','pace_room_nights_30d',90,'booked_last_30_days','pace')];
 const v=channelView(rows,[],day),booking=v.future[0].channels[0],ctrip=v.future[0].channels.find(x=>x.platform==='ctrip');
 assert.equal(ctrip.fields.revenue,null);assert.equal(ctrip.fields.rooms.value,140);assert.equal(booking.fields.adr,null);assert.equal(booking.pace.value,90);
 assert.equal(v.future[1].channels.find(x=>x.platform==='ctrip').fields.rooms,null);assert.equal(v.investigations.length,1);
});
test('channel investigations use frozen source evidence and existing idempotent approval/audit, never OTA actions',async()=>{
 const metrics=[m('agoda','bookings_lost_30d',22,'next_30_days','lost-bookings'),m('ctrip','lost_bookings_14d',62,'last_14_days','lost-bookings')];
 const channels=channelView(metrics,[],day),state={metrics,channels,revenue:{status:'current'},monitor:{alerts:[]}};
 state.operator=operatorView(state,[],day);assert.equal(state.operator.cards.length,2);
 const DB=db(),body={source_ref:'channel:ctrip:lost'};
 const a=await approveDecision(DB,body,state,new Date(day));const b=await approveDecision(DB,body,state,new Date(day));
 assert.equal(b.duplicate,true);const record=await DB.prepare('select * from operator_decisions where id=?').bind(a.id).first();
 assert.equal(JSON.parse(record.baseline).value,62);assert.equal(record.status,'investigating');
 assert.equal((await DB.prepare('select count(*) n from operator_events').first()).n,1);DB.close();
});
test('platform cutoff survives SQL/API, becomes stale and never leaks across a later capture; per-page status persists',async t=>{
 // /api/state reads the clock; pin it to the fixture day so the test does not expire.
 t.mock.timers.enable({apis:['Date'],now:Date.parse(day+'T16:30:00Z')});
 const DB=db(),env={DB,OTA_INGEST_TOKEN:'test'};
 const data=m('booking','availability_for_search',95.65,'last_30_days','search-rank-30d',{unit:'%',source_as_of:'2026-10-20',source_date_basis:'page_data_as_of'});
 const body={run:{id:'20261024-160000',started_at:day},pages:[{platform:'booking',page:'search-rank-30d',status:'ok'}],metrics:[data]};
 const send=p=>worker.fetch(new Request('https://x/api/ingest',{method:'POST',headers:{Authorization:'Bearer test'},body:JSON.stringify(p)}),env);
 assert.equal((await send(body)).status,200);
 const state=()=>worker.fetch(new Request('https://x/api/state',{headers:{Authorization:'Bearer test'}}),env).then(r=>r.json());
 let s=await state();assert.equal(s.metrics[0].source_as_of,'2026-10-20');assert.equal(s.channels.loss_metrics[0].stale,true);
 const newer={run:{id:'20261024-170000',started_at:day},pages:[{platform:'booking',page:'other',status:'error'}],metrics:[{...data,source_as_of:null}]};
 await send(newer);s=await state();assert.equal(s.metrics[0].source_as_of,null);assert.equal(s.pages.length,2);
 for(const invalid of [{source_as_of:'2026-12-01'},{source_as_of:'2026-02-30'},{source_date_basis:'guessed'}])assert.ok(validateIngest({...body,metrics:[{...data,...invalid}]}).errors.length);
 const d={baseline:{...data},status:'reported',updated_at:'2026-10-25T00:00:00Z'};
 assert.equal(followup(d,[{...data,day:'2026-10-27'}],'2026-10-28').status,'awaiting_data');
 DB.close();
});
test('channel context strips redundant UI payload while preserving selected-date and source evidence',()=>{
 const metrics=[m('ctrip','bookings',133,'last_30_days','traffic',{data_context:{redundant:'x'.repeat(30000)}})];
 const channels=channelView(metrics,[],day);
 const prompt=context({metrics,channels,selected_stay_date:'2026-07-27',revenue:{status:'stale',source:{as_of:'2026-07-28'},days:[{stay_date:'2026-07-27',kind:'actual'}]}});
 assert.ok(prompt.includes('用户正在查看的入住日期'));assert.ok(prompt.includes('ota:ctrip:bookings:last_30_days:2026-10-24'));
 assert.ok(prompt.length<12000);assert.ok(!prompt.includes('xxxxxxxxxxxx'));
});

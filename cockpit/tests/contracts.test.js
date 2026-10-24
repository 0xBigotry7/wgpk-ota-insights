import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occupancyBand, metricContext, stayContext, organizeAlerts } from '../src/contracts.js';
import { revenueView } from '../src/revenue.js';
import { context } from '../src/copilot.js';
test('fixed occupancy bands distinguish missing/zero/boundaries/over100 and never use month maxima',()=>{
  for (const x of [null,undefined,NaN,Infinity,-1,'50']) assert.equal(occupancyBand(x),null);
  for (const [x,b] of [[0,0],[3.7,0],[9.8,0],[10,0],[10.01,1],[14.5,1],[20,1],[20.01,2],[30,2],[30.01,3],[40,3],[40.01,4],[50,4],[90,8],[90.01,9],[100,9],[100.01,10]]) assert.equal(occupancyBand(x),b);
  const source={id:'s',source:'opera_history_forecast',as_of:'2026-10-24',currency:null};
  const rows=['2026-10-24','2026-11-01'].map(stay_date=>({snapshot_id:'s',stay_date,kind:'pms_projection',inventory:100,rooms_sold:50,room_revenue:50000}));
  rows.push({...rows[0],stay_date:'2026-10-25',rooms_sold:99});
  const v=revenueView([source],rows,'2026-10-24');assert.equal(v.days[0].occupancy_band,v.days[2].occupancy_band);
});
test('date contract keeps observed date, selected stay date and reporting window independent; unknown bases stay unknown',()=>{
  const m={day:'2026-10-24',period:'last_30_days',unit:'%',benchmark:8};
  assert.equal(metricContext(m).stay_date,null);assert.equal(metricContext(m).currency,null);assert.equal(metricContext(m).reporting_window,'last_30_days');
  assert.equal(stayContext(null,'2026-11-01').stay_date,null);assert.equal(stayContext(null).source_date_basis,null);
  const revenue={source:{id:'july',as_of:'2026-07-28',received_at:'2026-10-24',currency:null},status:'stale',days:[{stay_date:'2026-11-01',kind:'pms_projection'}]};
  const c=stayContext(revenue,'2026-11-01');assert.equal(c.source_as_of,'2026-07-28');assert.equal(c.received_at,'2026-10-24');assert.equal(c.freshness,'stale');assert.equal(c.value_kind,'pms_projection');assert.equal(c.inventory_basis,'reported_inventory_unverified');
  assert.equal(stayContext(revenue,'2026-11-02').stay_date,null);
  const prompt=context({revenue,selected_stay_date:'2026-11-01',metrics:[{...m,platform:'booking',metric:'click_rate',label:'点击率',value:2}]});
  assert.match(prompt,/入住日与OTA统计窗口严格分开/);assert.match(prompt,/last_30_days/);assert.match(prompt,/不属于选中入住日/);
  assert.match(context({metrics:[{platform:"booking",metric:"adr_30d",day:"2026-10-24",value:1}]}),/未标注（待核实）/);
});
test('inbox collapses exact issues, preserves different scopes and prioritizes data quality independently of business score',()=>{
  const a={id:'gap:click',metric:'booking|click@last_30_days',platform:'booking',area:'traffic',level:'critical'};
  const d={id:'page:booking',platform:'booking',area:'data',level:'warning'};
  const v=organizeAlerts([a,{...a},d,{...a,metric:'booking|click@last_month'},{...a,platform:'agoda'},{...a,stay_date:'2026-11-01'},{id:'notice',platform:'all',level:'info'}]);
  assert.equal(v.inbox.total,6);assert.equal(v.alerts[0].category,'data_exception');assert.equal(v.inbox.groups.find(g=>g.id==='information').count,1);
  assert.equal(organizeAlerts([{...d,level:'info'},d]).alerts[0].level,'warning');
  const many=organizeAlerts(Array.from({length:30},(_,i)=>({...a,id:'gap:'+i})));
  assert.equal(many.alerts.length,20);assert.equal(many.inbox.total,30);assert.equal(many.inbox.truncated,10);
});

// OTA-native operating lenses. No model, inferred bookings, cross-channel totals or OTA writes.
import {bkkDay} from './revenue.js';
import {evidenceId} from './operator.js';
const NAMES={booking:'Booking.com',agoda:'Agoda',expedia:'Expedia',ctrip:'携程 / Trip.com'};
const number=m=>m && Number.isFinite(m.value) ? m : null;
const newest=rows=>[...rows].sort((a,b)=>b.day.localeCompare(a.day)||(b.run_id||'').localeCompare(a.run_id||''))[0]||null;
const sameCapture=(a,b)=>a.day===b.day && a.page===b.page && (a.run_id||'')===(b.run_id||'');
const fresh=(m,today)=>m ? Math.max(0,(Date.parse(today)-Date.parse(m.source_as_of||m.day))/864e5) : null;
export function windowLabel(period) {
  if(/^dates_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/.test(period))return period.slice(6,16)+' 至 '+period.slice(17);
  return {last_14_days:'近14天',last_30_days:'近30天',last_90_days:'近90天',last_28_days:'近28天',next_30_days:'未来30天',next_90_days:'未来90天',funnel:'排名看板默认窗口（范围未确认）',native_window:'页面原生窗口（范围未确认）',booked_last_30_days:'近30天预订的未来住宿',booked_last_90_days:'近90天预订的未来住宿'}[period]||period||'范围未确认';
}
export function channelView(metrics=[],pages=[],today=bkkDay()) {
  const find=(platform,key,period)=>newest(metrics.filter(m=>m.platform===platform && m.metric===key && (period===undefined||m.period===period)));
  const datum=m=>number(m) ? {...m,evidence_id:evidenceId(m),age_days:fresh(m,today),stale:m.day>today||fresh(m,today)>1}:null;
  function funnel(platform, specs, note) {
    const candidates=specs.map(spec=>{
      const available=metrics.filter(m=>m.platform===platform && Object.values(spec.fields).includes(m.metric)
        && (spec.period ? m.period===spec.period : /^(last_30_days|dates_|native_window)/.test(m.period)));
      const anchor=newest(available);
      const get=key=>datum(anchor ? newest(available.filter(m=>m.metric===key && m.period===anchor.period && sameCapture(m,anchor))):null);
      return {anchor,period:anchor?.period||spec.period||'native_window',fields:Object.fromEntries(Object.entries(spec.fields).map(([stage,key])=>[stage,get(key)]))};
    });
    // Fresh capture first; explicit-window candidate wins ties over unknown defaults.
    const chosen=candidates.sort((a,b)=>(b.anchor?.day||'').localeCompare(a.anchor?.day||''))[0]||{period:'',fields:{}};
    const pageStatus=pages.filter(p=>p.platform===platform);
    const unavailable=pageStatus.filter(p=>p.status!=='ok').map(p=>({page:p.page,status:p.status,detail:p.detail}));
    return {platform,name:NAMES[platform],...chosen,anchor:undefined,observed_on:chosen.anchor?.day||null,
      stage_labels:platform==='ctrip'?['列表页浏览','详情页浏览','订单']:['搜索曝光','房源页访问','预订'],
      window:platform==='agoda'?'近30天竞品排名（非数量）':windowLabel(chosen.period),note,unavailable,
      ranks:platform==='agoda'?['search_results_rank_30d','unique_visitors_rank_30d','bookings_rank_30d'].map(k=>datum(find(platform,k,'last_30_days'))).filter(Boolean):[],
      complete:['exposure','visits','bookings'].every(k=>chosen.fields[k])};
  }
  const stages={exposure:'search_views',visits:'page_visits',bookings:'bookings',click_rate:'click_rate',book_rate:'book_rate'};
  const funnels=[
    funnel('booking',[{period:'last_30_days',fields:stages},{period:'last_90_days',fields:stages},{period:'funnel',fields:stages}], '访问与预订按平台原生定义；平台数据截止日另列，不与其他渠道直接排名。'),
    funnel('ctrip',[{fields:{...stages,overall_rate:'overall_conversion'}}], '列表页/详情页为浏览量，不当作去重访客；订单不是间夜。'),
    funnel('agoda',[], '已核到搜索结果、独立访客、预订的竞品排名；排名不是数量，尚未核到完整绝对量漏斗。'),
    funnel('expedia',[{period:'last_28_days',fields:{visits:'page_views_28d',platform_rate:'conversion_rate_28d'}}], '平台转化率分母待核；不会用间夜倒推订单或补曝光。'),
  ];
  const investigations=[];
  function issue(id,platform,m,title,hypothesis,plan,verify) {
    if(!m)return;
    const stale=datum(m).stale;
    investigations.push({id,platform,title,owner:'收益/销售',kind:stale?'data_gate':'investigation',
      facts:[`${m.day} · ${m.label} ${m.value}${m.unit||''} · ${windowLabel(m.period)}${m.benchmark!=null?` · 平台对比值 ${m.benchmark}${m.unit||''}`:''}`],
      hypothesis:stale?'旧采样，仅作历史线索；先恢复该页采集。':hypothesis,
      plan:stale?`先恢复 ${NAMES[platform]} ${m.page} 数据，再按同口径调查。`:plan,
      verify,baseline:{...m,id:evidenceId(m)},evidence_ids:[evidenceId(m)]});
  }
  const lost=find('agoda','bookings_lost_30d','next_30_days');
  if(lost?.value>0)issue('channel:agoda:lost','agoda',lost,'Agoda · 流失到竞品的预订',
    '流失是平台观察信号，尚不能归因于缺房、价格或取消政策。',
    '打开 Lost booking insights，核对流失对应入住日、房型和竞品；对照同条件可售、价格和取消政策，人工记录原因与动作。',
    '执行后采集同口径流失信号；滚动窗口变化不等于挽回订单或因果收益。');
  const ctripLost=find('ctrip','lost_bookings_14d','last_14_days');
  if(ctripLost?.value>0)issue('channel:ctrip:lost','ctrip',ctripLost,'携程 · 流出到其他酒店的订单',
    '流出不是取消，流入与流出也不能简单相减当净新增或挽回订单。',
    '打开流失和流入页，核查共同浏览率、流失酒店与预订条件；再定位可售、价格、内容或政策差异，不自动添加竞品或改价。',
    '记录人工排查和动作；后续按同14日窗口复查流入、流出与转化，不宣称因果收益。');
  const availability=find('booking','availability_for_search','last_30_days')||find('booking','availability_for_search','funnel');
  if(availability && availability.value<100)issue('channel:booking:availability','booking',availability,'Booking · 搜索可售率调查',
    '搜索可售率不是酒店入住率，也不是今天库存；需核查用户搜索条件下的房量与限制。',
    '打开排名看板核对搜索可售率，再查受影响入住日、连住限制、关房和房型；不预设应该开房或降价。',
    '人工记录受影响条件，后续同口径复查可售率及预订表现，不直接改OTA库存。');
  const conversion=find('ctrip','diagnostic_book_rate_30d','last_30_days');
  if(conversion && conversion.benchmark!=null && conversion.value<conversion.benchmark)issue('channel:ctrip:conversion','ctrip',conversion,'携程 · 下单环节流失调查',
    '下单转化落后竞争圈是调查线索，不能直接认定价格过高。',
    '核对流量分析诊断的竞争圈与日期；再核含税价、房型内容、取消政策、支付和库存条件，记录人工排查结果。',
    '确认实际动作后复查同窗口转化及流量构成；不自动声称增收。');
  const future=[30,90].map(horizon=>({horizon,channels:['booking','ctrip','agoda','expedia'].map(platform=>{
    const period=`next_${horizon}_days`;
    const rooms=find(platform,`otb_room_nights_${horizon}d`,period);
    const fields={rooms:datum(rooms)};
    for(const [key,metric] of Object.entries({revenue:`otb_revenue_${horizon}d`,adr:`otb_adr_${horizon}d`})){
      const m=find(platform,metric,period);fields[key]=datum(rooms&&m&&!sameCapture(m,rooms)?null:m);
    }
    // Booking pace is a different booking-date cohort, never combined into OTB.
    const pace=find(platform,`pace_room_nights_${horizon}d`,`booked_last_${horizon}_days`);
    return {platform,name:NAMES[platform],period,window:windowLabel(period),fields,pace:datum(pace),
      note:platform==='ctrip'?'来自业绩页明确的未来30日已预订间夜诊断；不拿预订日期口径销售额补未来收入。'
        :'在手订单不是需求预测；新增未来预订与未来入住窗口分开，不算相邻滚动窗差值。'};
  })}));
  const futureWeak=find('ctrip','otb_room_nights_30d','next_30_days');
  if(futureWeak && futureWeak.benchmark!=null && futureWeak.value<futureWeak.benchmark)issue('channel:ctrip:forward','ctrip',futureWeak,'携程 · 未来30天在手间夜偏弱',
    '竞争圈平均间夜不是本酒店目标入住率；规模、可售和需求不同也会造成差距。',
    '核对未来入住日的渠道可售与产品条件，再查预订提前期、取消和客群；先确定弱日期与可执行方案。',
    '记录人工动作后看同口径在手表现，区分窗口平移、取消和新增预订；不称为净pickup。');
  const loss_metrics=[datum(lost),datum(availability),...['lost_bookings_14d','won_bookings_14d','lost_room_nights_14d','won_room_nights_14d'].map(k=>datum(find('ctrip',k,'last_14_days')))].filter(Boolean);
  return {funnels,investigations,future,loss_metrics,
    boundaries:['同屏是并排诊断，不是统一口径排行榜；不同窗口/UV/PV/订单定义不横比高低。',
      '缺值保留缺值；不把排名当流量，不用转化率反推未提供的订单，不汇总跨渠道访客。',
      '只读平台数据；所有价格、库存、促销操作由人核准并在原系统执行。']};
}

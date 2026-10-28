/* Stay-month pace vs same time last year, and daily pickup between our snapshots. Read-only view. */
(() => {
  const $=id=>document.getElementById(id);
  const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const n=(v,d=0)=>Number.isFinite(v)?v.toLocaleString('en-US',{maximumFractionDigits:d}):'—';
  const signed=v=>Number.isFinite(v)?`${v>0?'+':''}${n(v)}`:'—';
  const tone=v=>!Number.isFinite(v)?'':v<=-10?'bad':v>=10?'good':'flat';
  const chip=(x,w)=>x?`<span class="pace-chip ${x.value<0?'bad':x.value>0?'good':''}" title="${e(x.from)} → ${e(x.to)}">${w} ${signed(x.value)}</span>`:`<span class="pace-chip muted" title="还没有更早的采样可比">${w} —</span>`;
  const gapTxt=v=>Number.isFinite(v)?`${v>0?'+':''}${v.toFixed(0)}%`:'—';
  function month(m,max,otb){
    const w=v=>Number.isFinite(v)&&max>0?Math.max(2,v/max*100):0;
    const b90=m.booked_90d,b30=m.booked_30d;
    const bar=otb?`<span class="now ${tone(m.gap)}" style="width:${w(m.room_nights)}%"></span>${Number.isFinite(m.room_nights_ly)?`<span class="ly" style="left:${w(m.room_nights_ly)}%"></span>`:''}`
      :`<span class="now soft" style="width:${w(b90?.room_nights)}%"></span><span class="now" style="width:${w(b30?.room_nights)}%"></span>`;
    const aria=otb?`${m.label}在手 ${n(m.room_nights)} 间夜，去年同期 ${n(m.room_nights_ly)}`:`${m.label}近 90 天新订 ${n(b90?.room_nights)} 间夜，其中近 30 天 ${n(b30?.room_nights)}`;
    const num=otb?`<b>${n(m.room_nights)}</b><small>去年 ${n(m.room_nights_ly)}</small><span class="pace-gap ${tone(m.gap)}">${gapTxt(m.gap)}</span>`
      :`<b>${n(b90?.room_nights)}</b><small>近30天 ${n(b30?.room_nights)}</small>`;
    const rate=b90&&Number.isFinite(b90.adr)?`<small>新订房价 vs 同类</small><b>${n(b90.adr)}</b><small>同类 ${n(b90.adr_comp)} · <span class="pace-gap ${Number.isFinite(b90.adr_gap)&&b90.adr_gap<=-10?'warn':''}">${gapTxt(b90.adr_gap)}</span></small>`
      :`<small>在手 ADR</small><b>${n(m.adr)}</b>${Number.isFinite(m.adr_ly)?`<small>去年 ${n(m.adr_ly)} · ${gapTxt(m.adr_gap)}</small>`:''}`;
    return `<div class="pace-row ${otb?'':'nopu'}">
      <div class="pace-m"><b>${e(m.label)}</b><small>${e(m.month.slice(0,4))}</small></div>
      <div class="pace-bar" role="img" aria-label="${e(aria)}">${bar}</div>
      <div class="pace-num">${num}</div>
      <div class="pace-adr">${rate}</div>
      ${otb?`<div class="pace-pu">${chip(m.pickup_1d,'昨日')}${chip(m.pickup_7d,'7天')}</div>`:''}</div>`;
  }
  function heat(p){
    const rows=p.platforms.flatMap(x=>x.months.filter(m=>m.daily).map(m=>({name:x.name,m})));
    if(!rows.length)return '<div class="empty">接入“各入住月一共在手多少”后，这里按天显示每个入住月的新增。近 30/90 天新订是滚动窗口，两天相减不算新增，所以不画。</div>';
    const peak=Math.max(1,...rows.flatMap(r=>r.m.daily.map(d=>Math.abs(d.value||0))));
    const cell=d=>{
      if(!Number.isFinite(d.value))return `<td class="none" title="${e(d.day)} 没有可比采样"></td>`;
      const a=Math.min(1,Math.abs(d.value)/peak), c=d.value<0?'var(--crit)':'var(--good)';
      return `<td title="${e(d.from)} → ${e(d.day)}：${signed(d.value)} 间夜" style="background:color-mix(in srgb, ${c} ${Math.round(12+a*70)}%, var(--surface))">${d.value?signed(d.value):'0'}</td>`;
    };
    return `<div class="pace-heat-wrap"><table class="pace-heat"><colgroup><col class="h">${p.sample_days.map(()=>'<col>').join('')}</colgroup>
      <thead><tr><th>入住月 \\ 采样日</th>${p.sample_days.map(d=>`<th>${e(d.slice(5))}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r=>`<tr><th>${e(r.name)} ${e(r.m.label)}</th>${r.m.daily.map(cell).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  const STATUS={late:['已晚','bad'],urgent:['今天开始准备','bad'],soon:['两周内准备','warn'],later:['还早',''],now:['进行中','good']};
  function events(plan){
    if(!plan||!plan.events.length)return '';
    const today=plan.today, span=Math.max(120,...plan.events.map(x=>x.days_to_start+10));
    const d0=Date.parse(today), pos=d=>Math.max(0,Math.min(100,(Date.parse(d)-d0)/864e5/span*100));
    const ticks=[];for(let i=0;i<=span;i+=1){const d=new Date(d0+i*864e5).toISOString().slice(0,10);if(d.endsWith('-01')&&i/span>.05)ticks.push(d);}
    return `<h3 class="pace-h3">客源市场假期 · OTA 活动最晚上线日</h3><p class="meta">${e(plan.note)}${plan.peer_window!=null?`。Booking 上我们的客人平均提前 ${n(plan.our_window)} 天订，同类酒店 ${n(plan.peer_window)} 天（${e(plan.window_day)}）`:''}</p>
      <div class="card ev-card"><div class="ev-axis"><span></span><div class="ev-track">${ticks.map(t=>`<i style="left:${pos(t)}%">${+t.slice(5,7)}月</i>`).join('')}<b class="ev-today" style="left:0">今天</b></div><span></span></div>
      ${plan.events.map(x=>{const [word,cls]=STATUS[x.status];return `<div class="ev-row">
        <div class="ev-name"><b>${e(x.name)}</b><small>${e(x.markets.join('、'))}${x.approx?' · 日期待官方':''}</small></div>
        <div class="ev-track" role="img" aria-label="${e(x.name)}：${e(x.setup_by)} 开始准备，${e(x.live_by)} 活动上线，${e(x.start)} 至 ${e(x.end)} 假期">
          <span class="ev-prep" style="left:${pos(x.setup_by)}%;width:${pos(x.live_by)-pos(x.setup_by)}%"></span>
          <span class="ev-sell" style="left:${pos(x.live_by)}%;width:${pos(x.start)-pos(x.live_by)}%"></span>
          <span class="ev-stay" style="left:${pos(x.start)}%;width:${Math.max(.8,pos(x.end)-pos(x.start))}%"></span>
          <em style="left:${pos(x.live_by)}%">${e(x.live_by.slice(5))} 上线</em></div>
        <div class="ev-st"><span class="pace-chip ${cls}">${word}</span></div></div>`;}).join('')}
      <div class="pace-legend ev-legend"><span><i class="sw ev-prep"></i>准备活动</span><span><i class="sw ev-sell"></i>客人订房期（活动在线）</span><span><i class="sw ev-stay"></i>假期入住</span></div></div>`;
  }
  function render(state){
    const p=state.pace;
    const ev=state.events?events({...state.events,today:state.events.today||new Date(Date.now()+7*3600e3).toISOString().slice(0,10)}):'';
    if(!p||!p.platforms.length){$('pace-body').innerHTML='<div class="empty">正在接入 Booking 等平台的 pace 报表；下一次每日采集后，这里会按入住月显示在手、去年同期和每日新增。</div>'+ev;return;}
    const cards=p.platforms.map(x=>{
      const otb=x.months.some(m=>Number.isFinite(m.room_nights));
      const ms=otb?x.months.filter(m=>Number.isFinite(m.room_nights)):x.months;
      const max=Math.max(1,...ms.flatMap(m=>otb?[m.room_nights,m.room_nights_ly]:[m.booked_90d?.room_nights]).filter(Number.isFinite));
      const m0=ms[0],asof=m0.source_as_of;
      return `<article class="card pace-card"><div class="sec-h"><h3>${e(x.name)} · ${otb?'各入住月在手':'近 90 天新订，按入住月'}</h3><span class="pill tail">采样 ${e(m0.day)}${asof?` · 数据截至 ${e(asof)}`:''}</span></div>
        <div class="pace-legend">${otb?'<span><i class="sw now"></i>今年在手</span><span><i class="sw ly"></i>去年同期</span>':'<span><i class="sw now"></i>近 30 天新订</span><span><i class="sw now soft"></i>近 90 天新订</span>'}</div>
        ${ms.map(m=>month(m,max,otb)).join('')}</article>`;
    }).join('');
    $('pace-body').innerHTML=`<p class="meta">${e(p.note)}</p>
      <div class="pace-cards">${cards}</div>
      ${ev}<h3 class="pace-h3">每日新增（同一入住月，相邻两次采样之差）</h3>${heat(p)}`;
  }
  window.PaceUI={render};
})();

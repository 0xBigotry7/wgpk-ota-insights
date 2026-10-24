/* Evidence-first operator workspace. No OTA network calls; only this cockpit's authenticated API. */
(() => {
  const $ = id => document.getElementById(id);
  const e = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const n = (v, precision = 0) => Number.isFinite(v) ? v.toLocaleString('en-US', {maximumFractionDigits: precision}) : '—';
  const kind = k => k === 'actual' ? '实绩' : 'PMS 未来值';
  let state, refresh, notify, month = '', metric = 'occupancy', selected = '';
  const api = async (path, body) => {
    const r = await fetch(path, {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    const j = await r.json(); if (!r.ok) throw new Error(j.error || '保存失败'); return j;
  };
  const money = v => `${n(v, 2)}${state.revenue?.source?.currency ? ' '+state.revenue.source.currency : '（币种未确认）'}`;
  function render(data, reload, toast) {
    state = data; refresh = reload; notify = toast;
    const r = state.revenue || {status:'missing', days:[], months:[]};
    const months = [...new Set(r.days.map(d => d.stay_date.slice(0,7)))];
    const today = new Date(Date.now()+7*3600e3).toISOString().slice(0,10);
    if (!months.includes(month)) month = months.includes(today.slice(0,7)) ? today.slice(0,7) : months.at(-1) || '';
    $('revenue-source').innerHTML = r.source ? `<div class="source-banner ${r.status === 'current' ? '' : 'old'}"><div><b>${r.status === 'current' ? '来源日期正常' : '历史档案 · 不用于今日调价'}</b><br>OPERA History & Forecast · ${r.source.as_of_basis === 'actual_projection_business_cutoff' ? '报表业务分界日' : '报表导出'} <strong>${e(r.source.as_of)}</strong> · 距今 ${n(r.age_days)} 天</div><div class="meta">入库 ${e(r.source.received_at?.slice(0,10))}<br>${r.source.precision === 'legacy_rounded' ? '旧解析结果有四舍五入' : '原报表精度'}${r.source.as_of_basis === 'actual_projection_business_cutoff' ? ' · 日期依据为实绩／未来分界，非导出时间' : ''} · ${e(r.source.currency || '币种待核验')}</div></div>` : '<div class="empty">尚未导入经营报表。PMS 入住／退房同步仍是独立链路，不在这里当成房费收入。</div>';
    if (r.feed) $('revenue-source').insertAdjacentHTML('beforeend', `<p class="meta">自动接收桥：${e(r.feed.status === 'current' ? '已更新' : r.feed.status === 'waiting_for_new_report' ? '等待新的 OPERA 经营日报' : r.feed.status === 'needs_review' ? '报告需人工核验' : r.feed.status)} · 最近检查 ${e(r.feed.last_poll_at?.slice(0,16).replace('T',' '))} UTC · 归档最后收件 ${e(r.feed.last_archive_received_at?.slice(0,10)||'无')}。每 30 分钟检查；不改变原始报表日期。</p>`);
    $('revenue-month').innerHTML = months.map(m => `<option ${m===month?'selected':''}>${e(m)}</option>`).join('');
    $('revenue-month').onchange = ev => { month = ev.target.value; selected = ''; render(state, refresh, notify); };
    $('revenue-metric').value = metric;
    $('revenue-metric').onchange = ev => { metric = ev.target.value; render(state, refresh, notify); };
    const inMonth = r.days.filter(d => d.stay_date.startsWith(month));
    if (!inMonth.some(d => d.stay_date === selected)) selected = inMonth[0]?.stay_date || '';
    $('revenue-totals').innerHTML = (r.months || []).filter(m => m.month === month).map(m => `<div class="rev-summary"><div class="meta">${kind(m.kind)} · ${m.days} 个已覆盖日期，非整月保证</div><div class="rev-kpis"><div><small>加权入住率</small><b>${n(m.occupancy,1)}%</b></div><div><small>加权 ADR</small><b>${n(m.adr)}</b></div><div><small>RevPAR</small><b>${n(m.revpar)}</b></div><div><small>客房收入</small><b>${n(m.room_revenue)}</b></div></div></div>`).join('');
    if (!month) $('revenue-calendar').innerHTML = '<div class="empty">等待经营日报</div>';
    else {
      const offset = new Date(month+'-01T00:00:00Z').getUTCDay();
      const count = new Date(Date.UTC(Number(month.slice(0,4)), Number(month.slice(5)), 0)).getUTCDate();
      const max = Math.max(...inMonth.map(d=>d[metric]??0),1);
      let html = ['日','一','二','三','四','五','六'].map(s=>`<span class="cal-week">${s}</span>`).join('') + '<span></span>'.repeat(offset);
      for (let d=1;d<=count;d++) {
        const key = month+'-'+String(d).padStart(2,'0'), row = inMonth.find(x=>x.stay_date===key), value = row?.[metric];
        const intensity = value == null ? 'none' : value/max>.8 ? 'high' : value/max>.5 ? 'mid' : 'low';
        html += `<button class="cal-day ${intensity} ${key===selected?'selected':''}" data-stay="${key}" ${row?'':'disabled'} aria-label="${key} ${row?kind(row.kind):'缺数据'} ${n(value,1)}" aria-pressed="${key===selected}"><span>${d}</span><strong>${n(value,metric==='occupancy'?1:0)}${metric==='occupancy'&&value!=null?'%':''}</strong><small>${row?(row.kind==='actual'?'实绩':'未来值'):'无数据'}</small></button>`;
      }
      $('revenue-calendar').innerHTML=html;
      $('revenue-calendar').onclick = ev => {const b=ev.target.closest('[data-stay]'); if(b&&!b.disabled){selected=b.dataset.stay;render(state,refresh,notify);}};
    }
    renderDay(inMonth.find(d=>d.stay_date===selected));
    $('revenue-gaps').innerHTML = (r.gaps||[]).map(g=>`<li>${e(g)}</li>`).join('');
    renderOperator();
  }
  function renderDay(d) {
    if ($('cop-context')) $('cop-context').textContent=d ? `当前日期 ${d.stay_date} · ${kind(d.kind)} · 来源 ${state.revenue.source.as_of}` : '按证据区分事实、假设和建议';
    if (!d) {$('revenue-day').innerHTML='<div class="empty">选择日期看口径和来源</div>';return;}
    $('revenue-day').innerHTML = `<div class="sec-h"><h3>${e(d.stay_date)}</h3><span class="pill">${kind(d.kind)}</span></div>
      <dl class="rev-facts"><dt>可售客房</dt><dd>${n(d.inventory,2)}</dd><dt>已售／报表间夜</dt><dd>${n(d.rooms_sold,2)}</dd><dt>入住率（重算）</dt><dd>${n(d.occupancy,2)}%</dd><dt>客房收入</dt><dd>${money(d.room_revenue)}</dd><dt>ADR（重算）</dt><dd>${money(d.adr)}</dd><dt>RevPAR（重算）</dt><dd>${money(d.revpar)}</dd><dt>未来报表值变化</dt><dd>${d.projection_change===null?'暂无可比版本':`${n(d.projection_change,2)} 间夜 · 对比 ${e(d.change_from)}`}</dd></dl>
      <p class="meta">来源：报表 ${e(state.revenue.source.as_of)}。${d.kind==='actual'?'历史实绩。':'这是当时的未来报表值，即使入住日期已过去，也不能变成实绩。'} 缺值为 —，不补零。</p>
      <details><summary class="meta">查看字段与证据</summary><p class="meta">原报表 ADR ${n(d.reported_adr,2)} · 入住率 ${n(d.reported_occupancy,2)}%<br><code class="evidence-ref">${e(d.evidence_id)}</code></p></details>
      <button class="btn" id="scenario-use">用这一天做算术情景</button> <button class="btn ghost" data-ask="解释当前选中日期的经营指标，区分历史实绩、报表未来值和当前缺口">让 Copilot 解读这一天</button>`;
    $('scenario-use').onclick = () => {for (const [id,value] of [['sc-inventory',d.inventory],['sc-rooms',d.rooms_sold],['sc-adr',d.adr]]) $(id).value = Number.isFinite(value)?value:''; $('scenario-basis').textContent=`基线 ${d.stay_date} · ${kind(d.kind)} · 来源 ${state.revenue.source.as_of}${state.revenue.status!=='current'?'（历史数据）':''}`; $('scenario-result').textContent='请输入假设后计算；不会写入任何 OTA。'; $('scenario-form').scrollIntoView({behavior:'smooth',block:'center'});};
  }
  function renderOperator() {
    const o = state.operator || {cards:[], decisions:[]};
    $('operator-cards').innerHTML = o.cards.map(c=>`<article class="card op-card"><div class="sec-h"><span class="pill">${c.kind==='data_gate'?'数据门禁':'待调查'}</span><span class="meta tail">${e(c.owner)} · ${e(c.platform)}</span></div><h3>${e(c.title)}</h3><div class="op-block"><small>已知事实</small>${c.facts.map(f=>`<p>${e(f)}</p>`).join('')}</div><div class="op-block"><small>待验证</small><p>${e(c.hypothesis)}</p></div><div class="op-block"><small>调查方案</small><p>${e(c.plan)}</p></div><div class="op-block"><small>复查条件</small><p>${e(c.verify)}</p></div><details><summary class="meta">${c.evidence_ids.length} 条来源证据</summary>${c.evidence_ids.map(x=>`<code class="evidence-ref">${e(x)}</code>`).join('')}</details><button class="btn primary op-approve" data-ref="${e(c.id)}">确认调查 · 留存基线</button></article>`).join('') || '<div class="empty">没有可生成调查卡的当前证据。先看数据可靠性。</div>';
    $('operator-cards').onclick = async ev => {const b=ev.target.closest('.op-approve');if(!b)return;b.disabled=true;try{await api('/api/operator',{source_ref:b.dataset.ref});notify('调查已留档，未操作 OTA');await refresh();}catch(err){notify(err.message);b.disabled=false;}};
    const names={investigating:'调查中',reported:'人工报告已执行',reviewed:'已人工复查',dismissed:'已搁置'};
    $('operator-decisions').innerHTML = o.decisions.map(d=>`<article class="card"><div class="sec-h"><b>${e(d.title)}</b><span class="pill tail">${names[d.status]||e(d.status)}</span></div><p class="meta">${e(d.owner)} · 确认 ${e(d.created_at.slice(0,10))} · 计划复查 ${e(d.review_on)}</p><p>${e(d.plan)}</p>${d.followup?.status==='observed'?`<div class="observation"><b>观察差值 ${n(d.followup.delta,2)}${e(d.followup.latest.unit)}</b> · ${e(d.followup.baseline.day)} → ${e(d.followup.latest.day)}<br><span class="meta">${e(d.followup.message)}</span></div>`:`<p class="meta">${e(d.followup?.message)}</p>`}<p class="meta">执行／结论记录：${e(d.outcome_note||'尚未填写')}</p>${['investigating','reported'].includes(d.status)?`<div class="decision-form"><input aria-label="执行或复查记录" data-note="${d.id}" placeholder="写明实际动作与结论，不要填客人信息" maxlength="1200">${d.status==='investigating'?`<button class="btn" data-update="${d.id}" data-status="reported">记录人工执行</button>`:`<button class="btn" data-update="${d.id}" data-status="reviewed" ${d.baseline&&d.followup?.status!=='observed'?'disabled':''}>记录人工复查</button>`}<button class="btn ghost" data-update="${d.id}" data-status="dismissed">搁置</button></div>`:''}<details><summary class="meta">审计记录</summary><p class="meta">${e(d.created_at)} · 确认调查，未操作 OTA</p>${(state.operator.events||[]).filter(x=>x.decision_id===d.id).map(x=>`<p class="meta">${e(x.at)} · ${e(x.event)} · ${e(x.note)}</p>`).join('')}</details></article>`).join('') || '<p class="meta">确认一张调查卡后，这里会保留证据基线、执行记录和后续同口径观察。</p>';
    $('operator-decisions').onclick = async ev=>{const b=ev.target.closest('[data-update]');if(!b)return;const note=$('operator-decisions').querySelector(`[data-note="${b.dataset.update}"]`).value;b.disabled=true;try{await api('/api/operator/'+b.dataset.update,{status:b.dataset.status,note});notify('记录已保存；不代表系统执行了后台操作');await refresh();}catch(err){notify(err.message);b.disabled=false;}};
  }
  window.OperatorUI={render, selectedDate:()=>selected};
  document.addEventListener('DOMContentLoaded',()=>{
    $('scenario-form').onsubmit=async ev=>{ev.preventDefault();const v=id=>$(id).value.trim()===''?NaN:Number($(id).value);try{const out=await api('/api/scenario',{inventory:v('sc-inventory'),rooms:v('sc-rooms'),adr:v('sc-adr'),rate_change:v('sc-rate'),room_change:v('sc-change'),commission:v('sc-commission')});$('scenario-result').innerHTML=`<div class="rev-kpis"><div><small>基线毛收入</small><b>${n(out.before_revenue)}</b></div><div><small>情景毛收入</small><b>${n(out.after_revenue)}</b></div><div><small>毛收入变化</small><b>${n(out.delta)}</b></div><div><small>保本间夜</small><b>${n(out.break_even_rooms,2)}</b></div></div><p>按假设佣金扣除后 ${money(out.net_after)}；不代表利润或酒店全渠道净收入。</p><p class="meta">${e(out.disclaimer)}。新增间夜和价格变动均为你手动输入，没有预测涨价后会丢多少订单。</p>`;}catch(err){$('scenario-result').textContent=err.message;}};
  });
})();

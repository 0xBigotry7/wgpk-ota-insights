/* Native-platform operating views. All writes are explicit, cockpit-only investigation records. */
(() => {
  const $=id=>document.getElementById(id);
  const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const n=(v,d=0)=>Number.isFinite(v)?v.toLocaleString('en-US',{maximumFractionDigits:d}):'—';
  let horizon=30;
  const source=m=>m?`采样 ${m.day}${m.source_as_of?' · '+(m.source_date_basis==='selected_window_end'?'筛选截止 ':'页面数据截至 ')+m.source_as_of:''} · ${m.page} · ${m.period}${m.stale?' · 历史数据':''}`:'未采到，不补零';
  const peer=(m,platform)=>m?.benchmark!=null?`<small>${platform==='booking'?'平台所列去年同期':'竞争圈均值'} ${n(m.benchmark,2)}${e(m.unit)}</small>`:'';
  const provenance=m=>m?`<p><b>${e(m.label)}</b> ${n(m.value,2)}${e(m.unit)}<br>${e(source(m))}<br><code class="evidence-ref">${e(m.evidence_id)}</code></p>`:'';
  function render(state,reload,toast){
    const c=state.channels;
    if(!c){$('channel-funnels').innerHTML='<div class="empty">等待渠道经营数据</div>';return;}
    $('channel-boundary').textContent=c.boundaries[0];
    $('channel-funnels').innerHTML=c.funnels.map(f=>{
      const stage=(key,label,i)=>{const m=f.fields[key];return `<div class="channel-stage stage-${i} ${m?'':'missing'}"><span>${e(label)}</span><strong>${n(m?.value)}</strong></div>`;};
      const rate=(key,label)=>`<div><small>${e(label)}</small><b>${n(f.fields[key]?.value,2)}${f.fields[key]?'%':''}</b></div>`;
      const records=Object.values(f.fields).filter(Boolean);
      return `<article class="card channel-col" data-channel="${e(f.platform)}"><header><div class="sec-h"><h3>${e(f.name)}</h3><span class="pill tail">${f.complete?'完整漏斗':records.length||f.ranks.length?'部分信号':'数据待恢复'}</span></div><p class="channel-window">${e(f.window)}</p><p class="meta">采样 ${e(f.observed_on||f.ranks[0]?.day||'尚无')} ${records.some(m=>m.stale)?'· 历史数据':''}</p>
        ${records[0]?.source_as_of?`<p class="meta">${records[0].source_date_basis==='selected_window_end'?'筛选截止':'页面数据截至'} ${e(records[0].source_as_of)}</p>`:'<p class="meta">平台数据截止日未提供</p>'}</header>
        ${stage('exposure',f.stage_labels[0],1)}${stage('visits',f.stage_labels[1],2)}${stage('bookings',f.stage_labels[2],3)}
        <div class="channel-rates">${rate('click_rate','曝光→访问')}${rate('book_rate','访问→预订')}</div>
        ${f.fields.platform_rate?`<p class="meta">平台转化率 ${n(f.fields.platform_rate.value,2)}%（分母待核）</p>`:''}
        <p class="meta channel-note">${e(f.note)}</p>
        ${f.ranks.map(m=>`<p class="meta">${e(m.label)}：第 ${n(m.value)} 名 · 近30天</p>`).join('')}
        ${!records.length&&f.unavailable.length?'<p class="meta channel-blocker">'+(f.platform==='expedia'?'分析数据加载失败；旧版报表需要登录。':f.unavailable.some(p=>p.status==='signed_out')?'需要重新登录分析后台。':'分析来源暂不可用，等待恢复。')+'</p>':''}
        <details class="channel-proof"><summary>来源与口径</summary>${records.map(provenance).join('')}${f.ranks.map(provenance).join('')||(!records.length?'<p class="meta">尚无可用数量，不用其他指标代填。</p>':'')}</details></article>`;
    }).join('');
    $('channel-signal-metrics').innerHTML=c.loss_metrics.map(m=>`<div class="channel-signal"><small>${e(m.platform)} · ${e(m.label)}</small><strong>${n(m.value,2)}${e(m.unit)}</strong><span class="meta">${e(m.period)} · ${e(m.day)}${m.stale?' · 历史':''}</span></div>`).join('')||'<p class="meta">流失／可售信号尚未采到；不会用取消数代替流失订单。</p>';
    $('channel-issues').innerHTML=c.investigations.map(x=>{
      const active=state.operator.decisions.find(d=>d.source_ref===x.id&&['investigating','reported'].includes(d.status));
      return `<article class="channel-issue" data-channel-issue="${e(x.id)}"><div><div class="sec-h"><h3>${e(x.title)}</h3><span class="pill">${x.kind==='data_gate'?'先更新数据':'待调查'}</span></div><p>${e(x.facts[0])}</p><p class="meta">${e(x.hypothesis)}</p><details><summary>调查与复查方案</summary><p>${e(x.plan)}</p><p class="meta">${e(x.verify)}</p></details></div><div>${active?'<a class="btn ghost" href="#sec-operator">已留档 · 看记录</a>':`<button class="btn" data-channel-approve="${e(x.id)}">确认调查 · 留存基线</button>`}</div></article>`;
    }).join('')||'<div class="empty">暂无可用证据生成调查；缺数据不等于没有问题。</div>';
    $('channel-issues').onclick=async ev=>{
      const b=ev.target.closest('[data-channel-approve]');if(!b)return;b.disabled=true;
      try{const r=await fetch('/api/operator',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({source_ref:b.dataset.channelApprove})});const j=await r.json();if(!r.ok)throw Error(j.error||'保存失败');toast('调查已留档；未操作任何OTA');await reload();}catch(err){toast(err.message);b.disabled=false;}
    };
    const showFuture=()=>{
      $('channel-horizon').value=String(horizon);
      const view=c.future.find(x=>x.horizon===horizon);
      $('channel-future').innerHTML=view.channels.map(x=>{
        const r=x.fields.rooms,v=x.fields.revenue,a=x.fields.adr;
        return `<article class="card channel-forward" data-future-channel="${e(x.platform)}"><div class="sec-h"><h3>${e(x.name)}</h3><span class="pill tail">${r?'在手订单':'未采到'}</span></div><p class="meta">${e(x.window)} · ${e(r?.day||'无对应采样')}${r?.stale?' · 历史数据':''}</p><div class="forward-main"><small>已订间夜</small><strong>${n(r?.value)}</strong>${peer(r,x.platform)}</div><dl class="rev-facts"><dt>在手收入</dt><dd>${n(v?.value,2)} ${e(v?.unit||'')}</dd><dt>在手 ADR</dt><dd>${n(a?.value,2)} ${e(a?.unit||'')}</dd></dl>
          ${x.pace?`<div class="channel-cohort"><small>另一统计群体 · 近${horizon}天预订的未来住宿</small><b>${n(x.pace.value)} 间夜</b><span class="meta">${e(x.pace.day)} · 不是上方在手的净增长</span></div>`:''}
          <p class="meta">${e(x.note)}</p><details class="channel-proof"><summary>来源与口径</summary>${[r,v,a,x.pace].map(provenance).join('')||'<p class="meta">本平台对应未来窗口未接通；不借历史销量或其他渠道数字填充。</p>'}</details></article>`;
      }).join('');
    };
    $('channel-horizon').onchange=ev=>{horizon=Number(ev.target.value);showFuture();};showFuture();
  }
  window.ChannelUI={render};
})();

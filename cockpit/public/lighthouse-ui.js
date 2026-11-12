/* Lighthouse × OTA: the day's cross-read (state.lighthouse from lighthouse-brief.js). Read-only view. */
(() => {
  const $ = (id) => document.getElementById(id);
  const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (v, d = 0) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
  const pt = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}pt` : '—');
  const n = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');
  const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
  const ZH = ['很低', '低', '正常', '偏高', '高', '很高'];
  const LV = { 'very low': 0, low: 1, normal: 2, elevated: 3, high: 4, 'very high': 5 };
  const lv = (x) => { if (x == null) return '—'; const k = String(x).toLowerCase(); return k === 'sold out' ? '售罄' : k in LV ? ZH[LV[k]] : String(x); };
  const KIND = { closed_out: ['售罄但有房', 'bad'], underpriced: ['比竞品便宜', 'warn'], overpriced_weak: ['偏贵且弱', 'warn'], compression: ['竞品满房', 'good'],
    pickup: ['在手变化', ''], source_market: ['客源市场', ''], los: ['停留天数', ''], demand_up: ['需求上调', 'warn'] };
  const when = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }) : '—');

  function cell(level, cls = '') {
    if (level === 'sold') return `<i class="lh-c sold ${cls}"></i>`;
    if (level == null) return `<i class="lh-c none ${cls}"></i>`;
    return `<i class="lh-c ${cls}" style="background:color-mix(in srgb, var(--s1) ${12 + level * 17}%, var(--surface))"></i>`;
  }

  function strip(b) {
    const s = b.strip;
    if (!s.length) return '';
    const cols = `grid-template-columns:96px repeat(${s.length},minmax(0,1fr))`;
    const head = s.map((d, i) => `<span class="lh-dh ${d.dow === 'Sat' || d.dow === 'Sun' ? 'we' : ''}">${i % 7 === 0 || d.date.endsWith('-01') ? md(d.date) : ''}</span>`).join('');
    const tip = (d) => e(`${d.date} ${d.dow || ''}｜需求 ${lv(d.demand)}｜我们 ${lv(d.my_level)}${Number.isFinite(d.my_price) ? ` ${n(d.my_price)}` : ''}｜竞品 ${lv(d.comp_level)}｜我们在手 ${pct(d.my_otb)}（OPERA ${d.opera_otb ?? '—'} 间）｜市场在手 ${pct(d.mkt_otb)}｜不可订酒店 ${pct(d.unavailable)}${d.pickup_7d != null ? `｜7天 pickup ${d.pickup_7d > 0 ? '+' : ''}${d.pickup_7d}` : ''}${d.events ? `｜活动 ${d.events}` : ''}${d.flags.length ? `｜${d.flags.map((f) => KIND[f]?.[0] || f).join('、')}` : ''}`);
    const row = (label, f) => `<span class="lh-rl">${label}</span>${s.map((d) => `<span class="lh-cell" title="${tip(d)}">${f(d)}</span>`).join('')}`;
    const otb = (d) => `<span class="lh-otb"><b style="height:${Math.round((d.my_otb || 0) * 100)}%"></b>${Number.isFinite(d.mkt_otb) ? `<em style="bottom:${Math.round(d.mkt_otb * 100)}%"></em>` : ''}</span>`;
    const flag = (d) => (d.flags.includes('closed_out') ? '<i class="lh-f bad"></i>' : d.flags.includes('underpriced') ? '<i class="lh-f warn"></i>'
      : d.flags.length ? '<i class="lh-f"></i>' : '');
    return `<div class="card lh-strip-card"><div class="lh-strip" style="${cols}">
      <span class="lh-rl"></span>${head}
      ${row('需求', (d) => cell(d.d))}
      ${row('我们价位', (d) => cell(d.sold_out ? 'sold' : d.m))}
      ${row('竞品价位', (d) => cell(d.c))}
      ${row('在手 我们/市场', otb)}
      ${row('不可订酒店', (d) => `<span class="lh-un" style="height:${Math.min(100, Math.round((d.unavailable || 0) * 200))}%"></span>`)}
      ${row('活动 · 提醒', (d) => `${d.events ? '<i class="lh-ev"></i>' : ''}${flag(d)}`)}
    </div>
    <div class="pace-legend lh-legend"><span>档位 ${[1, 3, 5].map((l) => `${cell(l)}${ZH[l]}`).join(' ')}</span><span>${cell('sold')}公开渠道售罄</span>
      <span><i class="sw lh-sw-otb"></i>我们在手（OPERA/422）</span><span><i class="sw lh-sw-mkt"></i>市场在手</span><span><i class="lh-f bad"></i>售罄但有房</span><span><i class="lh-f warn"></i>比竞品便宜</span><span><i class="lh-ev"></i>活动/假期</span></div>
    <p class="meta">鼠标停在格子上看当天全部数字。周末日期加粗。</p></div>`;
  }

  function actions(b) {
    if (!b.actions.length) return '<div class="empty">今天 Lighthouse 和 OTA 数据没有需要动手的交叉信号。</div>';
    return `<ol class="lh-acts">${b.actions.map((a, i) => {
      const [word, cls] = KIND[a.kind] || [a.kind, ''];
      return `<li class="card lh-act sev${a.severity}"><div class="lh-act-h"><span class="lh-no">${i + 1}</span><b>${e(a.title)}</b></div>
        <div class="lh-tags"><span class="pace-chip ${cls}">${e(word)}</span>${a.channels.map((c) => `<span class="pill">${e(c)}</span>`).join('')}<span class="meta">${e(a.date_text)}</span></div>
        <ul class="lh-ev-list">${a.evidence.map((x) => `<li>${e(x)}</li>`).join('')}</ul>
        <p class="lh-do"><b>动作</b>${e(a.action)}</p>
        <p class="meta"><b>预期</b> ${e(a.impact)} · <b>看</b> ${e(a.watch)}</p></li>`;
    }).join('')}</ol>`;
  }

  function windows(b) {
    return `<div class="card" style="padding:0"><div class="tbl" style="border-top:0"><table class="lh-win"><thead><tr><th>窗口</th><th>需求 很高/高/偏高</th><th>需求变动 ↑/↓</th><th>售罄</th><th>低于/高于竞品</th><th>我们在手</th><th>市场在手</th><th>不可订酒店</th><th>OPERA 7天 pickup</th></tr></thead><tbody>
      ${b.windows.map((w) => `<tr><td>未来 ${w.days} 天</td><td>${w.demand.very_high} / ${w.demand.high} / ${w.demand.elevated}</td><td>${w.demand_moves.up} / ${w.demand_moves.down}</td><td>${w.sold_out}</td>
        <td>${w.below_compset} / ${w.above_compset}</td><td><b>${pct(w.my_otb)}</b></td><td>${pct(w.market_otb)}</td><td>${pct(w.unavailable)}</td><td>${w.opera_pickup_7d > 0 ? '+' : ''}${n(w.opera_pickup_7d)}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  }

  function changes(b) {
    const c = b.changes;
    const li = (arr, f, empty) => (arr.length ? `<ul class="lh-ch">${arr.map(f).join('')}</ul>` : `<p class="meta">${empty}</p>`);
    const otb = [...c.otb].sort((a, z) => Math.abs(z.my_otb ?? 0) + Math.abs(z.market_otb ?? 0) - Math.abs(a.my_otb ?? 0) - Math.abs(a.market_otb ?? 0)).slice(0, 8);
    return `<div class="lh-grid3">
      <div class="card"><h3 class="pace-h3">需求档位变动</h3>${li(c.demand_moves, (x) => `<li><b>${md(x.date)}</b> ${lv(x.from)} → ${lv(x.to)} <span class="pace-gap ${x.up ? 'good' : 'bad'}">${x.up ? '↑' : '↓'}</span></li>`, '没有变动')}
        <h3 class="pace-h3">竞品价位变动</h3>${li(c.compset_level, (x) => `<li><b>${md(x.date)}</b> ${lv(x.from)} → ${lv(x.to)}</li>`, '没有变动（或缺上一份）')}</div>
      <div class="card"><h3 class="pace-h3">在手变化（我们 vs 市场）</h3>${li(otb, (x) => `<li><b>${md(x.date)}</b> 我们 <span class="pace-gap ${(x.my_otb ?? 0) < 0 ? 'bad' : ''}">${pt(x.my_otb)}</span> · 市场 ${pt(x.market_otb)}${x.my_price ? ` · 公开价 ${x.my_price > 0 ? '+' : ''}${n(x.my_price)}` : ''}</li>`, '没有变化')}</div>
      <div class="card"><h3 class="pace-h3">不可订酒店变化</h3>${li(c.unavailable.slice(0, 8), (x) => `<li><b>${md(x.date)}</b> ${pct(x.before)} → ${pct(x.after)}</li>`, '变化都小于 2pt')}
        <h3 class="pace-h3">搜索客源排名变化</h3>${li(c.source_rank.slice(0, 6), (x) => `<li><b>${e(x.country)}</b> 第 ${x.before} → 第 ${x.rank}</li>`, '前 10 排名没变')}</div></div>`;
  }

  function markets(b) {
    const m = b.source_markets;
    const max = Math.max(0.01, ...m.hotel_search.map((x) => x.share || 0), ...m.hotel_search.map((x) => (x.opera_mtd_share_pct || 0) / 100));
    return `<div class="lh-grid2">
      <div class="card"><h3 class="pace-h3">谁在搜 vs 谁在住</h3><p class="meta">条 = Lighthouse 酒店搜索占比；刻度 = OPERA 本月入住间夜占比</p>
        ${m.hotel_search.map((x) => `<div class="lh-mk"><span>${e(x.name)}</span><span class="lh-mbar"><b style="width:${(x.share || 0) / max * 100}%"></b>${x.opera_mtd_share_pct != null ? `<em style="left:${Math.min(100, x.opera_mtd_share_pct / 100 / max * 100)}%"></em>` : ''}</span>
          <span class="meta">${pct(x.share, 1)} · 住 ${x.opera_mtd_share_pct != null ? `${x.opera_mtd_share_pct}%` : '—'}</span></div>`).join('')}
        <p class="meta">OPERA 本月入住前列：${m.opera_mtd.slice(0, 5).map((x) => `${e(x.name)} ${x.share_pct}%`).join('、') || '—'}</p></div>
      <div class="card"><h3 class="pace-h3">机票搜索客源与停留天数</h3>
        <table class="lh-win"><thead><tr><th>客源</th><th>占比</th><th>平均停留</th></tr></thead><tbody>${m.flight_search.slice(0, 8).map((x) => `<tr><td>${e(x.name)}</td><td>${pct(x.share, 1)}</td><td>${x.avg_los ?? '—'} 晚</td></tr>`).join('')}</tbody></table>
        <h3 class="pace-h3">停留天数分布</h3><table class="lh-win"><thead><tr><th>晚数</th><th>机票(Meta/OTA)</th><th>酒店搜索</th></tr></thead><tbody>${m.stay_patterns.map((x) => `<tr><td>${e(String(x.bucket).replace('LOS ', ''))}</td><td>${pct(x.flights)}</td><td>${pct(x.hotels)}</td></tr>`).join('')}</tbody></table></div></div>`;
  }

  function events(b) {
    if (!b.events.length) return '';
    return `<div class="card" style="padding:0"><div class="tbl" style="border-top:0"><table class="lh-win"><thead><tr><th>日期</th><th>活动 / 假期</th><th>类型</th><th>需求</th><th>我们价位</th><th>竞品价位</th><th>我们在手</th></tr></thead><tbody>
      ${b.events.map((x) => `<tr><td>${md(x.start)}${x.end !== x.start ? `–${md(x.end)}` : ''}</td><td>${e(x.name)}</td><td>${e(x.category || '')}</td><td>${lv(x.demand)}</td><td>${lv(x.my_level)}</td><td>${lv(x.comp_level)}</td><td>${x.opera_otb != null ? `${x.opera_otb}/422` : pct(x.my_otb)}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  }

  function render(state) {
    const b = state.lighthouse;
    const box = $('lh-body');
    if (!box) return;
    if (!b || !b.available) { box.innerHTML = `<div class="empty">${e(b?.note || '还没有收到 Lighthouse 市场报表（每天 06:30 自动导出）。')}</div>`; return; }
    const s = b.sources;
    box.innerHTML = `<div class="lh-hero"><div class="call lh-call"><span class="lh-k">今天的判断 · Lighthouse × OTA</span><b class="lh-head">${e(b.headline)}</b>
        <span class="lh-src">Lighthouse ${when(s.lighthouse)}${s.lighthouse_previous ? `（对比 ${when(s.lighthouse_previous)}）` : ''} · OPERA 业务日 ${e(s.opera_business_date || '—')} · OTA 采集 ${e(s.channel_metrics_day || '—')} · ${s.ideas_snapshot ? `IDeaS ${e(s.ideas_snapshot)}` : '无 IDeaS'}</span></div></div>
      <h3 class="pace-h3">今天要做的事（按价值排序）</h3>${actions(b)}
      <h3 class="pace-h3">未来 60 天：需求 vs 我们价位 vs 竞品价位 vs 在手</h3>${strip(b)}
      ${windows(b)}
      <h3 class="pace-h3">和上一份比</h3>${changes(b)}
      <h3 class="pace-h3">客源市场</h3>${markets(b)}
      <h3 class="pace-h3">活动与假期（未来 90 天）</h3>${events(b)}
      <p class="meta">${e(b.note)}</p>`;
  }
  window.LighthouseUI = { render };
})();

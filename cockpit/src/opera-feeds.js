// OPERA daily reports for the ota agent: booking pace, on-the-books by market code, actuals by source (channel) and
// market, and guest country mix. Six OPERA schedules e-mail opera-analytics@ every morning 06:30–07:15 Bangkok; the
// archive Worker wgpk-opera-analytics-email-ingest (wgpk-concierge infra/opera-analytics-email-worker) stores the
// numbers of each in report_analyses.summary_json (schemaVersion 2, `metrics`). Here they are only read (SELECT on the
// PMS_ARCHIVE_DB binding) — no cockpit table, no copy. History & Forecast keeps its own path (pms-bridge.js).
//
// Only aggregates leave this module: every response is rebuilt field by field from the stored metrics, never passed
// through, so nothing the archive might hold beyond them (file names, object keys, raw rows) can reach the agent.

export const OPERA_VIEWS = ["pace", "market", "source", "country"];
const TYPE = { pace: "reservation_pace", market: "los_market_forecast", source: "stat_dmy_source",
  segment: "stat_dmy_seg", country: "stat_country_revenue" };

// Alert thresholds (documented in docs/AGENT-API.md).
export const OPERA_LIMITS = {
  stale_hours: 30,              // newest OPERA report older than this: the morning e-mails stopped
  pickup_window_days: 30,       // net 7-day pickup over the next N stay dates
  pickup_warning: 0,            // below this (net negative): warning
  pickup_serious: -30,          // at or below this many room nights: serious
  date_cancel_rooms: -10,       // a single stay date in the next 14 days losing this many in 7 days
  adr_min_mtd_rooms: 20,        // channel needs this many room nights month to date before its ADR is judged
  adr_drop_warning: 0.85,       // channel ADR relative to hotel ADR, MTD vs YTD: below 85 % of its usual premium
  adr_drop_serious: 0.75,
};

const bkkDay = (ms) => new Date(ms + 7 * 3600e3).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const period = (p) => ({ rooms: n(p?.rooms), revenue: n(p?.revenue), adr: n(p?.adr) });

/** Latest `limit` deliveries of one report type that carry metrics, newest first. Read-only. */
async function deliveries(archive, type, limit) {
  const r = await archive.prepare(`select e.received_at, a.summary_json from report_analyses a
      join report_files f on f.id = a.file_id join report_emails e on e.id = f.email_id
      where a.report_type = ? and a.summary_json like '%"metrics"%' order by e.received_at desc limit ?`)
    .bind(type, limit).all();
  return (r.results || []).map((row) => ({ received_at: row.received_at, metrics: parse(row.summary_json)?.metrics || null }))
    .filter((d) => d.metrics);
}

/** Everything the views, the daily block and the alerts need, in one round of reads. Null without the binding. */
export async function loadOperaFeeds(archive) {
  if (!archive) return null;
  const [pace, market, source, segment, country] = await Promise.all([
    deliveries(archive, TYPE.pace, 1), deliveries(archive, TYPE.market, 1), deliveries(archive, TYPE.source, 1),
    deliveries(archive, TYPE.segment, 1), deliveries(archive, TYPE.country, 1)]);
  return { pace: pace[0] || null, market: market[0] || null, source: source[0] || null, segment: segment[0] || null,
    country: country[0] || null };
}

// The business date of a delivery batch is the first stay date of its pace report (stay range starts at Business
// Date). Actuals reports carry no date of their own; by schedule they cover Business Date − 1.
function dates(feeds) {
  const business = feeds?.pace?.metrics?.businessDate || null;
  return { business_date: business, report_date: business ? addDays(business, -1) : null };
}

function newest(feeds) {
  return Object.values(feeds || {}).filter(Boolean).map((d) => d.received_at).sort().at(-1) || null;
}

function paceView(d, windowDays = 120) {
  const days = (d.metrics.days || []).slice(0, windowDays).map((x) => ({ stay_date: x.d, otb: n(x.otb), otb_7d_ago: n(x.otbFrom),
    pickup_7d: n(x.pickup), pickup_transient: n(x.pickupInd), pickup_group: n(x.pickupBlk), revenue: n(x.rev),
    revenue_pickup_7d: n(x.revPickup), available: n(x.avail) }));
  return { compare: "on the books now vs 7 days ago (OPERA Reservation Booking Pace)", days };
}

function pickupSum(days, from, to) {
  const span = days.filter((x) => x.stay_date >= from && x.stay_date < to);
  const sum = (k) => span.reduce((a, x) => a + (x[k] || 0), 0);
  return { stay_dates: span.length, pickup_7d: sum("pickup_7d"), transient: sum("pickup_transient"), group: sum("pickup_group"),
    revenue_pickup_7d: r2(sum("revenue_pickup_7d")) };
}

function marketView(d) {
  const rows = (d.metrics.rows || []).map(([date, market, rooms, revenue, avgLos]) => ({ stay_date: date, market,
    rooms: n(rooms), room_revenue: n(revenue), adr: rooms ? r2(revenue / rooms) : null, avg_los: n(avgLos) }));
  const totals = (d.metrics.totals || []).map(([date, rooms, revenue]) => ({ stay_date: date, rooms: n(rooms), room_revenue: n(revenue) }));
  return { note: "on the books per stay date and OPERA market code (Length Of Stay By Market Code)", rows, totals };
}

function rollupByMarket(rows, from, to) {
  const by = new Map();
  for (const r of rows) {
    if (r.stay_date < from || r.stay_date >= to) continue;
    const m = by.get(r.market) || { market: r.market, rooms: 0, room_revenue: 0 };
    m.rooms += r.rooms || 0; m.room_revenue += r.room_revenue || 0; by.set(r.market, m);
  }
  const total = [...by.values()].reduce((a, m) => a + m.rooms, 0);
  return [...by.values()].map((m) => ({ ...m, room_revenue: r2(m.room_revenue), adr: m.rooms ? r2(m.room_revenue / m.rooms) : null,
    share_pct: total ? r1((m.rooms / total) * 100) : null })).sort((a, b) => b.rooms - a.rooms);
}

function actualsView(d) {
  const h = d.metrics.hotel || {};
  return {
    hotel: { day: { ...period(h.day), occ_pct: n(h.day?.occ) }, mtd: { ...period(h.mtd), occ_pct: n(h.mtd?.occ) },
      ytd: { ...period(h.ytd), occ_pct: n(h.ytd?.occ) } },
    codes: (d.metrics.codes || []).map((c) => ({ group: String(c.group || ""), code: String(c.code || ""), name: String(c.name || ""),
      day: period(c.day), mtd: period(c.mtd), ytd: period(c.ytd) })),
  };
}

// A channel's ADR as a multiple of the hotel ADR, this month vs this year. Seasonality moves every channel together,
// so a channel only stands out when its own premium shrinks.
function channelAdr(actuals) {
  const hm = actuals.hotel.mtd.adr, hy = actuals.hotel.ytd.adr;
  return actuals.codes.filter((c) => (c.ytd.revenue || 0) > 0 || (c.mtd.revenue || 0) > 0).map((c) => {
    const vsMtd = hm && c.mtd.adr ? c.mtd.adr / hm : null, vsYtd = hy && c.ytd.adr ? c.ytd.adr / hy : null;
    return { code: c.code, name: c.name, mtd_rooms: c.mtd.rooms, mtd_adr: c.mtd.adr, ytd_rooms: c.ytd.rooms, ytd_adr: c.ytd.adr,
      adr_vs_hotel_mtd: r2(vsMtd), adr_vs_hotel_ytd: r2(vsYtd), relative_change: vsMtd && vsYtd ? r2(vsMtd / vsYtd) : null };
  }).sort((a, b) => (b.mtd_rooms || 0) - (a.mtd_rooms || 0));
}

function countryView(d) {
  return { countries: (d.metrics.countries || []).map((c) => ({ country: String(c.country || ""), name: String(c.name || ""),
    day: period(c.day), mtd: period(c.mtd), ytd: period(c.ytd) })) };
}

function shares(list, key) {
  const total = list.reduce((a, c) => a + (c[key].rooms || 0), 0);
  return list.filter((c) => (c[key].rooms || 0) > 0).sort((a, b) => b[key].rooms - a[key].rooms)
    .map((c) => ({ country: c.country, name: c.name, rooms: c[key].rooms, adr: c[key].adr, share_pct: total ? r1((c[key].rooms / total) * 100) : null }));
}

const META = (d, feeds) => ({ received_at: d.received_at, ...dates(feeds) });
const MISSING = { available: false,
  note: "No OPERA report of this kind yet. Six OPERA schedules e-mail opera-analytics@ daily 06:30–07:15 Bangkok." };

/** GET /api/agent/opera?view=pace|market|source|country (default: the same compact summary as /api/agent/daily). */
export async function agentOpera(archive, params, now = Date.now()) {
  const view = params.get("view") || "summary";
  if (view !== "summary" && !OPERA_VIEWS.includes(view)) return { error: `view must be one of ${OPERA_VIEWS.join(", ")}`, status: 400 };
  const feeds = await loadOperaFeeds(archive);
  if (view === "summary") return operaSummary(feeds, now);
  if (view === "pace") return feeds?.pace ? { view, available: true, ...META(feeds.pace, feeds), ...paceView(feeds.pace) } : { view, ...MISSING };
  if (view === "market") return feeds?.market ? { view, available: true, ...META(feeds.market, feeds), ...marketView(feeds.market) } : { view, ...MISSING };
  if (view === "source") {
    if (!feeds?.source) return { view, ...MISSING };
    const a = actualsView(feeds.source);
    return { view, available: true, ...META(feeds.source, feeds), note: "actuals for report_date, month to date and year to date per OPERA source code (channel)",
      ...a, channel_adr: channelAdr(a), by_market: feeds.segment ? actualsView(feeds.segment).codes : null };
  }
  return feeds?.country ? { view, available: true, ...META(feeds.country, feeds), note: "actuals for report_date, month to date and year to date per guest country", ...countryView(feeds.country) }
    : { view, ...MISSING };
}

/** The compact block for /api/agent/daily. */
export function operaSummary(feeds, now = Date.now()) {
  const latest = newest(feeds);
  if (!latest) return { available: false, note: MISSING.note };
  const { business_date, report_date } = dates(feeds);
  const out = { available: true, latest_received_at: latest, age_hours: Math.round((now - Date.parse(latest)) / 3600e3),
    business_date, report_date };
  if (feeds.pace) {
    const days = paceView(feeds.pace).days, start = business_date || bkkDay(now);
    out.pickup_7d = { next_14_days: pickupSum(days, start, addDays(start, 14)), next_30_days: pickupSum(days, start, addDays(start, 30)),
      biggest_losses: days.filter((x) => x.stay_date < addDays(start, 30) && (x.pickup_7d || 0) < 0)
        .sort((a, b) => a.pickup_7d - b.pickup_7d).slice(0, 3)
        .map((x) => ({ stay_date: x.stay_date, pickup_7d: x.pickup_7d, transient: x.pickup_transient, group: x.pickup_group, otb: x.otb })) };
  }
  if (feeds.market) {
    const start = business_date || bkkDay(now);
    out.otb_by_market_next_30_days = rollupByMarket(marketView(feeds.market).rows, start, addDays(start, 30)).slice(0, 8);
  }
  if (feeds.source) {
    const a = actualsView(feeds.source);
    out.hotel = a.hotel;
    out.channels = channelAdr(a).filter((c) => (c.mtd_rooms || 0) > 0 || (c.ytd_rooms || 0) >= 100).slice(0, 10);
  }
  if (feeds.country) out.top_countries_mtd = shares(countryView(feeds.country).countries, "mtd").slice(0, 5);
  return out;
}

/** Alerts in the monitor's shape: stale feed, net negative pickup (cancellations), a channel's ADR premium shrinking. */
export function operaAlerts(feeds, now = Date.now(), L = OPERA_LIMITS) {
  const alerts = [];
  const latest = newest(feeds);
  if (!latest) return alerts;                                      // never delivered: the revenue gaps already say so
  const base = { platform: "all", owner: "收益/销售" };
  const hours = Math.round((now - Date.parse(latest)) / 3600e3);
  if (hours > L.stale_hours) {
    alerts.push({ ...base, id: "opera:stale", level: "serious", area: "data", title: `OPERA 日报已经 ${hours} 小时没有更新`,
      detail: `最近一封 ${latest.slice(0, 16).replace("T", " ")} UTC；正常每天 06:30–07:15 收到 6 封`,
      action: "OPERA → Manage Scheduled Reports 查 jingzhou xue 名下 6 个排程是否还在、上次执行结果；再查 opera-analytics@ 归档" });
    return alerts;                                                 // stale numbers would only produce stale alerts
  }
  const { business_date } = dates(feeds);
  if (feeds.pace && business_date) {
    const days = paceView(feeds.pace).days;
    const s = pickupSum(days, business_date, addDays(business_date, L.pickup_window_days));
    if (s.pickup_7d < L.pickup_warning) {
      alerts.push({ ...base, id: "opera:pickup-negative", level: s.pickup_7d <= L.pickup_serious ? "serious" : "warning", area: "revenue",
        title: `未来 ${L.pickup_window_days} 天过去 7 天净减少 ${-s.pickup_7d} 间夜`,
        detail: `散客 ${s.transient >= 0 ? "+" : ""}${s.transient}，团队 ${s.group >= 0 ? "+" : ""}${s.group}；房费 ${s.revenue_pickup_7d}（OPERA 业务日 ${business_date}）`,
        action: "看是团队取消还是散客取消：团队找销售核实房块；散客查各 OTA 的取消和价格是否被比下去" });
    }
    const end = addDays(business_date, 14);
    const hits = days.filter((x) => x.stay_date < end && (x.pickup_7d || 0) <= L.date_cancel_rooms);
    if (hits.length) {
      alerts.push({ ...base, id: "opera:date-cancellations", level: "warning", area: "revenue",
        title: `未来 14 天有 ${hits.length} 个日期 7 天内掉了 ${-L.date_cancel_rooms} 间以上`,
        detail: hits.slice(0, 5).map((x) => `${x.stay_date} ${x.pickup_7d}（散客 ${x.pickup_transient}，团队 ${x.pickup_group}）`).join("；"),
        action: "这些日期考虑重新开放折扣渠道或降低最短入住限制，先确认是不是团队房块释放" });
    }
  }
  if (feeds.source) {
    for (const c of channelAdr(actualsView(feeds.source))) {
      if ((c.mtd_rooms || 0) < L.adr_min_mtd_rooms || c.relative_change == null || !(c.mtd_adr > 0)) continue;
      if (c.relative_change >= L.adr_drop_warning) continue;
      alerts.push({ ...base, id: `opera:adr-drop:${c.code}`, level: c.relative_change < L.adr_drop_serious ? "serious" : "warning", area: "revenue",
        title: `${c.name} 本月 ADR 相对全酒店下降 ${Math.round((1 - c.relative_change) * 100)}%`,
        detail: `本月 ${c.mtd_adr}（${c.mtd_rooms} 间夜，全酒店的 ${c.adr_vs_hotel_mtd} 倍），今年 ${c.ytd_adr}（全酒店的 ${c.adr_vs_hotel_ytd} 倍）`,
        action: "查该渠道是否在跑促销、会员价或移动价叠加，或是低价房型卖得多" });
    }
  }
  return alerts;
}

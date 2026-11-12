// Lighthouse brief: Lighthouse market data read together with the OTA data this cockpit already has (OPERA pace and
// countries, IDeaS BAR, Booking/Agoda/Ctrip channel numbers), turned into dated calls with evidence from both sides
// and a suggested action per channel. Deterministic: same inputs, same brief. No model, no writes to any back office.
//
// Inputs are read-only: lighthouse_views (latest market/events/compare), lighthouse_market_history (earlier market
// deliveries, kept here so a brief can compare unavailable hotels, compset level and source markets day over day),
// the cockpit state (metrics, OPERA feeds) and the latest IDeaS snapshot. Output is stored once per Bangkok day in
// lighthouse_briefs for history.

export const BRIEF_VERSION = 1;
export const CAPACITY = 422;                       // WGPK rooms; Lighthouse "My OTB" = OPERA on the books / 422
const LEVEL = { "very low": 0, low: 1, normal: 2, elevated: 3, high: 4, "very high": 5 };
const LEVEL_ZH = ["很低", "低", "正常", "偏高", "高", "很高"];
const IDEAS_MAX_AGE_DAYS = 21;
const COUNTRY_ZH = { CN: "中国", IN: "印度", TH: "泰国", GB: "英国", DE: "德国", RU: "俄罗斯", KZ: "哈萨克斯坦", AU: "澳大利亚",
  US: "美国", MY: "马来西亚", SG: "新加坡", KR: "韩国", JP: "日本", SA: "沙特", AE: "阿联酋", FR: "法国", NL: "荷兰",
  SE: "瑞典", IL: "以色列", HK: "中国香港", TW: "中国台湾", ID: "印尼", VN: "越南", PH: "菲律宾", IT: "意大利", ES: "西班牙",
  CH: "瑞士", DK: "丹麦", NO: "挪威", FI: "芬兰", PL: "波兰", CZ: "捷克", UZ: "乌兹别克斯坦", MX: "墨西哥", BY: "白俄罗斯", CA: "加拿大",
  NZ: "新西兰", IE: "爱尔兰", AT: "奥地利", BE: "比利时", KW: "科威特", QA: "卡塔尔", OM: "阿曼", BH: "巴林" };
// Which OTA usually carries a source market (rule of thumb, said as such in every action that uses it).
const CHANNEL_OF = (cc) => (["CN", "HK", "TW", "MO"].includes(cc) ? ["携程"]
  : ["RU", "KZ", "BY", "UZ", "KG"].includes(cc) ? ["Agoda", "俄语旅行社/批发"]
  : ["IN", "TH", "MY", "SG", "ID", "KR", "JP", "VN", "PH", "SA", "AE", "KW", "QA", "OM", "BH"].includes(cc) ? ["Agoda", "Booking"]
  : ["Booking", "Expedia"]);

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const lvl = (s) => (s == null ? null : LEVEL[String(s).trim().toLowerCase()] ?? null);
const pct = (v, d = 0) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);
const pt = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}pt`);
const thb = (v) => (v == null ? "—" : Math.round(v).toLocaleString("en-US"));
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
const bkkDay = (ms = Date.now()) => new Date(ms + 7 * 3600e3).toISOString().slice(0, 10);
const span2 = (a, b, f) => (f(a) === f(b) ? f(a) : `${f(a)}–${f(b)}`);
const pctRange = (list) => span2(Math.min(...list), Math.max(...list), (v) => pct(v));
const lz = (s) => { if (s == null) return "—"; if (String(s).toLowerCase() === "sold out") return "售罄"; const v = lvl(s); return v == null ? String(s) : LEVEL_ZH[v]; };
const lzs = (list) => [...new Set(list.map(lz))].join("/");
const cname = (cc) => (COUNTRY_ZH[cc] ? `${COUNTRY_ZH[cc]}` : cc);

/** Consecutive stay dates → "11/16–11/22" pieces. */
export function ranges(dates) {
  const out = [];
  for (const d of [...dates].sort()) {
    const last = out.at(-1);
    if (last && addDays(last.to, 1) === d) last.to = d; else out.push({ from: d, to: d });
  }
  return out;
}
const rangeText = (dates) => ranges(dates).map((r) => (r.from === r.to ? md(r.from) : `${md(r.from)}–${md(r.to)}`)).join("、");

/** One row per stay date with Lighthouse and OTA numbers side by side. */
export function mergeDays({ market, prev, opera, ideas, today, horizon = 60 }) {
  const before = new Map((prev?.daily || []).map((x) => [x.Date, x]));
  const operaBy = new Map((opera?.days || []).map((x) => [x.stay_date, x]));
  const ideasBy = new Map((ideas?.days || []).map((x) => [x.stay_date, x]));
  const end = addDays(today, horizon);
  return (market?.daily || []).filter((x) => x.Date >= today && x.Date < end).map((x) => {
    const sold = String(x["My price level"] || "").toLowerCase() === "sold out" || x["My price"] === "Sold out";
    const p = before.get(x.Date), o = operaBy.get(x.Date), i = ideasBy.get(x.Date);
    const myPrice = num(x["My price"]);
    return {
      date: x.Date, dow: x.Day || null,
      demand: x["Demand level"] || null, d: lvl(x["Demand level"]),
      my_price: myPrice, my_level: sold ? "Sold out" : (x["My price level"] || null), m: sold ? null : lvl(x["My price level"]), sold_out: sold,
      comp_level: x["Smart Compset price level"] || null, c: lvl(x["Smart Compset price level"]),
      my_otb: r3(num(x["My OTB"])), mkt_otb: r3(num(x["Market OTB"])), unavailable: r3(num(x["Unavailable hotels"])),
      events: num(x["Nr. of events and holidays"]) || 0,
      origin_hotel: x["Origin hotels 1"] || null, origin_flight: x["Origin flights (Meta/OTA) 1"] || null,
      flight_level: x["Flight level (Meta/OTA) vs. benchmark"] || null, hotel_level: x["Hotel level vs. benchmark"] || null,
      prev: p ? { demand: p["Demand level"] || null, d: lvl(p["Demand level"]), comp_level: p["Smart Compset price level"] || null,
        c: lvl(p["Smart Compset price level"]), unavailable: r3(num(p["Unavailable hotels"])), my_otb: r3(num(p["My OTB"])),
        mkt_otb: r3(num(p["Market OTB"])), my_price: num(p["My price"]) } : null,
      opera: o ? { otb: o.otb, pickup_7d: o.pickup_7d, unsold: o.otb != null ? Math.max(0, CAPACITY - o.otb) : null } : null,
      ideas: i ? { bar: num(i.bar), competitor_median: num(i.competitor_median), remaining: num(i.remaining) } : null,
    };
  });
}

/** Latest value of each OTA channel metric we cross-reference (from the cockpit metrics already loaded). */
export function channelSignals(metrics = []) {
  const latest = new Map();
  for (const m of metrics) {
    const k = `${m.platform}|${m.metric}|${m.period || ""}`;
    const cur = latest.get(k);
    if (!cur || m.day >= cur.day) latest.set(k, m);
  }
  const get = (p, metric, period = "") => {
    const m = latest.get(`${p}|${metric}|${period}`) || [...latest.values()].find((x) => x.platform === p && x.metric === metric);
    return m ? { value: m.value, benchmark: m.benchmark ?? null, day: m.day } : null;
  };
  const months = {};
  for (const m of latest.values()) {
    const s = /^stay_(\d{4}-\d{2})$/.exec(m.period || "");
    if (!s || m.platform !== "booking") continue;
    const row = (months[s[1]] ||= { month: s[1] });
    if (m.metric === "pace_room_nights") Object.assign(row, { otb: m.value, otb_ly: m.benchmark ?? null, day: m.day });
    if (m.metric === "pickup_30d_adr") row.new_adr_30d = m.value;
    if (m.metric === "pickup_30d_adr_comp") row.new_adr_30d_comp = m.value;
    if (m.metric === "pickup_30d_room_nights") row.new_rn_30d = m.value;
  }
  return {
    agoda: { bookings_lost_30d: get("agoda", "bookings_lost_30d"), search_rank_30d: get("agoda", "search_results_rank_30d"),
      net_room_nights_30d: get("agoda", "net_room_nights_30d") },
    ctrip: { lost_bookings_14d: get("ctrip", "lost_bookings_14d"), lost_room_nights_14d: get("ctrip", "lost_room_nights_14d"),
      won_bookings_14d: get("ctrip", "won_bookings_14d"), otb_room_nights_30d: get("ctrip", "otb_room_nights_30d"),
      book_rate_30d: get("ctrip", "book_rate", "last_30_days") },
    booking: { book_rate_30d: get("booking", "book_rate", "last_30_days"), conversion_90d: get("booking", "conversion_rate_90d"),
      months },
  };
}

const lostText = (ch) => [
  ch.agoda.bookings_lost_30d ? `Agoda 未来30天流失 ${ch.agoda.bookings_lost_30d.value} 单（${ch.agoda.bookings_lost_30d.day}）` : null,
  ch.ctrip.lost_bookings_14d ? `携程近14天流失 ${ch.ctrip.lost_bookings_14d.value} 单/${ch.ctrip.lost_room_nights_14d?.value ?? "—"} 间夜、只赢 ${ch.ctrip.won_bookings_14d?.value ?? "—"} 单（${ch.ctrip.lost_bookings_14d.day}）` : null,
].filter(Boolean);

const monthOf = (ch, date) => ch.booking.months[date.slice(0, 7)] || null;
const bookingMonthText = (ch, dates) => {
  const ms = [...new Set(dates.map((d) => d.slice(0, 7)))].map((m) => ch.booking.months[m]).filter((m) => m && m.new_adr_30d != null && m.new_adr_30d_comp != null);
  return ms.map((m) => `Booking ${+m.month.slice(5)}月近30天新订 ADR ${thb(m.new_adr_30d)} vs 同类 ${thb(m.new_adr_30d_comp)}（${m.new_adr_30d >= m.new_adr_30d_comp ? "高" : "低"} ${Math.abs(Math.round((m.new_adr_30d / m.new_adr_30d_comp - 1) * 100))}%）`);
};

/** The brief. Pure: every number in it comes from the inputs. */
export function buildBrief({ market, prev = null, compare = null, events = null, opera = null, countries = null, countries_received_at = null, ideas = null,
  metrics = [], received_at = null, prev_received_at = null, today = bkkDay(), now = new Date().toISOString() }) {
  if (!market?.daily?.length) return { available: false, note: "No Lighthouse market delivery yet." };
  const days = mergeDays({ market, prev, opera, ideas, today });
  const ch = channelSignals(metrics);
  const byDate = new Map(days.map((d) => [d.date, d]));
  const changes = new Map((compare?.changes || []).map((c) => [c.stay_date, c]));
  const ideasNote = ideas ? `IDeaS ${ideas.snapshot_date} 快照` : null;
  const findings = [];
  const add = (f) => findings.push(f);
  const occ = (d) => (d.opera?.otb != null ? d.opera.otb / CAPACITY : d.my_otb);

  // A. Public channels show sold out while we still have rooms: restriction or closed channel → bookings lost.
  const closed = days.filter((d) => d.sold_out && occ(d) != null && occ(d) < 0.9);
  if (closed.length) {
    const unsold = closed.reduce((a, d) => a + (d.opera?.unsold ?? Math.round((1 - d.my_otb) * CAPACITY)), 0);
    const priced = closed.filter((d) => d.ideas?.bar != null && d.opera?.unsold != null);
    const value = priced.length ? priced.reduce((a, d) => a + d.ideas.bar * d.opera.unsold, 0) * 0.1 : null;
    const hi = closed.filter((d) => d.d >= 4).length;
    add({ id: "closed_out", kind: "closed_out", severity: 3, score: unsold >= 50 && hi ? 1000 + unsold / 10 : 50 + unsold / 10,
      dates: closed.map((d) => d.date), date_text: rangeText(closed.map((d) => d.date)),
      title: `${rangeText(closed.map((d) => d.date))} 公开渠道显示售罄，但酒店还有约 ${unsold} 间夜没卖`,
      evidence: [
        `Lighthouse：${closed.length} 天我们价位=Sold out；其中 ${hi} 天需求“高/很高”，竞品价位 ${lzs(closed.map((d) => d.comp_level))}`,
        `OPERA 在手 ${closed.map((d) => d.opera?.otb).filter((v) => v != null).length ? `${Math.min(...closed.map((d) => d.opera?.otb ?? 999))}–${Math.max(...closed.map((d) => d.opera?.otb ?? 0))}/${CAPACITY}` : `—`}（${pctRange(closed.map(occ))}）`,
        ...lostText(ch),
      ],
      channels: ["Booking", "Agoda", "携程"],
      action: "收益经理今天在 SynXis/渠道管理器逐日查这些日期在 Booking、Agoda、携程上的关房、最少入住天数(MinLOS)和 CTA：若是有意设的 MinLOS，确认 2–3 晚价格可订；若是误关或配额用完，按竞品档（很高）补开剩余房，不降价。",
      impact: value != null ? `假设补开后再卖出剩余 ${unsold} 间夜的 10%，按 ${ideasNote} BAR ≈ THB ${thb(value)}` : `剩余约 ${unsold} 间夜可卖`,
      watch: "明天 Lighthouse 这些日期不再显示 Sold out，OPERA 7 天 pickup 转正，Agoda/携程流失单数下降" });
  }

  // B. We sell below the compset's price level on dates with real demand: money left on the table.
  const under = days.filter((d) => !d.sold_out && d.m != null && d.c != null && d.d != null && (d.c - d.m >= 2 || (d.c - d.m >= 1 && d.d >= 4)));
  if (under.length) {
    const parts = ranges(under.map((d) => d.date)).map((r) => {
      const span = under.filter((d) => d.date >= r.from && d.date <= r.to);
      const gap = Math.max(...span.map((d) => d.c - d.m));
      return { span, gap, text: `${r.from === r.to ? md(r.from) : `${md(r.from)}–${md(r.to)}`}（低 ${gap} 档）` };
    }).sort((a, b) => b.gap * b.span.length - a.gap * a.span.length);
    const gap = Math.max(...parts.map((p) => p.gap));
    const unsold = under.reduce((a, d) => a + (d.opera?.unsold ?? 0), 0);
    const pick = under.reduce((a, d) => a + (d.opera?.pickup_7d ?? 0), 0);
    const perDay = under.filter((d) => d.ideas?.bar != null && d.my_price != null && d.opera?.unsold != null && d.ideas.bar > d.my_price);
    const uplift = perDay.reduce((a, d) => a + (d.ideas.bar - d.my_price) * d.opera.unsold, 0) * 0.3;
    const worst = parts[0].span;
    const minPrice = Math.min(...worst.map((d) => d.my_price ?? Infinity));
    const bars = worst.map((d) => d.ideas?.bar).filter((v) => v != null);
    const barGap = bars.length && Number.isFinite(minPrice) ? Math.min(...bars) - minPrice : null;
    add({ id: "underpriced", kind: "underpriced", severity: gap >= 2 ? 3 : 2, score: 300 + gap * 20 + under.length,
      dates: under.map((d) => d.date), date_text: rangeText(under.map((d) => d.date)),
      title: `${under.length} 天我们比竞品便宜、需求不弱：${parts.slice(0, 4).map((p) => p.text).join("、")}${parts.length > 4 ? " 等" : ""}`,
      evidence: [
        `Lighthouse ${parts[0].text.replace(/（.*/, "")}：我们 ${lzs(worst.map((d) => d.my_level))}（公开价 ${thb(minPrice)} 起），竞品 ${lzs(worst.map((d) => d.comp_level))}，需求 ${lzs(worst.map((d) => d.demand))}`,
        under.some((d) => d.opera) ? `OPERA 这些日期在手 ${pctRange(under.map(occ))}，近7天 pickup ${pick >= 0 ? "+" : ""}${pick} 间夜，还剩 ${unsold} 间夜` : null,
        barGap != null && barGap > 0 ? `公开最低价比 ${ideasNote} BAR ${thb(Math.min(...bars))} 低 ${thb(barGap)}（${Math.round(barGap / Math.min(...bars) * 100)}%）→ 很可能是渠道折扣叠加` : null,
        ...bookingMonthText(ch, under.map((d) => d.date)),
      ].filter(Boolean),
      channels: ["Booking", "Agoda"],
      action: `Booking/Agoda 先关掉这些日期叠加的折扣（移动价、Genius/VIP、限时促销），收益经理对照 IDeaS 把 BAR 调回竞品档；${pick > 0 ? "pickup 在涨，可以一步到位" : "pickup 平，分两步各涨一档，看 3 天"}。先做 ${parts[0].text.replace(/（.*/, "")}。`,
      impact: uplift > 0 ? `假设剩余房再卖出 30%，每间按 IDeaS BAR 收 ≈ 多收 THB ${thb(uplift)}` : "每间夜单价回到竞品档",
      watch: "Lighthouse 我们价位追上竞品档后，OPERA 7 天 pickup 不掉到负数" });
  }

  // C. We sit above the compset with weak demand and weak pickup: target the market that is searching, not a blanket cut.
  const over = days.filter((d) => !d.sold_out && d.m != null && d.c != null && d.m - d.c >= 1 && d.d != null && d.d <= 3
    && ((d.opera?.pickup_7d != null && d.opera.pickup_7d <= 0) || (d.my_otb != null && d.mkt_otb != null && d.my_otb <= d.mkt_otb + 0.02)));
  for (const r of ranges(over.map((d) => d.date))) {
    const span = over.filter((d) => d.date >= r.from && d.date <= r.to);
    const top = mode(span.map((d) => d.origin_hotel).filter(Boolean));
    const pick = span.reduce((a, d) => a + (d.opera?.pickup_7d ?? 0), 0);
    add({ id: `overpriced:${r.from}`, kind: "overpriced_weak", severity: 2, score: 40 + span.length * 3,
      dates: span.map((d) => d.date), date_text: rangeText(span.map((d) => d.date)),
      title: `${rangeText(span.map((d) => d.date))} 我们比竞品贵，需求一般、在手不领先`,
      evidence: [
        `Lighthouse：我们 ${lzs(span.map((d) => d.my_level))} vs 竞品 ${lzs(span.map((d) => d.comp_level))}，需求 ${lzs(span.map((d) => d.demand))}；我们在手 ${pct(Math.min(...span.map((d) => d.my_otb)))} vs 市场 ${pct(Math.max(...span.map((d) => d.mkt_otb)))}`,
        span.some((d) => d.opera) ? `OPERA 近7天 pickup ${pick >= 0 ? "+" : ""}${pick} 间夜` : null,
        top ? `这些天搜酒店最多的是 ${cname(top)}` : null,
      ].filter(Boolean),
      channels: top ? CHANNEL_OF(top) : ["Booking", "Agoda"],
      action: `不全盘降价：${top ? `在 ${CHANNEL_OF(top).join("/")}（${cname(top)}市场常用渠道，经验对应）` : "在 Booking/Agoda"}只对这些日期开定向促销或会员价（7–10%），其他日期不动。`,
      impact: "只让这几天的价格贴近竞品，不拉低其他日期",
      watch: "3 天内这些日期 OPERA pickup 转正；我们在手追上市场" });
  }

  // D. Compression: more of the market unavailable (or rising) → hold rate, stop discounts, use MinLOS.
  const comp = days.filter((d) => !d.sold_out && d.unavailable != null && (d.unavailable >= 0.15
    || (d.prev?.unavailable != null && d.unavailable - d.prev.unavailable >= 0.03)));
  if (comp.length) {
    const rising = comp.filter((d) => d.prev?.unavailable != null && d.unavailable - d.prev.unavailable >= 0.03);
    add({ id: "compression", kind: "compression", severity: 2, score: 50 + comp.length,
      dates: comp.map((d) => d.date), date_text: rangeText(comp.map((d) => d.date)),
      title: `${rangeText(comp.map((d) => d.date))} 竞品开始满房（不可订酒店 ${pctRange(comp.map((d) => d.unavailable))}）`,
      evidence: [
        `Lighthouse：不可订酒店占比 ≥15%${rising.length ? `；${rangeText(rising.map((d) => d.date))} 比上一份又升 ≥3pt` : ""}；竞品价位 ${lzs(comp.map((d) => d.comp_level))}`,
        comp.some((d) => d.opera) ? `OPERA 在手 ${pctRange(comp.map(occ))}` : null,
      ].filter(Boolean),
      channels: ["Booking", "Agoda", "携程", "Expedia"],
      action: "这些日期所有 OTA 停掉新促销、不接低价团队；收益经理考虑 2–3 晚 MinLOS，按竞品档守价。",
      impact: "竞品满房时需求会溢出到我们，守价比冲量多收", watch: "我们价位保持在竞品档，在手继续涨" });
  }

  // E. Pickup vs market (compare_market) and OPERA cancellations.
  const pickDays = days.filter((d) => changes.has(d.date)).map((d) => ({ d, c: changes.get(d.date) }));
  const marketUp = pickDays.filter(({ d, c }) => !d.sold_out && (c["Market OTB"] ?? 0) >= 0.015 && (c["My OTB"] ?? 0) <= 0);
  const myDown = pickDays.filter(({ c }) => (c["My OTB"] ?? 0) <= -0.02);
  const operaLoss = days.filter((d) => (d.opera?.pickup_7d ?? 0) <= -10);
  if (marketUp.length || myDown.length || operaLoss.length) {
    const ds = [...new Set([...marketUp, ...myDown].map((x) => x.d.date).concat(operaLoss.map((d) => d.date)))].sort();
    add({ id: "pickup", kind: "pickup", severity: myDown.length || operaLoss.length ? 2 : 1, score: 35 + ds.length,
      dates: ds, date_text: rangeText(ds), title: `${rangeText(ds)} 市场在涨我们没涨，或我们在掉单`,
      evidence: [
        marketUp.length ? `Lighthouse 日比：${rangeText(marketUp.map((x) => x.d.date))} 市场在手 +${(Math.max(...marketUp.map((x) => x.c["Market OTB"])) * 100).toFixed(1)}pt，我们 0 或下降` : null,
        myDown.length ? `我们在手下降：${myDown.map(({ d, c }) => `${md(d.date)} ${pt(c["My OTB"])}`).join("、")}` : null,
        operaLoss.length ? `OPERA 7 天净掉单：${operaLoss.map((d) => `${md(d.date)} ${d.opera.pickup_7d}`).join("、")}` : null,
      ].filter(Boolean),
      channels: ["Booking", "Agoda", "携程"],
      action: "收益/预订查这些日期的取消来源（哪个渠道、哪类价）；市场在涨而我们没开房的日期，先确认各渠道房态是开的。",
      impact: "把市场增长接住；掉单早发现早补", watch: "明天日比我们在手跟上市场" });
  }

  // F. Source markets: who is searching (Lighthouse) vs who is actually staying (OPERA month to date).
  const geo = market.geo || [];
  const search = geo.map((g) => ({ cc: g["Top 10 countries searching for hotels"], share: num(g["Top 10 countries searching for hotels % mix"]),
    los: num(g["Top 10 countries searching for hotels avg. LOS"]) })).filter((g) => g.cc);
  const flights = geo.map((g) => ({ cc: g["Top 10 countries searching for flights (Meta/OTA)"], share: num(g["Top 10 countries searching for flights (Meta/OTA) % mix"]),
    los: num(g["Top 10 countries searching for flights (Meta/OTA) avg. LOS"]) })).filter((g) => g.cc);
  const prevSearch = new Map((prev?.geo || []).map((g, i) => [g["Top 10 countries searching for hotels"], { rank: i + 1, share: num(g["Top 10 countries searching for hotels % mix"]) }]));
  const ours = new Map((countries || []).map((c) => [c.country, c]));
  const gaps = search.slice(0, 6).map((g) => ({ ...g, ours: ours.get(g.cc)?.share_pct ?? 0 }))
    .filter((g) => g.share != null && g.share * 100 >= 4 && g.ours < (g.share * 100) / 2);
  const shifts = search.map((g, i) => ({ ...g, rank: i + 1, before: prevSearch.get(g.cc) })).filter((g) => g.before && g.before.rank !== g.rank);
  const sp = market.stay_patterns || [];
  const longF = sp.find((x) => /8-14/.test(x["LOS bucket"] || ""));
  const oneH = sp.find((x) => /LOS 1$/.test(x["LOS bucket"] || ""));
  const longFlight = flights.filter((f) => f.los != null && f.los >= 9).slice(0, 3);
  if (gaps.length) {
    const g = gaps[0];
    add({ id: `market_gap:${g.cc}`, kind: "source_market", severity: 2, score: 45 + g.share * 100,
      dates: [], date_text: "未来 60 天",
      title: `${cname(g.cc)}客人搜得多、住得少：搜索占 ${pct(g.share, 1)}，本月入住只占 ${g.ours}%`,
      evidence: [
        `Lighthouse 酒店搜索客源前列：${search.slice(0, 5).map((x) => `${cname(x.cc)} ${pct(x.share, 1)}`).join("、")}`,
        countries?.length ? `OPERA 本月入住客源：${countries.slice(0, 5).map((c) => `${cname(c.country)} ${c.share_pct}%`).join("、")}` : "OPERA 客源国暂缺",
        ...gaps.slice(1, 3).map((x) => `${cname(x.cc)} 也偏低：搜索 ${pct(x.share, 1)} vs 入住 ${x.ours}%`),
      ],
      channels: CHANNEL_OF(g.cc),
      action: `在 ${CHANNEL_OF(g.cc).join("/")}（${cname(g.cc)}市场常用渠道，经验对应）给需求一般的日期做${cname(g.cc)}定向价或广告（例如 Agoda 国家定向折扣、Booking 国家价），先挑需求“偏高”且在手不领先的日期。`,
      impact: "把搜索量转成订单，不动其他市场价格", watch: `下周 OPERA ${cname(g.cc)} 本月间夜占比上升` });
  }
  if (longF && longF["LOS breakdown flights (Meta/OTA)"] >= 0.35 && longFlight.length) {
    add({ id: "long_stay", kind: "los", severity: 1, score: 30, dates: [], date_text: "未来 60 天",
      title: `机票搜索里 ${pct(longF["LOS breakdown flights (Meta/OTA)"])} 是 8–14 晚，长住客值得单独卖`,
      evidence: [
        `Lighthouse 停留模式：机票(Meta/OTA) 8–14 晚 ${pct(longF["LOS breakdown flights (Meta/OTA)"])}；酒店搜索 1 晚 ${pct(oneH?.["LOS breakdown hotels"])}`,
        `平均停留最长的客源：${longFlight.map((f) => `${cname(f.cc)} ${r1(f.los)} 晚`).join("、")}`,
      ],
      channels: ["Booking", "Expedia"],
      action: "Booking/Expedia 加 7 晚以上长住优惠（例如住 7 付 6 或 7 晚 9 折），只放在需求一般的日期；旺季日期不放。",
      impact: "提高平均停留、减少空档", watch: "Booking 平均停留天数（avg_los）上升" });
  }

  // G. Demand moves since the last delivery.
  const moves = [];
  for (const d of days) {
    const c = changes.get(d.date);
    const before = c ? lvl(c.demand_before) : d.prev?.d, after = d.d;
    if (before != null && after != null && before !== after) moves.push({ date: d.date, from: c?.demand_before ?? d.prev?.demand, to: d.demand, up: after > before, d });
  }
  const upMoves = moves.filter((x) => x.up);
  const upCheap = upMoves.filter((x) => !x.d.sold_out && x.d.m != null && x.d.c != null && x.d.m <= x.d.c);
  if (upCheap.length) {
    add({ id: "demand_up", kind: "demand_up", severity: 2, score: 55 + upCheap.length * 2,
      dates: upCheap.map((x) => x.date), date_text: rangeText(upCheap.map((x) => x.date)),
      title: `${rangeText(upCheap.map((x) => x.date))} 需求刚上调，我们价格没跟`,
      evidence: [`Lighthouse 日比：${upCheap.map((x) => `${md(x.date)} ${lz(x.from)}→${lz(x.to)}（我们 ${lz(x.d.my_level)} / 竞品 ${lz(x.d.comp_level)}）`).join("；")}`],
      channels: ["Booking", "Agoda"],
      action: "这些日期别再放新折扣；收益经理看 IDeaS 是否已经抬价，没抬就手动上调一档。",
      impact: "需求上来时先涨价", watch: "明天我们价位 ≥ 竞品档" });
  }

  // Windows: next 14 / 30 / 60 days.
  const windows = [14, 30, 60].map((n) => {
    const w = days.filter((d) => d.date < addDays(today, n));
    const count = (f) => w.filter(f).length;
    const avg = (k) => { const v = w.map((d) => d[k]).filter((x) => x != null); return v.length ? r3(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    const wm = moves.filter((x) => x.date < addDays(today, n));
    return { days: n, stay_dates: w.length,
      demand: { very_high: count((d) => d.d === 5), high: count((d) => d.d === 4), elevated: count((d) => d.d === 3), lower: count((d) => d.d != null && d.d <= 2) },
      demand_moves: { up: wm.filter((x) => x.up).length, down: wm.filter((x) => !x.up).length },
      sold_out: count((d) => d.sold_out), below_compset: count((d) => d.m != null && d.c != null && d.m < d.c), above_compset: count((d) => d.m != null && d.c != null && d.m > d.c),
      my_otb: avg("my_otb"), market_otb: avg("mkt_otb"), unavailable: avg("unavailable"),
      opera_pickup_7d: w.reduce((a, d) => a + (d.opera?.pickup_7d ?? 0), 0) };
  });

  // Events in the next 90 days with what Lighthouse shows for those dates.
  const evs = (events?.events || []).filter((e) => e["End date"] >= today && e["Start date"] < addDays(today, 90)).map((e) => {
    const d = byDate.get(e["Start date"]);
    return { name: e.Name, start: e["Start date"], end: e["End date"], category: e.Category || null, location: e.Location || null,
      demand: d?.demand ?? null, my_level: d?.my_level ?? null, comp_level: d?.comp_level ?? null, my_otb: d?.my_otb ?? null,
      opera_otb: d?.opera?.otb ?? null };
  });

  findings.sort((a, b) => b.score - a.score);
  const actions = findings.slice(0, 5).map(({ score, ...f }) => f);
  const w30 = windows[1];
  const headline = actions.length
    ? `${actions[0].title}。${actions[1] ? `其次：${actions[1].title}。` : ""}`
    : `未来 30 天需求 ${w30.demand.very_high + w30.demand.high} 天高位，价格与竞品基本对齐，今天不需要动价。`;

  const prevAt = prev_received_at || compare?.prior_received_at || null;
  return {
    available: true, version: BRIEF_VERSION, day: today, generated_at: now, received_at, previous_received_at: prevAt,
    sources: {
      lighthouse: received_at, lighthouse_previous: prevAt,
      opera_pace: opera?.received_at || null, opera_business_date: opera?.business_date || null,
      opera_countries: countries?.length ? countries_received_at : null,
      ideas_snapshot: ideas?.snapshot_date || null,
      channel_metrics_day: [...new Set(metrics.map((m) => m.day))].sort().at(-1) || null,
    },
    note: "Lighthouse 公开价是比价抓取的最低价，不是成交 ADR；“我们在手”= OPERA 在手/422。动价由收益经理在 SynXis/IDeaS 执行。渠道与客源国对应是经验规则。",
    headline, actions,
    windows,
    changes: {
      demand_moves: moves.map((x) => ({ date: x.date, from: x.from, to: x.to, up: x.up })),
      otb: pickDays.filter(({ c }) => (c["My OTB"] ?? 0) !== 0 || Math.abs(c["Market OTB"] ?? 0) >= 0.01)
        .map(({ d, c }) => ({ date: d.date, my_otb: c["My OTB"] ?? null, market_otb: c["Market OTB"] ?? null, my_price: c["My price"] ?? null })),
      unavailable: days.filter((d) => d.prev?.unavailable != null && Math.abs(d.unavailable - d.prev.unavailable) >= 0.02)
        .map((d) => ({ date: d.date, before: d.prev.unavailable, after: d.unavailable })),
      compset_level: days.filter((d) => d.prev?.c != null && d.c != null && d.prev.c !== d.c).map((d) => ({ date: d.date, from: d.prev.comp_level, to: d.comp_level })),
      source_rank: shifts.map((g) => ({ country: g.cc, rank: g.rank, before: g.before.rank })),
    },
    source_markets: {
      hotel_search: search.slice(0, 10).map((g) => ({ country: g.cc, name: cname(g.cc), share: r3(g.share), avg_los: r1(g.los), opera_mtd_share_pct: ours.get(g.cc)?.share_pct ?? null })),
      flight_search: flights.slice(0, 10).map((g) => ({ country: g.cc, name: cname(g.cc), share: r3(g.share), avg_los: r1(g.los) })),
      opera_mtd: (countries || []).slice(0, 8).map((c) => ({ country: c.country, name: cname(c.country), share_pct: c.share_pct, adr: c.adr })),
      stay_patterns: sp.map((x) => ({ bucket: x["LOS bucket"], flights: r3(num(x["LOS breakdown flights (Meta/OTA)"])), hotels: r3(num(x["LOS breakdown hotels"])) })),
    },
    events: evs,
    channels: { agoda: ch.agoda, ctrip: ch.ctrip, booking: { book_rate_30d: ch.booking.book_rate_30d, conversion_90d: ch.booking.conversion_90d } },
    strip: days.map((d) => ({ date: d.date, dow: d.dow, demand: d.demand, d: d.d, my_level: d.my_level, m: d.m, comp_level: d.comp_level, c: d.c,
      sold_out: d.sold_out, my_price: d.my_price, my_otb: d.my_otb, mkt_otb: d.mkt_otb, unavailable: d.unavailable, events: d.events,
      opera_otb: d.opera?.otb ?? null, pickup_7d: d.opera?.pickup_7d ?? null, bar: d.ideas?.bar ?? null,
      flags: findings.filter((f) => f.dates.includes(d.date)).map((f) => f.kind) })),
  };
}

function mode(list) {
  const c = new Map();
  for (const x of list) c.set(x, (c.get(x) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

/** Plain-text version for the agent's brief text and the copilot context. */
export function briefText(b) {
  if (!b?.available) return "";
  const lines = [`# Lighthouse × OTA 交叉判断（Lighthouse ${String(b.received_at || "").slice(0, 16)}；OPERA ${b.sources.opera_business_date || "—"}；${b.sources.ideas_snapshot ? `IDeaS ${b.sources.ideas_snapshot}` : "无 IDeaS"}）`,
    `结论：${b.headline}`];
  b.actions.forEach((a, i) => lines.push(`${i + 1}. [${a.channels.join("/")}] ${a.title}｜证据：${a.evidence.join("；")}｜动作：${a.action}｜影响：${a.impact}｜看：${a.watch}`));
  const w = b.windows;
  lines.push(`窗口：${w.map((x) => `${x.days}天 需求很高${x.demand.very_high}/高${x.demand.high}/偏高${x.demand.elevated}，售罄${x.sold_out}，低于竞品${x.below_compset}，我们在手${pct(x.my_otb)} vs 市场${pct(x.market_otb)}`).join("；")}`);
  if (b.events.length) lines.push(`活动：${b.events.slice(0, 6).map((e) => `${e.start} ${e.name}（需求${lz(e.demand)}，我们${lz(e.my_level)}，竞品${lz(e.comp_level)}）`).join("；")}`);
  lines.push(b.note, "");
  return lines.join("\n");
}

const all = async (stmt) => (await stmt.all()).results || [];

/** Assemble the inputs from D1 + the loaded state, build the brief. Returns {available:false} without a market view. */
export async function lighthouseBrief(db, state = {}, { now = Date.now(), opera = null } = {}) {
  const rows = await all(db.prepare("select view, received_at, body from lighthouse_views where view in ('market','events','compare_market')"));
  const v = Object.fromEntries(rows.map((r) => [r.view, { received_at: r.received_at, body: JSON.parse(r.body) }]));
  if (!v.market) return { available: false, note: "No Lighthouse market delivery yet." };
  const prevRow = await db.prepare("select received_at, body from lighthouse_market_history where received_at < ? order by received_at desc limit 1")
    .bind(v.market.received_at || "9999").first().catch(() => null);
  const snap = await db.prepare("select snapshot_date from ideas_snapshots order by snapshot_date desc limit 1").first().catch(() => null);
  let ideas = null;
  const today = bkkDay(now);
  if (snap && (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${snap.snapshot_date}T00:00:00Z`)) / 864e5 <= IDEAS_MAX_AGE_DAYS) {
    ideas = { snapshot_date: snap.snapshot_date, days: await all(db.prepare("select stay_date, bar, competitor_median, remaining from ideas_daily where snapshot_date = ? and stay_date >= ? order by stay_date limit 90")
      .bind(snap.snapshot_date, today)) };
  }
  return buildBrief({ market: v.market.body, prev: prevRow ? JSON.parse(prevRow.body) : null, prev_received_at: prevRow?.received_at || null,
    compare: v.compare_market?.body || null, events: v.events?.body || null, opera: opera?.pace || null, countries: opera?.countries || null,
    countries_received_at: opera?.countries_received_at || null, ideas,
    metrics: (state.metrics || []).filter((m) => ["booking", "agoda", "ctrip"].includes(m.platform)),
    received_at: v.market.received_at, today, now: new Date(now).toISOString() });
}

/** Keep one brief per Bangkok day (last computation of the day wins) and every distinct market delivery. */
export async function storeBrief(db, brief) {
  if (!brief?.available) return;
  await db.prepare(`insert into lighthouse_briefs (day, received_at, generated_at, body) values (?, ?, ?, ?)
    on conflict(day) do update set received_at = excluded.received_at, generated_at = excluded.generated_at, body = excluded.body`)
    .bind(brief.day, brief.received_at, brief.generated_at, JSON.stringify(brief)).run();
}

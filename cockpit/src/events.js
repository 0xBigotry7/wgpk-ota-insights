// Demand calendar for Phuket's source markets (IDeaS "special events"): when each peak starts, and by when an OTA
// campaign must be live, from how far ahead guests book (Booking booker insights: ours and the peer group's).
// Dates marked approx follow lunar or official calendars not yet announced: shown as "以官方公布为准".
import { bkkDay } from "./revenue.js";

export const EVENTS = [
  { id: "diwali-2026", name: "印度排灯节", markets: ["印度"], start: "2026-11-06", end: "2026-11-15", approx: true },
  { id: "xmas-ny-2026", name: "圣诞和新年旺季", markets: ["欧洲", "澳洲", "全市场"], start: "2026-12-20", end: "2027-01-05" },
  { id: "ru-ny-2027", name: "俄罗斯新年长假", markets: ["俄罗斯"], start: "2027-01-01", end: "2027-01-08" },
  { id: "cny-2027", name: "春节", markets: ["中国", "韩国", "新加坡", "马来西亚"], start: "2027-02-05", end: "2027-02-13", approx: true },
  { id: "easter-2027", name: "复活节假期", markets: ["澳洲", "欧洲"], start: "2027-03-26", end: "2027-04-05", approx: true },
  { id: "songkran-2027", name: "宋干节", markets: ["泰国", "全市场"], start: "2027-04-13", end: "2027-04-15" },
  { id: "may-2027", name: "五一和胜利日假期", markets: ["中国", "俄罗斯"], start: "2027-05-01", end: "2027-05-10", approx: true },
];

const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const between = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const SETUP_DAYS = 7;   // build, approve and load a campaign before guests start booking

/** Upcoming events with a "campaign live by" date and, when known, that stay month's pace. */
export function eventPlan(metrics = [], pace = null, today = bkkDay(), horizon = 200) {
  const latest = (metric) => metrics.filter((m) => m.platform === "booking" && m.metric === metric).sort((a, b) => a.day.localeCompare(b.day)).at(-1);
  const win = latest("book_window_days");
  const ours = win?.value ?? null, peer = win?.benchmark ?? null;
  // Campaigns must be live when the market starts booking, which is the earlier of our and the peers' window.
  const lead = Math.round(Math.max(ours || 0, peer || 0) || 30);
  const months = new Map((pace?.platforms || []).flatMap((p) => p.months.map((m) => [`${p.platform}|${m.month}`, m])));
  const events = EVENTS.filter((e) => e.end >= today && between(today, e.start) <= horizon).map((e) => {
    const liveBy = addDays(e.start, -lead), setupBy = addDays(liveBy, -SETUP_DAYS);
    const left = between(today, setupBy);
    const m = months.get(`booking|${e.start.slice(0, 7)}`);
    return { ...e, days_to_start: between(today, e.start), live_by: liveBy, setup_by: setupBy, days_to_setup: left,
      status: e.start <= today ? "now" : left < 0 ? (between(today, liveBy) < 0 ? "late" : "urgent") : left <= 14 ? "soon" : "later",
      month: m ? { label: m.label, gap: m.gap, adr_gap: m.booked_90d?.adr_gap ?? null, booked_90d: m.booked_90d?.room_nights ?? null } : null };
  });
  return { today, lead_days: lead, our_window: ours, peer_window: peer, window_day: win?.day || null, setup_days: SETUP_DAYS, events,
    note: `活动上线日 = 假期开始前 ${lead} 天（我们和同类客人的平均提前预订天数取较长的）；再提前 ${SETUP_DAYS} 天开始准备` };
}

/** Inbox alerts: an event whose campaign should be in preparation now. */
export function eventAlerts(plan) {
  const TITLE = {
    late: (e) => `${e.name}（${e.start.slice(5)} 起）的 OTA 活动按提前预订天数应在 ${e.live_by.slice(5)} 上线，已经晚了`,
    urgent: (e) => `${e.name}的 OTA 活动要在 ${e.live_by.slice(5)} 前上线，今天就该开始准备`,
    soon: (e) => `${e.days_to_setup} 天内要开始准备${e.name}的 OTA 活动`,
  };
  // A late event less than three weeks out is mostly booked by now: the timeline still shows it, the inbox does not.
  return plan.events.filter((e) => TITLE[e.status] && !(e.status === "late" && e.days_to_start < 21)).map((e) => ({
    id: `event:${e.id}`, level: e.status === "soon" ? "warning" : "serious", platform: "all", area: "price", owner: "收益/销售",
    title: TITLE[e.status](e),
    detail: `${e.markets.join("、")}客人 · ${e.start}–${e.end}${e.approx ? "（以官方公布为准）" : ""} · 活动最晚 ${e.live_by} 上线`
      + (e.month?.adr_gap != null ? ` · ${e.month.label}新订房价比同类 ${e.month.adr_gap >= 0 ? "高" : "低"} ${Math.abs(e.month.adr_gap).toFixed(0)}%` : ""),
    why: `同类酒店的客人平均提前 ${plan.peer_window ?? "—"} 天订，我们是 ${plan.our_window ?? "—"} 天：活动上线晚了，早订的客人已经订给别人`,
    action: `定下${e.name}期间的价格策略（对照 IDeaS 的 BAR），在 ${e.live_by} 前把 ${e.markets[0]}市场相关的活动和内容上线`,
    steps: ["对照 IDeaS 看这几天的预测入住率和 BAR：需求强就提价，不做深折扣",
      `针对${e.markets.join("、")}市场：Booking/Agoda 定向促销或国家价、携程上中文活动页`,
      "更新房源图片和文案，突出这个假期相关的卖点",
      "活动上线后在“调查与复查”里记下基线，两周后看这几天的在手和房价"],
    kpi: "假期期间在手间夜、房价与同类差距", eta: `${e.live_by} 前` }));
}

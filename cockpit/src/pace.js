// Booking pace by stay month (IDeaS-style pace/pickup), from platform pages that list each future stay month.
// - pace_room_nights | pace_revenue | pace_adr (period stay_YYYY-MM): all stays on the books for that month,
//   benchmark = same time last year on that page.
// - pickup_30d_* | pickup_90d_* (period stay_YYYY-MM): stays booked within the last 30/90 days, by stay month;
//   *_adr_comp is the page's peer-group ADR. Day-to-day diffs of these rolling windows are not pickup.
// Our pickup is the same platform + pace_ metric + stay month between two of our daily snapshots.
import { bkkDay } from "./revenue.js";

const NAMES = { booking: "Booking", agoda: "Agoda", ctrip: "携程", expedia: "Expedia" };
const ORDER = ["booking", "ctrip", "agoda", "expedia"];
const STAY = /^stay_(\d{4}-\d{2})$/;
const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? ((a - b) / b) * 100 : null);
const monthWord = (m) => `${+m.slice(5)}月`;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const monthsAhead = (from, m) => (+m.slice(0, 4) - +from.slice(0, 4)) * 12 + (+m.slice(5) - +from.slice(5, 7));
const STAY_DAY = /^stay_(\d{4}-\d{2}-\d{2})$/;
// Any per-stay pace row (month or date): these have their own views and alerts, not the generic trend loop.
export const isStayMonth = (m) => STAY.test(m.period || "") || STAY_DAY.test(m.period || "");

/** Change of one series from the latest snapshot back to the last snapshot on or before `back` days earlier. */
function pickup(rows, back) {
  const last = rows.at(-1);
  const cutoff = addDays(last.day, -back);
  const ref = [...rows].reverse().find((r) => r.day <= cutoff && r.day < last.day);
  return ref ? { value: last.value - ref.value, from: ref.day, to: last.day } : null;
}

export function paceView(metrics = [], today = bkkDay(), days = 14) {
  const series = {};
  for (const m of metrics) {
    const s = STAY.exec(m.period || "");
    if (!s || !/^(pace|pickup_\d+d)_/.test(m.metric)) continue;
    (series[`${m.platform}|${s[1]}|${m.metric}`] ||= []).push(m);
  }
  for (const rows of Object.values(series)) rows.sort((a, b) => a.day.localeCompare(b.day));
  const thisMonth = today.slice(0, 7);
  const sampleDays = Array.from({ length: days }, (_, i) => addDays(today, i - days + 1));
  const platforms = ORDER.map((platform) => {
    const months = [...new Set(Object.keys(series).filter((k) => k.startsWith(`${platform}|`)).map((k) => k.split("|")[1]))]
      .filter((m) => m >= thisMonth).sort();
    return { platform, name: NAMES[platform], months: months.map((month) => {
      const get = (metric) => series[`${platform}|${month}|${metric}`] || [];
      const rn = get("pace_room_nights"), cur = rn.at(-1), a = get("pace_adr").at(-1), r = get("pace_revenue").at(-1);
      const booked = (w) => {
        const n = get(`pickup_${w}_room_nights`).at(-1), adr = get(`pickup_${w}_adr`).at(-1), comp = get(`pickup_${w}_adr_comp`).at(-1);
        if (!n && !adr) return null;
        return { room_nights: n?.value ?? null, room_nights_ly: n?.benchmark ?? null, adr: adr?.value ?? null,
          adr_comp: comp && comp.day === adr?.day ? comp.value : null, adr_gap: comp && comp.day === adr?.day ? pct(adr.value, comp.value) : null,
          unit: adr?.unit || "", day: (n || adr).day, source_as_of: (n || adr).source_as_of || null };
      };
      // Daily change per sample day: that day's on-the-books reading minus the reading before it.
      const daily = sampleDays.map((day) => {
        const i = rn.findIndex((x) => x.day === day);
        return { day, value: i > 0 ? rn[i].value - rn[i - 1].value : null, from: i > 0 ? rn[i - 1].day : null };
      });
      const b30 = booked("30d"), b90 = booked("90d");
      return { month, label: monthWord(month), ahead: monthsAhead(today, month),
        day: cur?.day || b90?.day || b30?.day || null, source_as_of: cur?.source_as_of || b90?.source_as_of || null,
        room_nights: cur?.value ?? null, room_nights_ly: cur?.benchmark ?? null, gap: pct(cur?.value, cur?.benchmark),
        adr: a?.value ?? null, adr_ly: a?.benchmark ?? null, adr_gap: pct(a?.value, a?.benchmark), adr_unit: a?.unit || "",
        revenue: r?.value ?? null, revenue_ly: r?.benchmark ?? null, revenue_gap: pct(r?.value, r?.benchmark),
        booked_30d: b30, booked_90d: b90,
        pickup_1d: rn.length ? pickup(rn, 1) : null, pickup_7d: rn.length ? pickup(rn, 7) : null,
        daily: rn.length ? daily : null };
    }).filter((m) => m.room_nights != null || m.booked_30d || m.booked_90d) };
  }).filter((p) => p.months.length);
  return { platforms, sample_days: sampleDays, next_days: nextDays(metrics, today),
    note: "数字来自平台 pace 报表：在手和去年同期、新订房价和同类都取同一张表；每日新增是我们相邻两次采样之间同一入住月在手的变化" };
}

/** On the books per stay date for the next days (Booking's daily pace view), latest sample only. */
function nextDays(metrics, today) {
  const latest = {};
  for (const m of metrics) {
    const d = STAY_DAY.exec(m.period || "");
    if (!d || m.metric !== "pace_room_nights" || d[1] < today) continue;
    const k = `${m.platform}|${d[1]}`;
    if (!latest[k] || latest[k].day < m.day) latest[k] = { ...m, stay: d[1] };
  }
  const rows = Object.values(latest);
  const sample = rows.reduce((a, r) => (r.day > a ? r.day : a), "");
  return rows.filter((r) => r.day === sample).sort((a, b) => a.stay.localeCompare(b.stay) || a.platform.localeCompare(b.platform))
    .map((r) => ({ platform: r.platform, name: NAMES[r.platform] || r.platform, stay_date: r.stay, day: r.day,
      room_nights: r.value, room_nights_ly: r.benchmark ?? null, gap: pct(r.value, r.benchmark) }));
}

const fmtPct = (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}%`;

/** Alerts for the cockpit inbox: stay months that trail last year, months losing nights, and new bookings priced under peers. */
export function paceAlerts(view) {
  const out = [];
  for (const p of view.platforms) {
    // New bookings priced under the peer group, month by month: one alert for the platform, listing the months.
    const cheap = p.months.filter((m) => m.ahead <= 4 && m.booked_90d?.adr_gap != null && m.booked_90d.adr_gap <= -15
      && (m.booked_90d.room_nights ?? 0) >= 30);
    if (cheap.length) {
      const list = cheap.map((m) => `${m.label} ${Math.round(m.booked_90d.adr)} vs ${Math.round(m.booked_90d.adr_comp)}（${fmtPct(m.booked_90d.adr_gap)}）`);
      out.push({ id: `pace-rate:${p.platform}`, level: cheap.length >= 3 ? "serious" : "warning", platform: p.platform, area: "price",
        owner: "收益/销售", gap: Math.min(...cheap.map((m) => m.booked_90d.adr_gap)),
        title: `${p.name} ${cheap.map((m) => m.label).join("、")}的新订房价都比同类低 15% 以上`,
        detail: `近 90 天新订、按入住月：${list.join("；")} · ${cheap[0].booked_90d.day}`,
        why: "订单在进来，但每个旺季月都卖得比同类便宜一截：需求不缺，缺的是价格。IDeaS 的做法是需求强的日期先提价，而不是继续让利",
        action: `请收益经理对照 IDeaS 的 ${cheap.map((m) => m.label).join("、")} BAR，先挑新订最多的月份小步提价，7 天后看新订是否明显变少`,
        steps: ["在 IDeaS 看这些月份的预测入住率和 BAR，确认低价是不是有意为之",
          "检查 Booking 上是否有促销叠加（限时、Genius、移动价）把价格压低",
          "先对新订最多的月份提价或关掉一层折扣，在“调查与复查”里记下基线",
          "7 天后看这个月的近 30 天新订间夜和房价差距"],
        kpi: "各入住月新订房价与同类差距、新订间夜", eta: "1–2 周" });
    }
    for (const m of p.months) {
      if (m.ahead > 3 || m.room_nights == null) continue;
      const where = `${p.name} ${m.label}`;
      const detail = `在手 ${Math.round(m.room_nights)} 间夜，去年同期 ${m.room_nights_ly != null ? Math.round(m.room_nights_ly) : "—"}`
        + (m.adr_gap != null ? `；在手 ADR ${m.adr_gap >= 0 ? "高" : "低"} ${Math.abs(m.adr_gap).toFixed(0)}%` : "") + ` · ${m.day}`;
      const priceLed = m.adr_gap != null && m.adr_gap >= 15;
      if (m.gap != null && m.gap <= -10) {
        out.push({ id: `pace:${p.platform}:${m.month}`, level: m.gap <= -20 && m.ahead <= 2 ? "serious" : "warning",
          platform: p.platform, area: "price", owner: "收益/销售", gap: m.gap,
          title: `${where}在手间夜比去年同期少 ${Math.abs(m.gap).toFixed(0)}%${priceLed ? "，房价却高得多" : ""}`, detail,
          why: priceLed ? "量少价高：同期客人还在订，但我们这个月的价格比去年高出一截，可能把临近订单让给了竞品"
            : "这个入住月订得比去年慢，离入住越近，能补回来的时间越少",
          action: priceLed ? `请收益经理对照 IDeaS 看 ${m.label}的 BAR 是否有意偏高；不是有意的，先在 ${p.name} 对这个月开不降价的可见度工具`
            : `只针对 ${m.label}的入住日期做动作：先开可见度工具，再考虑定向促销`,
          steps: [`在 ${p.name} 后台按 ${m.label}入住日期核对价格和竞品价差`,
            "先用不降价的工具：可见度、会员价、移动端价、最少入住天数放宽",
            `仍落后再对 ${m.label}定向促销（只选这个月的入住日），并在“调查与复查”里记录基线`,
            "7 天后看这个月的新增和与去年的差距是否收窄"],
          kpi: `${m.label}在手间夜对比去年同期、每周新增`, eta: "1–2 周" });
      } else if (m.gap != null && m.gap >= 15) {
        out.push({ id: `win:pace:${p.platform}:${m.month}`, win: true, platform: p.platform, gap: m.gap,
          title: `${where}在手比去年同期多 ${m.gap.toFixed(0)}%`, detail });
      }
      if (m.pickup_7d && m.pickup_7d.value < 0 && m.ahead <= 2) {
        out.push({ id: `pickup:${p.platform}:${m.month}`, level: "warning", platform: p.platform, area: "price", owner: "收益/销售",
          gap: m.pickup_7d.value,
          title: `${where}一周净减少 ${Math.abs(Math.round(m.pickup_7d.value))} 间夜`,
          detail: `${m.pickup_7d.from} → ${m.pickup_7d.to}：取消多于新订`,
          why: "一周内这个月的在手反而减少，通常是团队或长住订单取消，或者近期新订停了",
          action: `看 ${p.name} 这周 ${m.label}入住的取消明细，确认是不是集中在某几天或某类房`,
          steps: ["按入住日期看这周的取消订单", "大单取消：联系客人或代理确认能否改期", "空出来的日期单独补可见度或定向促销"],
          kpi: `${m.label}每日新增`, eta: "本周" });
      }
    }
  }
  return out;
}

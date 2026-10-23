// Proactive checks over the stored numbers: where we trail the platform's own comparison value, what got worse
// since last week, which platform stopped giving data, what is waiting for a reply. Pure functions, so the page,
// the daily push and the copilot all work from the same list.

const LOWER_BETTER = /(^|_)(rank|problem|sort_order|response_hours|pending|had_problem)/;
export const lowerIsBetter = (metric) => LOWER_BETTER.test(metric);

// Mix and size numbers: not good or bad on their own.
const NEUTRAL = /^(lowest_rate|peer_group_size|compset_size|area_size|popularity_of|review_count|survey_count|leisure_share|todays_new_orders|pending_review_replies|availability_for_search)/;
const SCORE_UNIT = /^\/(5|10)$|^score/;

// Which team acts on a metric, and the first thing they should check. Order matters: first match wins.
const PLAYBOOK = [
  [/adr|revenue|room_nights|pace_/, "price", "收益/销售",
    "收益经理在 OPERA / SynXis 复核 BAR 和各渠道价差，按竞品组价格调整策略（不要直接在 OTA 后台改价）"],
  [/search_views|impressions|page_visits|page_views|visitors|sort_order|views_rank|popularity|referrals/, "traffic", "收益/销售",
    "检查可售率、各平台可见度项目（Genius / Preferred / Agoda VIP）和促销日历，判断要不要报名合适的促销"],
  [/click_rate|book_rate|conversion|booking_clicks/, "conversion", "市场/内容",
    "对照同类检查首图、房型照片、取消政策和价格展示，先改首图和前 5 张照片"],
  [/hvac|repairs|hot_water|internet/, "experience", "工程", "工程部按问题类型排查高发房间，列出本周维修清单"],
  [/clean|room_score|noise/, "experience", "客房", "客房部抽查近两周被投诉的房间，复核清洁检查表"],
  [/breakfast|fnb/, "experience", "餐饮", "餐饮部复盘早餐出品、补货节奏和高峰排班"],
  [/checkin|checkout|staff|rewards|exterior|service/, "experience", "前台",
    "前台复盘高峰排班和入住流程，入住时主动邀请客人加入温德姆会员"],
  [/page_score/, "content", "市场/内容", "按平台提示补齐房源页缺项（照片、设施、政策、房型描述）"],
  [/qa_replies/, "experience", "前台", "前台登录携程 ebooking 回复待回复问答"],
  [/score|rating|osat|nps|response|social/, "reputation", "总经理", "看最近差评的共同主题，指派对应部门整改并跟进（点评回复由点评系统自动处理）"],
];

export function playbook(metric) {
  const hit = PLAYBOOK.find(([re]) => re.test(metric));
  return hit ? { area: hit[1], owner: hit[2], action: hit[3] } : { area: "data", owner: "收益/销售", action: "核对数据来源页面" };
}

const PERIOD_WORDS = {
  last_30_days: "近 30 天", last_90_days: "近 90 天", last_28_days: "近 28 天", last_12_months: "近 12 个月",
  last_13_months: "近 13 个月", month_to_date: "本月至今", last_month: "上月", latest_month: "最近一个月",
  funnel: "排名看板", next_28_days: "未来 28 天", next_90_days: "未来 90 天",
  booked_last_30_days: "近 30 天新增", booked_last_90_days: "近 90 天新增",
};
export const NAMES = { booking: "Booking", agoda: "Agoda", expedia: "Expedia", ctrip: "携程", google: "Google",
  tripadvisor: "TripAdvisor", medallia: "Medallia" };

export function fmt(v, unit = "") {
  const n = Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : String(+Number(v).toFixed(2));
  return unit === "%" ? `${n}%` : unit && !unit.startsWith("/") ? `${n} ${unit}` : `${n}${unit}`;
}

// How far we are ahead of the comparison value, signed so that > 0 is always good.
// Percentages compare in points, scores and everything else in relative %.
export function peerGap(m) {
  if (m.benchmark == null || NEUTRAL.test(m.metric)) return null;
  let d;
  if (m.unit === "%") d = m.value - m.benchmark;
  else if (m.benchmark) d = ((m.value - m.benchmark) / Math.abs(m.benchmark)) * 100;
  else return null;
  return lowerIsBetter(m.metric) ? -d : d;
}

// Thresholds per unit kind: [warning, serious]. A win needs twice the warning step.
function steps(m) {
  if (m.unit === "%") return [1, 5];
  if (SCORE_UNIT.test(m.unit)) return [1, 4];
  return [8, 20];
}

// Medallia compares with the Wyndham brand average; the OTAs with a comp set they choose.
const peerWord = (m) => (m.platform === "medallia" ? "品牌均值" : "同类");
// Wording follows the raw numbers ("高" when our value is higher), whatever direction is good for the metric.
const gapText = (m, g) => {
  const raw = lowerIsBetter(m.metric) ? -g : g;
  return `比${peerWord(m)}${raw > 0 ? "高" : "低"} ${Math.abs(raw).toFixed(m.unit === "%" ? 1 : 1)}${m.unit === "%" ? " 个百分点" : "%"}`;
};
const LEVELS = { critical: 0, serious: 1, warning: 2, info: 3 };
const runDate = (id) => new Date(`${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(9, 11)}:${id.slice(11, 13)}:00+07:00`);

/** Latest point of each metric series, plus the series itself, keyed platform|metric@period. */
export function seriesOf(metrics) {
  const by = {};
  for (const m of metrics) (by[`${m.platform}|${m.metric}@${m.period || ""}`] ||= []).push(m);
  for (const rows of Object.values(by)) rows.sort((a, b) => a.day.localeCompare(b.day));
  return by;
}

export function monitor({ metrics = [], pages = [], runs = [] }, now = new Date()) {
  const alerts = [];
  const wins = [];
  const add = (a) => alerts.push(a);

  const last = runs[0];
  if (!last) {
    add({ id: "run:none", level: "critical", platform: "all", area: "data", owner: "收益/销售", title: "还没有任何采集记录",
      detail: "Mac mini 上的每日采集还没跑过", action: "确认 Mac mini 开机，采集任务每天 10:20 运行" });
  } else if (now - runDate(last.id) > 30 * 3600e3) {
    const hours = Math.round((now - runDate(last.id)) / 3600e3);
    add({ id: "run:stale", level: "critical", platform: "all", area: "data", owner: "收益/销售", title: `已经 ${hours} 小时没有新数据`,
      detail: `最近一次采集是 ${last.id}`, action: "确认酒店 Mac mini 开机联网；采集每天 10:20 运行，11:30 补跑一次" });
  }

  for (const p of pages) {
    if (p.status === "signed_out" && p.page === "landing") {
      add({ id: `page:${p.platform}:landing`, level: "serious", platform: p.platform, area: "data", owner: "收益/销售",
        title: `${NAMES[p.platform]} 后台未登录，今天没读到数据`, detail: p.detail || "",
        action: "点评系统 09:15 / 14:45 会自动登录；如果连续两天未登录，请人工在 Mac mini 的 Chrome 里登录一次" });
    }
  }

  const by = seriesOf(metrics);
  for (const [key, rows] of Object.entries(by)) {
    const m = { ...rows.at(-1) };
    m.label = m.label.replace(/^问题：(.+)$/, "$1问题占比");
    const plan = playbook(m.metric);
    const period = PERIOD_WORDS[m.period] ? `（${PERIOD_WORDS[m.period]}）` : "";

    // 1. Against the platform's own comparison value.
    const g = peerGap(m);
    if (g != null) {
      const [w, s] = steps(m);
      const base = { platform: m.platform, metric: key, area: plan.area, owner: plan.owner, gap: g,
        detail: `我们 ${fmt(m.value, m.unit)}，${peerWord(m)} ${fmt(m.benchmark, m.unit)}${period} · ${m.day}` };
      if (g <= -w) {
        add({ ...base, id: `gap:${key}`, level: g <= -s ? "serious" : "warning",
          title: `${NAMES[m.platform]} ${m.label}${gapText(m, g)}`, action: plan.action });
      } else if (g >= 2 * w) {
        wins.push({ ...base, id: `win:${key}`, title: `${NAMES[m.platform]} ${m.label}${gapText(m, g)}` });
      }
    }

    // 2. Against last week (or the previous reading for point-in-time numbers like a review score).
    if (rows.length > 1 && !NEUTRAL.test(m.metric)) {
      const cutoff = new Date(Date.parse(m.day) - 7 * 864e5).toISOString().slice(0, 10);
      const ref = m.period ? [...rows].reverse().find((r) => r.day <= cutoff) : rows.at(-2);
      if (ref && ref.value) {
        let d = m.unit === "%" ? m.value - ref.value : ((m.value - ref.value) / Math.abs(ref.value)) * 100;
        if (lowerIsBetter(m.metric)) d = -d;
        const isScore = SCORE_UNIT.test(m.unit);
        const bad = isScore ? m.value < ref.value - 0.05 && !lowerIsBetter(m.metric) : d <= (m.unit === "%" ? -1 : -10);
        if (bad) {
          add({ id: `drop:${key}`, level: d <= -25 || (isScore && d <= -2) ? "serious" : "warning", platform: m.platform, metric: key,
            area: plan.area, owner: plan.owner, gap: d,
            title: `${NAMES[m.platform]} ${m.label}${isScore ? "下降" : `较 ${ref.day.slice(5)} 下降 ${Math.abs(d).toFixed(1)}${m.unit === "%" ? " 个百分点" : "%"}`}`,
            detail: `${ref.day} ${fmt(ref.value, m.unit)} → ${m.day} ${fmt(m.value, m.unit)}`, action: plan.action });
        }
      }
    }

    // 3. Work waiting on a person.
    if (/qa_replies/.test(m.metric) && m.value > 0) {
      add({ id: `todo:${key}`, level: "warning", platform: m.platform, metric: key, area: plan.area, owner: plan.owner,
        title: `${NAMES[m.platform]} 有 ${m.value} 条${m.label.replace("待回复", "")}待回复`, detail: `${m.day} 读取`, action: plan.action });
    }
  }

  // 4. Ranks in the bottom half of their group.
  const RANKS = [["booking", "compset_views_rank@last_90_days", "compset_size@last_90_days", "竞品组曝光排名"],
    ["booking", "area_views_rank@last_90_days", "area_size@last_90_days", "区域曝光排名"],
    ["tripadvisor", "popularity_rank@", "popularity_of@", "TripAdvisor 当地排名"]];
  for (const [pf, rk, sz, label] of RANKS) {
    const r = by[`${pf}|${rk}`]?.at(-1), n = by[`${pf}|${sz}`]?.at(-1);
    if (!r || !n || !n.value) continue;
    const plan = playbook(rk);
    const base = { platform: pf, metric: `${pf}|${rk}`, area: plan.area, owner: plan.owner, detail: `第 ${r.value} / ${n.value} · ${r.day}` };
    if (r.value > n.value / 2) {
      add({ ...base, id: `rank:${pf}|${rk}`, level: "warning", title: `${label}在后半段：${r.value} / ${n.value}`, action: plan.action });
    } else if (r.value <= Math.max(1, n.value / 5)) {
      wins.push({ ...base, id: `win:${pf}|${rk}`, title: `${label}第 ${r.value} / ${n.value}` });
    }
  }

  // One line per metric family: this month's ADR gap makes last month's redundant.
  const family = (x) => (x.metric == null ? x.id : `${x.id.split(":")[0]}:${String(x.metric).replace(/_(mtd|last_month|latest_month|\d+[dm])(@.*)?$|@.*$/, "")}`);
  const current = (x) => (/last_month/.test(x.metric) ? 1 : 0);
  const dedupe = (list) => {
    const best = {};
    for (const x of list) {
      const f = family(x);
      if (!(f in best) || current(x) < current(best[f])) best[f] = x;
    }
    return list.filter((x) => best[family(x)] === x);
  };
  const order = (a, b) => LEVELS[a.level] - LEVELS[b.level] || Math.abs(b.gap || 0) - Math.abs(a.gap || 0);
  return { alerts: dedupe(alerts).sort(order).slice(0, 20), wins: dedupe(wins).sort((a, b) => (b.gap || 0) - (a.gap || 0)).slice(0, 8) };
}

/** The daily push: short enough for a phone notification, newest problems first. */
export function digest({ alerts, wins }, report, url) {
  const icon = { critical: "🔴", serious: "🟠", warning: "🟡", info: "🔵" };
  const lines = [`OTA 驾驶舱 · ${new Date().toISOString().slice(0, 10)}`];
  if (report?.summary) lines.push("", report.summary);
  const top = alerts.filter((a) => a.level !== "info").slice(0, 6);
  if (top.length) lines.push("", `需要处理（${alerts.length}）`, ...top.map((a) => `${icon[a.level]} ${a.title}`));
  if (wins.length) lines.push("", "做得好", ...wins.slice(0, 3).map((w) => `🟢 ${w.title}`));
  lines.push("", url);
  return lines.join("\n");
}

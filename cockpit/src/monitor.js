// Proactive checks over the stored numbers: where we trail the platform's own comparison value, what got worse
// since last week, which platform stopped giving data, what is waiting for a reply. Pure functions, so the page,
// the daily push and the copilot all work from the same list.

import { season } from "./knowledge.js";

const LOWER_BETTER = /(^|_)(rank|problem|sort_order|response_hours|pending|had_problem)/;
export const lowerIsBetter = (metric) => LOWER_BETTER.test(metric);

// Mix and size numbers: not good or bad on their own.
const NEUTRAL = /^(lowest_rate|peer_group_size|compset_size|area_size|popularity_of|review_count|survey_count|leisure_share|todays_new_orders|pending_review_replies|availability_for_search)/;
const SCORE_UNIT = /^\/(5|10)$|^score/;

// Which team acts on a metric, why it matters and what to do, from the OTA knowledge in knowledge.js.
// Order matters: first match wins. `action` is the one-line version used in to-dos and the daily push.
const PLAYBOOK = [
  { re: /adr|revenue|room_nights|pace_/, area: "price", owner: "收益/销售",
    why: "价格比同类低很多时，多卖的间夜往往补不回少收的房价；2026 年普吉是靠价格增长的市场",
    steps: ["收益经理在 OPERA / SynXis 按日期看 BAR 与竞品组价差（不要直接在 OTA 后台改价）",
      "先提高需求日期（周末、节假日、在手已高的日期）5–10%，低需求日期保持",
      "检查 Genius、移动价、国家价等折扣叠加后的最终价，去掉重复折扣"],
    kpi: "ADR 与同类差距、转化率不明显下降", eta: "1–2 周" },
  { re: /search_views|impressions|page_visits|page_views|visitors|sort_order|views_rank|popularity|referrals/, area: "traffic", owner: "收益/销售",
    why: "曝光由可售房、价格竞争力、点评分和可见度项目决定；没被看到就没有后面的点击和预订",
    steps: ["确认未来 90 天每个日期都有房可卖、没有断档", "对比竞品组价格，价格明显高的日期先调整",
      "评估可见度项目：Booking Genius / Preferred / Visibility Booster，Agoda AGX，Expedia Accelerator（只投低入住日期）"],
    kpi: "搜索曝光较同类、竞品组曝光排名", eta: "2–4 周" },
  { re: /click_rate|booking_clicks/, area: "conversion", owner: "市场/内容",
    why: "点击率看列表页那一眼：首图、列表价、评分和标签",
    steps: ["把首图换成最能代表卖点的照片（泳池、海景、家庭场景），各平台统一", "检查列表页显示的最终价是否比竞品贵",
      "确认评分和标签（Genius、早餐、免费取消）在列表页显示"],
    kpi: "曝光 → 访问点击率", eta: "1–2 周" },
  { re: /book_rate|conversion/, area: "conversion", owner: "市场/内容",
    why: "进了房源页却不订，多半是房型照片和说明不清、价格或取消政策不如别家",
    steps: ["每个房型至少 5 张清晰照片，写清面积、床型、景观、是否有阳台", "提供含早和可免费取消的价型",
      "查各渠道价格是否一致（比官网或别家贵会掉转化）"],
    kpi: "访问 → 预订转化率", eta: "1–3 周" },
  { re: /hvac|repairs|hot_water|internet/, area: "experience", owner: "工程",
    why: "设施问题直接拉低点评分，而点评分是各平台排名的核心",
    steps: ["按问题类型列出近两周投诉的房号", "本周完成维修并复查", "高发房间暂缓售卖或降级安排"],
    kpi: "对应问题占比、新点评里的提及次数", eta: "2–4 周" },
  { re: /clean|room_score|noise/, area: "experience", owner: "客房",
    why: "清洁和噪音是差评最常见的主题之一",
    steps: ["抽查近两周被投诉的房间", "复核清洁检查表和查房流程", "朝路一侧房间优先安排给不在意噪音的客人"],
    kpi: "对应问题占比", eta: "2–4 周" },
  { re: /breakfast|fnb/, area: "experience", owner: "餐饮",
    why: "只有一个约 100 座的餐厅，旺季早餐高峰最容易出问题",
    steps: ["复盘早餐高峰时段的排队和补货", "旺季启用二楼多功能厅和三楼餐厅分流", "核对出品和补货节奏"],
    kpi: "早餐 / 餐饮评分和问题占比", eta: "2–4 周" },
  { re: /checkin|checkout|staff|exterior|service/, area: "experience", owner: "前台",
    why: "入住是第一印象，排队和等房最容易变成差评",
    steps: ["14:00–17:00 入住高峰加人，提前准备房卡", "OTA 客人提前核对特殊要求", "早到客人提供寄存和欢迎饮品"],
    kpi: "入住问题占比、入住评分", eta: "2–4 周" },
  { re: /rewards/, area: "experience", owner: "前台",
    why: "会员占比高，复购和直订就多，OTA 佣金就少",
    steps: ["入住时主动邀请入会，说明会员价和积分", "前台和官网突出会员价", "每周看邀请入会比例"],
    kpi: "会员占比、入住时邀请入会比例", eta: "1–2 个月" },
  { re: /page_score/, area: "content", owner: "市场/内容",
    why: "房源页缺项会影响排名，政策字段空着还会掉出筛选结果",
    steps: ["打开各平台的内容分或完整度页面", "补齐照片、设施、政策、房型描述", "首图和房型照片各平台统一"],
    kpi: "房源页完整度 / 内容分", eta: "1–2 周" },
  { re: /qa_replies/, area: "experience", owner: "前台",
    why: "问答回复速度计入携程服务质量分",
    steps: ["前台登录携程 ebooking 回复待回复问答", "常见问题整理成标准答案"], kpi: "待回复问答为 0", eta: "当天" },
  { re: /score|rating|osat|nps|response|social/, area: "reputation", owner: "总经理",
    why: "点评分是各平台排名和转化的核心（Booking 8 分以上曝光稳定，携程 4.7 分以上有“超棒”标签）",
    steps: ["看最近差评的共同主题", "指派对应部门整改并在一周后复查", "点评回复由点评系统自动处理，这里只管整改"],
    kpi: "点评分、新点评里的主题", eta: "1–2 个月" },
];

export function playbook(metric) {
  const hit = PLAYBOOK.find((p) => p.re.test(metric));
  if (!hit) return { area: "data", owner: "收益/销售", action: "核对数据来源页面", why: "", steps: [], kpi: "", eta: "" };
  const { re: _re, ...rest } = hit;
  return { ...rest, action: hit.steps[0] };
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
const how = (plan) => ({ action: plan.action, why: plan.why, steps: plan.steps, kpi: plan.kpi, eta: plan.eta });
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
        action: "点评系统 09:15 / 14:45 会自动登录；如果连续两天未登录，请人工在 Mac mini 的 Chrome 里登录一次",
        why: "没登录就读不到这个平台当天的数字，预警和报告会缺这一块",
        steps: ["等点评系统下一次自动登录（09:15 / 14:45）", "连续两天未登录：在酒店 Mac mini 的 Chrome 里人工登录一次",
          "需要短信或邮箱验证码的平台，找持有手机的同事配合"], kpi: "平台连接状态变绿", eta: "当天" });
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
          title: `${NAMES[m.platform]} ${m.label}${gapText(m, g)}`, ...how(plan) });
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
            detail: `${ref.day} ${fmt(ref.value, m.unit)} → ${m.day} ${fmt(m.value, m.unit)}`, ...how(plan) });
        }
      }
    }

    // 3. Work waiting on a person.
    if (/qa_replies/.test(m.metric) && m.value > 0) {
      add({ id: `todo:${key}`, level: "warning", platform: m.platform, metric: key, area: plan.area, owner: plan.owner,
        title: `${NAMES[m.platform]} 有 ${m.value} 条${m.label.replace("待回复", "")}待回复`, detail: `${m.day} 读取`, ...how(plan) });
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
      add({ ...base, id: `rank:${pf}|${rk}`, level: "warning", title: `${label}在后半段：${r.value} / ${n.value}`, ...how(plan) });
    } else if (r.value <= Math.max(1, n.value / 5)) {
      wins.push({ ...base, id: `win:${pf}|${rk}`, title: `${label}第 ${r.value} / ${n.value}` });
    }
  }

  // 5. Diagnoses from the OTA playbook (knowledge.js): patterns a single gap does not show.
  const cur = (k) => by[k]?.at(-1);
  const suppress = new Set();
  const diag = (a) => add({ area: "price", owner: "收益/销售", ...a });

  // Rate-led volume: more room nights than the comp set at a much lower ADR (MPI-like high, ARI-like low).
  for (const [suffix, words] of [["mtd@month_to_date", "本月至今"], ["30d@last_30_days", "近 30 天"], ["90d@last_90_days", "近 90 天"]]) {
    const adr = cur(`booking|adr_${suffix}`), rn = cur(`booking|room_nights_${suffix}`);
    if (!adr || !rn || !adr.benchmark || !rn.benchmark) continue;
    const ari = (adr.value / adr.benchmark) * 100, mpi = (rn.value / rn.benchmark) * 100;
    if (ari < 90 && mpi > 105) {
      diag({ id: "diag:booking:rate-led", level: "serious", platform: "booking", metric: `booking|adr_${suffix}`, gap: ari - 100,
        title: `Booking 量高价低：间夜是同类的 ${Math.round(mpi)}%，房价只有同类的 ${Math.round(ari)}%`,
        detail: `${words}间夜 ${fmt(rn.value)} 对 ${fmt(rn.benchmark)}，ADR ${fmt(adr.value, "THB")} 对 ${fmt(adr.benchmark, "THB")} · ${adr.day}`,
        why: "多卖的间夜补不回少收的房价，常见原因是折扣叠加（Genius + 移动价 + 国家价 + Flash Sale）；10 月是旺季前爬坡，正是收紧折扣的时候",
        steps: ["在 Booking 后台“优惠”页列出所有在线促销，看叠加后的最终价，砍掉重复的（先看 Flash Sale SBKFS）",
          "收益经理在 OPERA / SynXis 把 12 月下旬到 1 月初和周末的 BAR 提 5–10%",
          "一周后看转化率和在手订单速度，没明显下滑再继续提"],
        kpi: "ADR 与同类差距（目标先缩到 -10% 以内）、转化率、pace", eta: "1–2 周",
        action: "盘点 Booking 在线促销并砍掉重复折扣，收益经理在 OPERA / SynXis 提高需求日期 BAR" });
      suppress.add("gap:booking|adr_");
      break;
    }
  }

  // Funnel: seen more than peers but clicked less → the list view (photo, price, score), not visibility.
  const views = cur("booking|search_views_vs_peer@funnel"), ctr = cur("booking|click_rate@funnel");
  if (views && ctr && ctr.benchmark != null && ctr.value < ctr.benchmark && views.value > 0) {
    const plan = playbook("click_rate");
    diag({ id: "diag:booking:list-view", level: "serious", platform: "booking", metric: "booking|click_rate@funnel", area: "conversion",
      owner: plan.owner, gap: ctr.value - ctr.benchmark,
      title: `Booking 被看到的比同类多 ${fmt(views.value, "%")}，点进来的却更少`,
      detail: `点击率 ${fmt(ctr.value, "%")}，同类 ${fmt(ctr.benchmark, "%")} · ${ctr.day}`,
      why: "曝光已经够了，问题在搜索列表那一眼：首图、列表价、评分和标签",
      steps: plan.steps, kpi: plan.kpi, eta: plan.eta, action: plan.action });
    suppress.add("gap:booking|click_rate");
  } else if (views && views.value < -10) {
    const plan = playbook("search_views");
    diag({ id: "diag:booking:visibility", level: "warning", platform: "booking", metric: "booking|search_views_vs_peer@funnel", area: "traffic",
      gap: views.value, title: `Booking 搜索曝光比同类少 ${fmt(Math.abs(views.value), "%")}`, detail: views.day, ...how(plan) });
  }

  // Platform thresholds that change what a guest sees or what we qualify for.
  const thresholds = [
    ["booking|review_score@", (v) => v < 7.5 ? "serious" : v < 8 ? "warning" : null, "reputation",
      (v) => `Booking 点评分 ${v}：${v < 7.5 ? "低于 Genius 门槛 7.5" : "低于 8 分，曝光开始受限"}`],
    ["ctrip|review_score@", (v) => v < 4.7 ? "warning" : null, "reputation", (v) => `携程点评分 ${v}，低于“超棒”标签门槛 4.7`],
    ["booking|property_page_score@", (v) => v < 100 ? "warning" : null, "content", (v) => `Booking 房源页完整度 ${v}%，未满分`],
    ["booking|availability_for_search@funnel", (v) => v < 90 ? "warning" : null, "traffic",
      (v) => `Booking 可售率 ${v}%：可售是排名第一因素`],
    ["medallia|rapid_response_hours@last_12_months", (v) => v > 48 ? "warning" : null, "reputation",
      (v) => `Medallia 问卷快速回复平均要 ${Math.round(v)} 小时`],
  ];
  for (const [k, level, area, title] of thresholds) {
    const m = cur(k);
    const lv = m && level(m.value);
    if (!lv) continue;
    const plan = playbook(k.split("|")[1].split("@")[0]);
    add({ id: `rule:${k}`, level: lv, platform: m.platform, metric: k, area, owner: plan.owner, title: title(m.value),
      detail: m.day, ...how(plan) });
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
  // Diagnoses explain several numbers at once, so they lead their level.
  const order = (a, b) => LEVELS[a.level] - LEVELS[b.level] || (b.id.startsWith("diag:") - a.id.startsWith("diag:")) || Math.abs(b.gap || 0) - Math.abs(a.gap || 0);
  const kept = alerts.filter((a) => ![...suppress].some((p) => a.id.startsWith(p)));
  return { season: season(now.getUTCMonth() + 1), alerts: dedupe(kept).sort(order).slice(0, 20), wins: dedupe(wins).sort((a, b) => (b.gap || 0) - (a.gap || 0)).slice(0, 8) };
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

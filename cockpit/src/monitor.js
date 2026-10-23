// Proactive checks over the stored numbers: where we trail the platform's own comparison value, what got worse
// since last week, which platform stopped giving data, what is waiting for a reply. Pure functions, so the page,
// the daily push and the copilot all work from the same list.

import { season } from "./knowledge.js";

const LOWER_BETTER = /(^|_)(rank|problem|sort_order|response_hours|pending|had_problem|cancellation|lost)/;
export const lowerIsBetter = (metric) => LOWER_BETTER.test(metric);

// Mix and size numbers: not good or bad on their own.
const NEUTRAL = /^(book_window_days|avg_los|business_share|lowest_rate|peer_group_size|compset_size|area_size|popularity_of|review_count|survey_count|leisure_share|todays_new_orders|pending_review_replies|availability_for_search)/;
const SCORE_UNIT = /^\/(5|10)$|^score/;

// Which team acts on a metric, why it matters and what to do, from the OTA knowledge in knowledge.js.
// Order matters: first match wins. `action` is the one-line version used in to-dos and the daily push.
const PLAYBOOK = [
  { re: /cancellation/, area: "price", owner: "收益/销售",
    why: "取消率偏高需要按入住日、来源市场与提前期分层核对，不能单凭汇总值推断原因",
    steps: ["收益经理核对可取消与不可取消价型的净收入和实际洗房量，先提交政策方案",
      "前台按现有政策核对临近入住的确认状态；不得仅因推测取消而释放已订房",
      "看 Booking 客源分析里取消率高的来源市场和提前期，针对性收紧政策"],
    kpi: "取消率较同类、临近入住的空房", eta: "2–4 周" },
  { re: /lost/, area: "price", owner: "收益/销售",
    why: "客人看过我们最后订了别家，通常是同日期价格或价型（含早、免费取消）不如竞品",
    steps: ["在 Agoda 分析中心“流失预订”页看流失到哪家、哪些入住日期、差价多少",
      "差价集中的日期，由收益经理在 OPERA / SynXis 调整，不在 Agoda 后台直接改价",
      "检查 Agoda 上是否缺含早或免费取消的价型"],
    kpi: "流失预订数", eta: "1–2 周" },
  { re: /adr|revenue|room_nights|pace_/, area: "price", owner: "收益/销售",
    why: "ADR 与同类的差距只代表平台汇总信号；房型、入住日、渠道结构和净佣金可能不同",
    steps: ["收益经理在 OPERA / SynXis 按日期看 BAR 与竞品组价差（不要直接在 OTA 后台改价）",
      "核对逐入住日的在手、可售库存和可比价型；没有这些证据时不建议具体调价幅度",
      "盘点 Genius、移动价、国家价等折扣的适用范围、叠加后净收入，提交人工评估"],
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
    steps: ["核对酒店当前会员政策，再向客人说明已确认的权益，不承诺未确认的积分", "前台和官网突出会员价", "每周看邀请入会比例"],
    kpi: "会员占比、入住时邀请入会比例", eta: "1–2 个月" },
  { re: /page_score/, area: "content", owner: "市场/内容",
    why: "房源页缺项会影响排名，政策字段空着还会掉出筛选结果",
    steps: ["打开各平台的内容分或完整度页面", "补齐照片、设施、政策、房型描述", "首图和房型照片各平台统一"],
    kpi: "房源页完整度 / 内容分", eta: "1–2 周" },
  { re: /qa_replies/, area: "experience", owner: "前台",
    why: "问答回复速度计入携程服务质量分",
    steps: ["前台登录携程 ebooking 回复待回复问答", "常见问题整理成标准答案"], kpi: "待回复问答为 0", eta: "当天" },
  { re: /score|rating|osat|nps|response|social/, area: "reputation", owner: "总经理",
    why: "评分与客人选择有关；具体排名权重和项目门槛须以当前平台后台为准",
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
const peerWord = (m) => (m.platform === "medallia" ? "品牌均值" : /^(otb|stayed)_/.test(m.metric) ? "去年同期" : "同类");
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

const PLATFORM_ORDER = Object.keys(NAMES);
const bkkDay = (d) => new Date(d.getTime() + 7 * 3600e3).toISOString().slice(0, 10);
const dayOfRun = (id) => `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`;

/**
 * How dependable the data is: per platform and Bangkok day, whether the collector got in and how many pages it
 * read; the last day each platform gave numbers; and how many of the metric series we normally get came in on
 * the latest day. `history` is page_status rows of recent runs ({run_id, platform, page, status}).
 */
export function health({ metrics = [], runs = [], history = [] }, now = new Date(), days = 14) {
  const today = bkkDay(now);
  const span = Array.from({ length: days }, (_, i) => bkkDay(new Date(Date.parse(`${today}T12:00:00+07:00`) - (days - 1 - i) * 864e5)));
  // The last run of each day that read the platform decides that day's cell.
  const runOf = {};
  for (const r of history) {
    const k = `${r.platform}|${dayOfRun(r.run_id)}`;
    if (!runOf[k] || r.run_id > runOf[k]) runOf[k] = r.run_id;
  }
  const lastData = {};
  for (const m of metrics) if (!lastData[m.platform] || m.day > lastData[m.platform]) lastData[m.platform] = m.day;
  const ago = (d) => (d ? Math.round((Date.parse(today) - Date.parse(d)) / 864e5) : null);

  const platforms = PLATFORM_ORDER.map((p) => {
    const cells = span.map((day) => {
      const run = runOf[`${p}|${day}`];
      if (!run) return { day, state: "none", ok: 0, total: 0 };
      const rows = history.filter((r) => r.run_id === run && r.platform === p);
      const ok = rows.filter((r) => r.status === "ok").length;
      const landing = rows.find((r) => r.page === "landing");
      const state = landing && landing.status === "signed_out" ? "signed_out" : ok === rows.length ? "ok" : ok ? "partial" : "failed";
      return { day, state, ok, total: rows.length, run };
    });
    let streak = 0;
    for (const c of [...cells].reverse()) {
      if (c.state === "none" && c.day === today && !streak) continue;   // today's run may not have happened yet
      if (c.state !== "signed_out") break;
      streak += 1;
    }
    return { platform: p, cells, last_data: lastData[p] || null, days_since_data: ago(lastData[p]), signed_out_days: streak };
  });

  // Coverage: series seen in the window vs series that came in on the latest data day.
  const since = span[0];
  const seen = {}, latest = metrics.reduce((d, m) => (m.day > d ? m.day : d), "");
  for (const m of metrics) {
    if (m.day < since) continue;
    const k = `${m.platform}|${m.metric}@${m.period || ""}`;
    const s = (seen[k] ||= { platform: m.platform, label: m.label, last: m.day });
    if (m.day > s.last) s.last = m.day;
  }
  const all = Object.values(seen);
  const missing = {};
  for (const s of all) if (s.last < latest) (missing[s.platform] ||= []).push(s.label);
  const good = runs.filter((r) => !r.outcome || r.outcome === "done");
  const scheduled = good.filter((r) => dayOfRun(r.id) >= since && /^(1020|1130)/.test(r.id.slice(9)));
  return {
    days: span, platforms, latest_day: latest || null,
    coverage: { got: all.length - Object.values(missing).flat().length, expected: all.length,
      missing: Object.entries(missing).map(([platform, labels]) => ({ platform, count: labels.length, labels: labels.slice(0, 6) })) },
    runs: { total: runs.filter((r) => dayOfRun(r.id) >= since).length, scheduled: scheduled.length,
      days_with_run: new Set(good.map((r) => dayOfRun(r.id)).filter((d) => d >= since)).size,
      not_done: runs.filter((r) => dayOfRun(r.id) >= since && r.outcome && r.outcome !== "done").length },
  };
}

export function monitor({ metrics = [], pages = [], runs = [], history = [] }, now = new Date()) {
  const alerts = [];
  const wins = [];
  const add = (a) => alerts.push(a);

  // A skipped or failed run is proof the collector is alive, not fresh data.
  const last = runs.find((r) => !r.outcome || r.outcome === "done");
  const blocked = runs[0] && runs[0] !== last && runs[0].outcome !== "done" ? runs[0] : null;
  if (blocked) {
    add({ id: `run:${blocked.outcome}`, level: "serious", platform: "all", area: "data", owner: "收益/销售",
      title: blocked.outcome === "skipped" ? "最近一次采集被跳过" : `最近一次采集没跑完（${blocked.outcome}）`,
      detail: `${blocked.id}${last ? ` · 上一次完整采集 ${last.id}` : ""}`,
      action: blocked.outcome === "skipped" ? "多半是点评系统的 Chrome 没开或正在回复点评；11:30 会自动补跑" : "下一次定时采集会重试；连续两次失败请检查 Mac mini" });
  }
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

  // Platforms that used to give numbers and stopped: the cause may be a sign-out, a page change or a misread.
  const hl = health({ metrics, runs, history }, now);
  for (const h of hl.platforms) {
    const so = pages.find((p) => p.platform === h.platform && p.page === "landing" && p.status === "signed_out");
    if (so && h.signed_out_days >= 2) {
      const a = alerts.find((x) => x.id === `page:${h.platform}:landing`);
      if (a) Object.assign(a, { level: "critical", title: `${NAMES[h.platform]} 已连续 ${h.signed_out_days} 天未登录，没有新数据` });
    }
    if (h.days_since_data != null && h.days_since_data >= 2 && !so) {
      add({ id: `stale:${h.platform}`, level: h.days_since_data >= 4 ? "serious" : "warning", platform: h.platform, area: "data",
        owner: "收益/销售", title: `${NAMES[h.platform]} 已 ${h.days_since_data} 天没有读到新数字`,
        detail: `最后一次有数字是 ${h.last_data}`,
        why: "页面能打开却读不出数字，多半是平台改版或数据块没加载，预警和报告会悄悄缺这一块",
        steps: ["看下方“数据可靠性”里这个平台哪几页出错", "页面改版：让采集重新校准这几页", "数据块没加载：下次采集会自动重试，连续两天仍缺再人工打开一次"],
        kpi: "数据可靠性里这个平台恢复为绿色", eta: "1–2 天", action: "检查这个平台的采集页面，必要时重新校准" });
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
  for (const [suffix, words] of [["30d@last_30_days", "近 30 天"], ["mtd@month_to_date", "本月至今"], ["90d@last_90_days", "近 90 天"]]) {
    const adr = cur(`booking|adr_${suffix}`), rn = cur(`booking|room_nights_${suffix}`);
    if (!adr || !rn || adr.day !== rn.day || !adr.benchmark || !rn.benchmark) continue;
    const ari = (adr.value / adr.benchmark) * 100, mpi = (rn.value / rn.benchmark) * 100;
    if (ari < 90 && mpi > 105) {
      diag({ id: "diag:booking:rate-led", level: "serious", platform: "booking", metric: `booking|adr_${suffix}`, gap: ari - 100,
        title: `Booking 量高价低：间夜是同类的 ${Math.round(mpi)}%，房价只有同类的 ${Math.round(ari)}%`,
        detail: `${words}间夜 ${fmt(rn.value)} 对 ${fmt(rn.benchmark)}，ADR ${fmt(adr.value, "THB")} 对 ${fmt(adr.benchmark, "THB")} · ${adr.day}`,
        why: "这是量价结构差异，不证明低价导致增量或损失；需排查房型、入住日期、客源和折扣构成",
        steps: ["在 Booking 后台“优惠”页列出在线促销、适用日期与实际叠加价，先核对",
          "收益经理结合当前 PMS 房态、逐日需求与可比竞品报价，提交有日期边界的方案",
          "记录人工动作和基线，一周后复查同口径指标；变化不直接等于因果收益"],
        kpi: "同口径 ADR、转化、在手与净收入；先确认数据是否足够", eta: "1–2 周",
        action: "核对 Booking 量价结构、可比价型和逐日房态，再提交收益经理评估" });
      suppress.add("gap:booking|adr_");
      break;
    }
  }

  // Funnel: seen more than peers but clicked less → the list view (photo, price, score), not visibility.
  const views = cur("booking|search_views_vs_peer@funnel"), ctr = cur("booking|click_rate@funnel");
  if (views && ctr && views.day === ctr.day && ctr.benchmark != null && ctr.value < ctr.benchmark && views.value > 0) {
    const plan = playbook("click_rate");
    diag({ id: "diag:booking:list-view", level: "serious", platform: "booking", metric: "booking|click_rate@funnel", area: "conversion",
      owner: plan.owner, gap: ctr.value - ctr.benchmark,
      title: `Booking 被看到的比同类多 ${fmt(views.value, "%")}，点进来的却更少`,
      detail: `点击率 ${fmt(ctr.value, "%")}，同类 ${fmt(ctr.benchmark, "%")} · ${ctr.day}`,
      why: "曝光与点击表现存在差异；首图、可比报价、样本与客源结构都是待验证原因",
      steps: plan.steps, kpi: plan.kpi, eta: plan.eta, action: plan.action });
    suppress.add("gap:booking|click_rate");
  } else if (views && views.value < -10) {
    const plan = playbook("search_views");
    diag({ id: "diag:booking:visibility", level: "warning", platform: "booking", metric: "booking|search_views_vs_peer@funnel", area: "traffic",
      gap: views.value, title: `Booking 搜索曝光比同类少 ${fmt(Math.abs(views.value), "%")}`, detail: views.day, ...how(plan) });
  }

  // Pace: on-the-books room nights for the next 30 days vs the same window last year.
  const otbRn = cur("booking|otb_room_nights_30d@next_30_days"), candidateAdr = cur("booking|otb_adr_30d@next_30_days");
  const otbAdr = candidateAdr?.day === otbRn?.day ? candidateAdr : null;
  if (otbRn && otbRn.benchmark) {
    const d = ((otbRn.value - otbRn.benchmark) / otbRn.benchmark) * 100;
    const ad = otbAdr && otbAdr.day === otbRn.day && otbAdr.benchmark ? ((otbAdr.value - otbAdr.benchmark) / otbAdr.benchmark) * 100 : null;
    if (d <= -15) {
      diag({ id: "diag:booking:otb-pace", level: "serious", platform: "booking", metric: "booking|otb_room_nights_30d@next_30_days", gap: d,
        title: `Booking 未来 30 天在手间夜比去年少 ${Math.round(-d)}%${ad != null && ad > 10 ? `，房价高 ${Math.round(ad)}%` : ""}`,
        detail: `在手 ${fmt(otbRn.value)} 间夜，去年同期 ${fmt(otbRn.benchmark)}${otbAdr ? `；在手 ADR ${fmt(otbAdr.value, "THB")}，去年 ${fmt(otbAdr.benchmark, "THB")}` : ""} · ${otbRn.day}`,
        why: ad != null && ad > 10 ? "在手价量与去年不同，需核对提前期、入住日、渠道结构及同比快照时点；不能据此推断提价导致掉单"
          : "在手低于平台给出的去年对比值；需先确认同比窗口与采样时点可比",
        steps: ["收益经理在 OPERA / SynXis 按日期列出未来 30 天在手最低的 5–7 天",
          "结合逐日可售库存、净佣金与需求验证，提交人工确认的方案，不预设降价",
          "复查同入住日不同快照的在手变化；滚动 30 天总量变化不等于 pickup"],
        kpi: "未来 30 天在手间夜对比去年、在手 ADR", eta: "1–2 周",
        action: "收益经理核对未来 30 天逐日房态、同比时点与可比价型，再决定方案" });
      suppress.add("gap:booking|otb_room_nights_30d");
    }
  }

  // Platform thresholds that change what a guest sees or what we qualify for.
  const thresholds = [
    ["booking|review_score@", (v) => v < 7.5 ? "serious" : v < 8 ? "warning" : null, "reputation",
      (v) => `Booking 点评分 ${v}：${v < 7.5 ? "低于内部关注线 7.5（项目资格需后台核验）" : "低于内部关注线 8 分（不代表平台限流）"}`],
    // eBooking shows the score out of 10; 4.7 / 5 ≈ 9.4 / 10. A value of 5 or less is the 5-point scale.
    ["ctrip|review_score@", (v) => (v <= 5 ? v < 4.7 : v < 9.4) ? "warning" : null, "reputation",
      (v) => `携程点评分 ${v}，低于内部关注线，标签需后台核验 ${v <= 5 ? "4.7" : "约 9.4 / 10（4.7 / 5）"}`],
    ["booking|property_page_score@", (v) => v < 100 ? "warning" : null, "content", (v) => `Booking 房源页完整度 ${v}%，未满分`],
    ["booking|availability_for_search@funnel", (v) => v < 90 ? "warning" : null, "traffic",
      (v) => `Booking 可售率 ${v}%：核对实际可售日期和限制，不推断排名权重`],
    ["agoda|bookings_lost_30d@next_30_days", (v) => v >= 50 ? "serious" : v >= 20 ? "warning" : null, "price",
      (v) => `Agoda 未来 30 天有 ${v} 单预订流失给竞品`],
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
  return { season: season(now.getUTCMonth() + 1), health: hl, alerts: dedupe(kept).sort(order).slice(0, 20), wins: dedupe(wins).sort((a, b) => (b.gap || 0) - (a.gap || 0)).slice(0, 8) };
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

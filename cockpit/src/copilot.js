// Copilot: answers questions from the cockpit's stored numbers and proposes to-dos the viewer can add with one tap.
// It sees aggregate numbers, alerts, the latest report and the to-do list; never page text or guest data. It cannot
// touch any OTA back office: the only thing it can change is the cockpit's own to-do list, and only through a button
// the viewer presses.

import { NAMES, fmt, seriesOf } from "./monitor.js";
import { KNOWLEDGE, season } from "./knowledge.js";
import { evidenceId } from "./operator.js";

export const OWNERS = ["收益/销售", "前台", "客房", "工程", "餐饮", "市场/内容", "总经理"];
const PLATFORM_KEYS = [...Object.keys(NAMES), "all"];

const SYSTEM = `你是普吉岛卡马拉温德姆花园酒店（Wyndham Garden Phuket Kamala）的 OTA 运营 Copilot，坐在 OTA 驾驶舱右侧，和总经理、收益经理一起工作。
你能看到下面“数据”里各 OTA 后台每天只读采集的指标、自动预警、今天的分析报告和运营待办。

回答规则：
- 用中文，像同事说话，先给结论，再给依据。每个判断都要引用数据里的真实数字和日期；数据里没有的，直说“还没采集到”，不要编。
- 区分【事实】【待验证原因】【建议】。知识库与旧日报是待验证背景，不得覆盖当前数据、来源时间和决策门禁。
- PMS actual 是实绩，pms_projection 只是 OPERA 报表未来值，不是 IDeaS 需求预测或已确认 OTB。不能把 OTA 滚动周期指标当逐入住日数据。
- 严禁仅凭 ADR 低于同类就断言低价换量、收益损失或建议固定涨价百分比；未知净佣金、库存、可比价型与需求时先调查。LRV 不是挂牌价。
- 每项 actions 必须带 evidence_ids，逐字引用数据中的证据 ID；无有效证据不生成待办按钮。所有建议均需人工复核，不能声称已执行或已增收。
- 建议要具体到谁、去哪个后台哪个页面、做什么、做完看哪个指标。
- 价格和房态由 OPERA / SynXis 同步到各 OTA：调价建议写成“收益经理在 OPERA / SynXis 调整”，不要建议在 OTA 后台直接改价。
- 你不能登录或操作任何 OTA 后台；能做的是把事情变成待办（actions），由人点按钮确认。
- 需要写文案（房源描述、促销文案、给杨总的汇报）时直接写好。
- 先看“数据可靠性”：引用的数字超过 1 天要写日期；某平台没数据就直说，别拿旧数字当今天的。
- 判断原因时用下面“运营知识”里的规则（排名因素、项目门槛、症状→原因→动作），说清是哪条规则；知识里标“第三方说法”或“以后台为准”的，提醒以平台后台为准。

只输出一个 JSON 对象，不要别的文字：
{"reply": "给用户看的回答，可以用换行和 - 列表，不超过 400 字",
 "actions": [{"type": "todo", "title": "一句话待办", "owner": "${OWNERS.join(" / ")} 之一",
              "platform": "${PLATFORM_KEYS.join(" / ")} 之一", "detail": "怎么做、看什么指标", "evidence_ids": ["数据中原样的证据 ID"]}]}
actions 最多 4 条，只在确实该有人去做事时给；纯问答时给空列表。`;

/** The data block the model answers from: one line per metric, then alerts, report and to-dos. */
export function context({ metrics = [], advice = [], todos = [], revenue, operator, selected_stay_date }, { alerts = [], wins = [], health = null }) {
  const lines = [];
  if (revenue) lines.push("# PMS 经营数据边界（优先于旧日报和知识库）", JSON.stringify({ status: revenue.status,
    source_as_of: revenue.source?.as_of, currency: revenue.source?.currency, precision: revenue.source?.precision,
    months: revenue.months, gaps: revenue.gaps, formulas: revenue.formulas }));
  const selected = revenue?.days?.filter(d => d.stay_date === selected_stay_date);
  if (selected?.length) lines.push("# 用户正在查看的入住日期（不是今天的事实）", JSON.stringify(selected));
  if (operator) lines.push("# Operator 证据与调查卡（不是已执行动作）", JSON.stringify({
    boundaries: operator.boundaries,
    cards: operator.cards.map(c => ({ id: c.id, kind: c.kind, title: c.title, evidence_ids: c.evidence_ids, plan: c.plan })),
    decisions: operator.decisions.slice(0, 10).map(d => ({ id: d.id, title: d.title, status: d.status, review_on: d.review_on, observation: d.followup?.message })) }));
  if (health) {
    lines.push("# 数据可靠性（最新数据日 " + (health.latest_day || "无") + `，今天收到 ${health.coverage.got}/${health.coverage.expected} 项指标）`);
    for (const h of health.platforms) {
      lines.push(`- ${NAMES[h.platform]}: ${h.last_data ? `最后有数字 ${h.last_data}（${h.days_since_data} 天前）` : "还没有数字"}`
        + `${h.signed_out_days ? `，连续 ${h.signed_out_days} 天未登录` : ""}`);
    }
    lines.push("超过 1 天的数字要说明日期，别当成今天的；缺的平台直接说缺。", "");
  }
  lines.push("# 指标（最新值；同类=平台给的对比值）");
  for (const rows of Object.values(seriesOf(metrics))) {
    const m = rows.at(-1);
    const prev = rows.length > 1 ? `；上次 ${fmt(rows.at(-2).value, m.unit)}（${rows.at(-2).day}）` : "";
    lines.push(`- [${evidenceId(m)}] ${NAMES[m.platform]} ${m.label}${m.period ? `[${m.period}]` : ""}: ${fmt(m.value, m.unit)}`
      + `${m.benchmark != null ? `，同类 ${fmt(m.benchmark, m.unit)}` : ""}（${m.day}）${prev}`);
  }
  lines.push("", "# 自动预警", ...alerts.map((a) => `- [${a.level}] ${a.title}：${a.detail}`));
  lines.push("", "# 做得好", ...wins.map((w) => `- ${w.title}：${w.detail}`));
  const r = advice[0];
  if (r) {
    lines.push("", `# 今日分析报告 ${r.id}`, r.summary,
      ...(r.items || []).map((it) => `- (${it.priority}) ${it.title}｜依据：${it.evidence}｜做法：${it.action}`));
  }
  const open = todos.filter((t) => t.status === "open");
  lines.push("", "# 未完成待办", ...(open.length ? open.map((t) => `- [${t.owner}] ${t.title}`) : ["- 无"]));
  return lines.join("\n").slice(0, 24000);
}

export function parseAnswer(text) {
  const raw = String(text || "").trim();
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  let obj = null;
  if (start >= 0 && end > start) {
    try { obj = JSON.parse(raw.slice(start, end + 1)); } catch { obj = null; }
  }
  if (!obj || typeof obj.reply !== "string") return { reply: raw.slice(0, 3000) || "（没有回答）", actions: [] };
  const actions = (Array.isArray(obj.actions) ? obj.actions : []).filter((a) => a && a.title).slice(0, 4).map((a) => ({
    type: "todo",
    title: String(a.title).slice(0, 200),
    owner: OWNERS.includes(a.owner) ? a.owner : "总经理",
    platform: PLATFORM_KEYS.includes(a.platform) ? a.platform : "all",
    detail: String(a.detail || "").slice(0, 800),
    evidence_ids: (Array.isArray(a.evidence_ids) ? a.evidence_ids : []).filter(x => typeof x === "string").slice(0, 8),
  }));
  return { reply: obj.reply.slice(0, 3000), actions };
}

export function groundAnswer(answer, state) {
  const evidence = new Map((state.operator?.evidence || []).map(e => [e.id, e]));
  const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const actions = (answer.actions || []).filter(a => a.evidence_ids?.length && a.evidence_ids.every(id => {
    const e = evidence.get(id);
    return e && e.day <= today && (Date.parse(today) - Date.parse(e.day)) <= 864e5;
  })).filter(a => !/涨价|降价|提价|调价|促销|折扣|超售|关房|开房/.test(a.title + a.detail));
  return { ...answer, actions, action_guard: { proposed: answer.actions?.length || 0, accepted: actions.length,
    rule: "待办需当前有效证据；价格/库存/促销方案走人工调查卡，不由模型直接生成执行按钮" } };
}

/**
 * Ask the configured model. COPILOT_API_KEY (+ COPILOT_BASE_URL, COPILOT_MODEL) selects any OpenAI-compatible API,
 * e.g. DeepSeek or OpenAI; without it the Workers AI binding is used; without either the copilot says so.
 */
export async function ask(env, history, data, now = new Date()) {
  const bkk = new Date(now.getTime() + 7 * 3600e3);
  const s = season(bkk.getUTCMonth() + 1);
  const today = `今天是 ${bkk.toISOString().slice(0, 10)}（曼谷），普吉${s.name}：${s.tip}。`;
  const messages = [
    { role: "system", content: `${SYSTEM}\n\n${today}\n\n# 运营知识${KNOWLEDGE}\n# 数据\n${data}` },
    ...history.slice(-10).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 2000) })),
  ];
  if (env.COPILOT_API_KEY) {
    const base = (env.COPILOT_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.COPILOT_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: env.COPILOT_MODEL || "gpt-4o-mini", messages, temperature: 0.3,
        response_format: { type: "json_object" }, max_tokens: 1500 }),
    });
    if (!r.ok) throw new Error(`model ${r.status}`);
    const j = await r.json();
    return { ...parseAnswer(j.choices?.[0]?.message?.content), model: env.COPILOT_MODEL || "gpt-4o-mini" };
  }
  if (env.AI) {
    const model = env.COPILOT_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    const j = await env.AI.run(model, { messages, max_tokens: 1500, temperature: 0.3 });
    const out = typeof j.response === "string" ? j.response : JSON.stringify(j.response ?? "");
    return { ...parseAnswer(out), model };
  }
  return { reply: "Copilot 还没有接入模型。请在 Cloudflare 给这个 Worker 设置 COPILOT_API_KEY（OpenAI 或 DeepSeek 都可以），或开启 Workers AI。", actions: [], model: "" };
}

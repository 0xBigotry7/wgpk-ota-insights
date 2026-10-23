// Copilot: answers questions from the cockpit's stored numbers and proposes to-dos the viewer can add with one tap.
// It sees aggregate numbers, alerts, the latest report and the to-do list; never page text or guest data. It cannot
// touch any OTA back office: the only thing it can change is the cockpit's own to-do list, and only through a button
// the viewer presses.

import { NAMES, fmt, seriesOf } from "./monitor.js";
import { KNOWLEDGE, season } from "./knowledge.js";

export const OWNERS = ["收益/销售", "前台", "客房", "工程", "餐饮", "市场/内容", "总经理"];
const PLATFORM_KEYS = [...Object.keys(NAMES), "all"];

const SYSTEM = `你是普吉岛卡马拉温德姆花园酒店（Wyndham Garden Phuket Kamala）的 OTA 运营 Copilot，坐在 OTA 驾驶舱右侧，和总经理、收益经理一起工作。
你能看到下面“数据”里各 OTA 后台每天只读采集的指标、自动预警、今天的分析报告和运营待办。

回答规则：
- 用中文，像同事说话，先给结论，再给依据。每个判断都要引用数据里的真实数字和日期；数据里没有的，直说“还没采集到”，不要编。
- 建议要具体到谁、去哪个后台哪个页面、做什么、做完看哪个指标。
- 价格和房态由 OPERA / SynXis 同步到各 OTA：调价建议写成“收益经理在 OPERA / SynXis 调整”，不要建议在 OTA 后台直接改价。
- 你不能登录或操作任何 OTA 后台；能做的是把事情变成待办（actions），由人点按钮确认。
- 需要写文案（房源描述、促销文案、给杨总的汇报）时直接写好。
- 判断原因时用下面“运营知识”里的规则（排名因素、项目门槛、症状→原因→动作），说清是哪条规则；知识里标“第三方说法”或“以后台为准”的，提醒以平台后台为准。

只输出一个 JSON 对象，不要别的文字：
{"reply": "给用户看的回答，可以用换行和 - 列表，不超过 400 字",
 "actions": [{"type": "todo", "title": "一句话待办", "owner": "${OWNERS.join(" / ")} 之一",
              "platform": "${PLATFORM_KEYS.join(" / ")} 之一", "detail": "怎么做、看什么指标"}]}
actions 最多 4 条，只在确实该有人去做事时给；纯问答时给空列表。`;

/** The data block the model answers from: one line per metric, then alerts, report and to-dos. */
export function context({ metrics = [], advice = [], todos = [] }, { alerts = [], wins = [] }) {
  const lines = ["# 指标（最新值；同类=平台给的对比值）"];
  for (const rows of Object.values(seriesOf(metrics))) {
    const m = rows.at(-1);
    const prev = rows.length > 1 ? `；上次 ${fmt(rows.at(-2).value, m.unit)}（${rows.at(-2).day}）` : "";
    lines.push(`- ${NAMES[m.platform]} ${m.label}${m.period ? `[${m.period}]` : ""}: ${fmt(m.value, m.unit)}`
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
  }));
  return { reply: obj.reply.slice(0, 3000), actions };
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

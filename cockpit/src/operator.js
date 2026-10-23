// The operator kernel is deterministic. Models explain evidence; they never approve OTA actions.
import { bkkDay } from "./revenue.js";

export const evidenceId = m => `ota:${m.platform}:${m.metric}:${m.period || "point"}:${m.day}`;
const daysAgo = (day, today) => Math.floor((Date.parse(today) - Date.parse(day)) / 864e5);
const parse = (v, fallback) => { try { return JSON.parse(v); } catch { return fallback; } };
const relevant = (a, metrics) => {
  if (!a.metric) return [];
  const primary = metrics.find(m => `${m.platform}|${m.metric}@${m.period || ""}` === a.metric);
  if (!primary) return [];
  const extra = a.id === "diag:booking:rate-led" ? primary.metric.replace(/^adr_/, "room_nights_")
    : a.id === "diag:booking:list-view" ? "search_views_vs_peer"
      : a.id === "diag:booking:otb-pace" ? "otb_adr_30d" : null;
  return [primary, ...metrics.filter(m => extra && m.platform === primary.platform && m.metric === extra && m.day === primary.day && m.period === primary.period)];
};
const ref = m => ({ id: evidenceId(m), platform: m.platform, metric: m.metric, period: m.period,
  day: m.day, page: m.page, label: m.label, value: m.value, unit: m.unit, benchmark: m.benchmark ?? null });

export function followup(decision, metrics, today = bkkDay()) {
  const baseline = typeof decision.baseline === "string" ? parse(decision.baseline, null) : decision.baseline;
  if (!baseline || decision.status === "investigating") return { status: "awaiting_action", message: "先记录实际执行，再等待后续采集；确认调查不代表已执行" };
  const actionDay = decision.action_day || bkkDay(new Date(decision.action_at || decision.updated_at));
  const latest = metrics.filter(m => m.platform === baseline.platform && m.metric === baseline.metric
    && (m.period || "") === (baseline.period || "") && (m.unit || "") === (baseline.unit || "")
    && m.day > baseline.day && m.day > actionDay && m.day <= today)
    .sort((a, b) => b.day.localeCompare(a.day))[0];
  if (!latest) return { status: "awaiting_data", message: "执行后尚无同平台、同指标、同周期的新采样；不能宣布有效" };
  return { status: "observed", baseline, latest: ref(latest), delta: latest.value - baseline.value,
    due: decision.review_on <= today,
    message: "观察到前后变化，不代表动作的因果效果；滚动窗口组成、市场需求等也会改变" };
}

export function operatorView(state, decisions = [], today = bkkDay()) {
  const metrics = state.metrics || [];
  const latest = new Map();
  for (const m of metrics) {
    const key = `${m.platform}|${m.metric}@${m.period || ""}`;
    if (!latest.has(key) || latest.get(key).day < m.day) latest.set(key, m);
  }
  const evidence = [...latest.values()].map(ref);
  const cards = [];
  if (state.revenue?.status !== "current") {
    const r = state.revenue;
    cards.push({ id: "gate:pms", title: r?.source ? "经营报表过期，先恢复收益数据" : "补上经营报表来源", owner: "收益/销售", platform: "all",
      kind: "data_gate", facts: [r?.source ? `OPERA 报表导出 ${r.source.as_of}，距今 ${r.age_days} 天；上传日期不代表报表更新` : "尚无 OPERA 经营日报"],
      hypothesis: "缺少当前逐入住日的经营信息，不能验证今日入住压力或给出具体涨降价幅度",
      plan: "核对 OPERA History & Forecast 自动报告的接收与归档，导入新版本后复核日期、房量和收入；不改入住/退房同步",
      verify: "来源日期不超过 1 天；确认币种、物业范围、未来值口径与覆盖日期", evidence_ids: r?.source ? [`pms-snapshot:${r.source.id}`] : [], baseline: null });
  }
  for (const a of state.monitor?.alerts || []) {
    const matches = relevant(a, [...latest.values()]);
    const m = matches[0];
    if (!m || cards.length >= 7 || ["data", "collection"].includes(a.area)) continue;
    const age = daysAgo(m.day, today);
    const stale = age > 1 || age < 0 || !Number.isFinite(age);
    cards.push({ id: a.id, title: a.title, owner: a.owner || "收益/销售", platform: m.platform,
      kind: stale ? "data_gate" : "investigation", baseline: ref(m), evidence_ids: matches.map(evidenceId),
      facts: matches.map(v => `${v.day} · ${v.label} ${v.value}${v.unit || ""} · ${v.period || "时点值"}${v.benchmark != null ? ` · 平台对比值 ${v.benchmark}${v.unit || ""}` : ""}`),
      hypothesis: stale ? "数据不是当前采样，只能做历史排查" : "指标偏差是调查线索，不单独证明价格、折扣、排名机制或部门问题是原因",
      plan: stale ? `先恢复 ${m.platform} 的 ${m.page || "指标来源"} 采集，再确认问题仍然存在`
        : /adr|revenue|room_nights|pace|cancellation|lost/.test(m.metric)
          ? "收益经理先核对同入住日、房型、含早/税费/取消政策、渠道佣金及 PMS 房态；再提交有日期边界的方案，不预设涨降价比例"
          : `在 ${m.platform} 的 ${m.page || "原始指标页"} 核对偏差与样本，人工确认具体问题及责任人，再决定是否执行整改`,
      verify: stale ? "新采样日期不超过 1 天且口径一致" : `记录人工实际执行时间；7 天后检查同口径 ${m.label}，同时检查样本和渠道变化，不把点击完成当成效果` });
  }
  return { mode: "read_only_human_approved", evidence, cards,
    decisions: decisions.map(d => ({ ...d, baseline: parse(d.baseline, null), evidence: parse(d.evidence, []), followup: followup(d, metrics, today) })),
    boundaries: ["OTA 只读；所有调查和执行记录均在驾驶舱内", "PMS 实绩 / 未来报表值 / OTA 滚动指标不混算", "效果归因与需求预测尚未建立，不自动宣告收益提升"] };
}

export async function approveDecision(db, body, state, now = new Date()) {
  const card = state.operator.cards.find(c => c.id === body?.source_ref);
  if (!card) throw new Error("卡片已变化，请刷新后重新确认");
  const existing = await db.prepare("select id from operator_decisions where source_ref = ? and status in ('investigating', 'reported')").bind(card.id).first();
  if (existing) return { ok: true, id: existing.id, duplicate: true };
  const at = now.toISOString(), review = bkkDay(new Date(now.getTime() + 7 * 864e5));
  const result = await db.prepare(`insert into operator_decisions
    (created_at, updated_at, source_ref, title, owner, platform, evidence, plan, baseline, review_on, status)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'investigating')`)
    .bind(at, at, card.id, card.title, card.owner, card.platform, JSON.stringify(card.evidence_ids),
      card.plan, JSON.stringify(card.baseline), review).run();
  const id = result.meta.last_row_id;
  await db.prepare("insert into operator_events (decision_id, at, event, note) values (?, ?, 'approved_investigation', ?)")
    .bind(id, at, "人工确认调查；不代表 OTA 已执行").run();
  return { ok: true, id, review_on: review };
}

export async function updateDecision(db, id, body, now = new Date()) {
  const row = await db.prepare("select * from operator_decisions where id = ?").bind(id).first();
  const transitions = { investigating: ["reported", "dismissed"], reported: ["reviewed", "dismissed"] };
  if (!row || !transitions[row.status]?.includes(body?.status)) throw new Error("无效状态转换");
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 1200) : "";
  if (note.length < 4) throw new Error("请记录实际做了什么或复查结论（至少 4 字）");
  if (body.status === "reviewed") {
    const baseline = parse(row.baseline, null);
    if (baseline) {
      const { results = [] } = await db.prepare("select * from metrics where platform = ? and metric = ? and period = ? order by day desc limit 30")
        .bind(baseline.platform, baseline.metric, baseline.period || "").all();
      if (followup(row, results, bkkDay(now)).status !== "observed") throw new Error("执行后尚无可比新采样，暂不能标为已复查");
    } else if (body.status === "reviewed") {
      // Data gates are verified against new PMS source dates, not the existence of a button click.
      const source = await db.prepare("select as_of from pms_snapshots order by as_of desc limit 1").first();
      if (!source || daysAgo(source.as_of, bkkDay(now)) > 1) throw new Error("当前经营报表仍未恢复，暂不能标为已复查");
    }
  }
  const at = now.toISOString();
  // Keep execution day stable through review. Event and state transition share one transaction.
  await db.batch([
    db.prepare("insert into operator_events (decision_id, at, event, note) select id, ?, ?, ? from operator_decisions where id = ? and status = ?")
      .bind(at, body.status, note, id, row.status),
    db.prepare("update operator_decisions set status = ?, updated_at = ?, outcome_note = ?, action_at = coalesce(action_at, ?) where id = ? and status = ?")
      .bind(body.status, at, note, body.status === "reported" ? at : null, id, row.status),
  ]);
  return { ok: true, id, status: body.status };
}

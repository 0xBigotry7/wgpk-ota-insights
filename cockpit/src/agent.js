// The OTA operator agent's tool backend. The agent itself (OpenClaw on the hotel Mac mini) calls these endpoints
// with AGENT_TOKEN; the dashboard is a display of the same data. Read tools return slices of the cockpit state;
// the only writes are to-dos, agent notes (durable memory) and chat replies. Nothing here reaches an OTA back office.
import { context, groundAnswer } from "./copilot.js";
import { KNOWLEDGE, ROUTINES } from "./knowledge.js";
import { agentIdeas } from "./ideas.js";
import { agentLighthouse } from "./lighthouse.js";
import { agentOpera, operaSummary } from "./opera-feeds.js";

export const AGENT_ONLINE_S = 180;      // no heartbeat for this long: the dashboard copilot falls back to the API model
export const CHAT_WAIT_S = 75;          // a queued question unanswered this long is answered by the fallback model
const CLAIM_STALE_S = 300;              // a claim this old without an answer goes back to the queue

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const clip = (s, n) => String(s ?? "").slice(0, n);
const safe = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

export async function agentStatus(db, now = Date.now()) {
  const hb = await db.prepare("select last_seen, info from agent_heartbeat where id = 'agent'").first().catch(() => null);
  const online = !!hb && now - Date.parse(hb.last_seen) <= AGENT_ONLINE_S * 1000;
  return { online, last_seen: hb?.last_seen || null, info: hb ? safe(hb.info, {}) : null };
}

async function beat(db, info = {}) {
  await db.prepare(`insert into agent_heartbeat (id, last_seen, info) values ('agent', ?, ?)
    on conflict(id) do update set last_seen = excluded.last_seen, info = excluded.info`).bind(iso(), clip(JSON.stringify(info), 500)).run();
}

/** The read tools: each one a slice of the cockpit state, so agent and dashboard always see the same numbers. */
const TOOLS = {
  alerts: (s) => s.monitor.alerts,
  wins: (s) => s.monitor.wins,
  health: (s) => s.monitor.health,
  pace: (s) => s.pace,
  events: (s) => s.events,
  channels: (s) => s.channels,
  revenue: (s) => ({ status: s.revenue.status, source: s.revenue.source, age_days: s.revenue.age_days, months: s.revenue.months, gaps: s.revenue.gaps }),
  todos: (s) => s.todos,
  decisions: (s) => s.operator?.decisions || [],
  report: (s) => s.advice[0] || null,
  runs: (s) => ({ latest: s.latest_run, runs: s.runs, pages: s.pages }),
  glossary: (s) => s.glossary,
  knowledge: () => ({ playbook: KNOWLEDGE, routines: ROUTINES }),
};

export async function handleAgent(request, env, path, loadState) {
  const url = new URL(request.url);
  const db = env.DB;
  const body = request.method === "POST" ? await request.json().catch(() => null) : null;
  const route = path.slice("/api/agent/".length);

  if (request.method === "GET") {
    if (route !== "chat/next") await noteProgress(db, route).catch(() => {});
    if (route === "brief") {
      const state = await loadState(env);
      if (url.searchParams.get("format") === "json") {
        return { generated_at: iso(), alerts: state.monitor.alerts, health: state.monitor.health, pace: state.pace, events: state.events,
          todos: state.todos.filter((t) => t.status === "open"), decisions: state.operator?.decisions || [], report: state.advice[0] || null,
          notes: await notes(db) };
      }
      const memory = (await notes(db)).map((n) => `- [${n.topic}] ${n.note}（${n.created_at.slice(0, 10)}）`);
      return { generated_at: iso(), text: `${memory.length ? `# Agent 记忆\n${memory.join("\n")}\n\n` : ""}${context(state, state.monitor)}` };
    }
    if (route === "metrics") return { metrics: await metrics(db, url.searchParams) };
    if (route === "ideas") return { ideas: await agentIdeas(db, url.searchParams) };
    if (route === "lighthouse") {
      const out = await agentLighthouse(db, url.searchParams);
      return out.error ? out : { lighthouse: out };
    }
    if (route === "opera") {
      const out = await agentOpera(env.PMS_ARCHIVE_DB, url.searchParams);
      return out.error ? out : { opera: out };
    }
    if (route === "daily") return { daily: await dailyInputs(db, await loadState(env)) };
    if (route === "notes") return { notes: await notes(db, url.searchParams.get("all") === "1") };
    if (route === "chat/next") {
      await beat(db, { via: "chat/next", agent: clip(request.headers.get("User-Agent"), 80) });
      return { request: await claim(db) };
    }
    if (TOOLS[route]) return { [route]: TOOLS[route](await loadState(env)) };
    return null;
  }

  if (route === "heartbeat") { await beat(db, body || {}); return { ok: true }; }
  if (route === "notes") {
    if (!body || !String(body.topic || "").trim() || !String(body.note || "").trim()) return { error: "topic and note are required", status: 400 };
    const r = await db.prepare("insert into agent_notes (created_at, topic, note, status) values (?, ?, ?, 'active')")
      .bind(iso(), clip(body.topic.trim(), 60), clip(body.note.trim(), 1500)).run();
    return { ok: true, id: r.meta?.last_row_id };
  }
  const note = route.match(/^notes\/(\d+)$/);
  if (note) {
    if (!["active", "archived"].includes(body?.status)) return { error: "status must be active or archived", status: 400 };
    await db.prepare("update agent_notes set status = ? where id = ?").bind(body.status, Number(note[1])).run();
    return { ok: true };
  }
  const chat = route.match(/^chat\/(\d+)$/);
  if (chat) {
    if (!body || !String(body.reply || "").trim()) return { error: "reply is required", status: 400 };
    const row = await db.prepare("select * from agent_chat where id = ?").bind(Number(chat[1])).first();
    if (!row) return { error: "unknown request", status: 404 };
    if (!["pending", "claimed"].includes(row.status)) return { error: `request is ${row.status}`, status: 409 };
    const state = await loadState(env);
    const answer = groundAnswer({ reply: clip(body.reply, 4000), actions: Array.isArray(body.actions) ? body.actions.slice(0, 4) : [] }, state);
    await db.prepare("update agent_chat set status = 'answered', answered_at = ?, reply = ?, actions = ?, model = ? where id = ?")
      .bind(iso(), answer.reply, JSON.stringify(answer.actions), clip(body.model || "agent", 80), row.id).run();
    await beat(db, { via: "chat/answer" });
    return { ok: true, accepted_actions: answer.actions.length, action_guard: answer.action_guard };
  }
  return null;
}

const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const bkkDay = (ms = Date.now()) => new Date(ms + 7 * 3600e3).toISOString().slice(0, 10);

/** Everything the daily brief needs and nothing else (a few KB instead of the ~90 KB brief + alerts + pace):
 *  whole hotel first (IDeaS), then channel pace with pickup, open to-dos with their age, yesterday's brief. */
export async function dailyInputs(db, state, now = Date.now()) {
  const today = bkkDay(now), yesterday = bkkDay(now - 864e5);
  const ideas = await agentIdeas(db, new URLSearchParams("days=14"));
  const days = (iso) => Math.floor((now - Date.parse(iso)) / 864e5);
  const allNotes = await notes(db);
  return {
    today,
    whole_hotel: ideas.snapshot ? {
      ideas_snapshot: ideas.snapshot.snapshot_date, previous_snapshot: ideas.previous?.snapshot_date || null,
      snapshot_age_days: days(`${ideas.snapshot.snapshot_date}T00:00:00+07:00`),
      months: ideas.months.slice(0, 4).map((m) => ({ month: m.month, otb: m.otb, otb_stly: m.otb_stly, occ_forecast: m.occ_forecast,
        budget_rooms: m.budget_rooms, forecast_occupancy_pct: m.forecast_occupancy_pct, avg_bar: m.avg_bar })),
      next_14_days: ideas.days.map((d) => ({ stay_date: d.stay_date, otb: d.otb, otb_stly: d.otb_stly, occ_forecast: d.occ_forecast,
        bar: d.bar, lrv: d.lrv, competitor_median: d.competitor_median, special_event: d.special_event, change: d.change })),
    } : null,
    channel_pace: (state.pace?.platforms || []).map((p) => ({ platform: p.platform, months: p.months.slice(0, 4).map((m) => ({
      month: m.month, room_nights: m.room_nights, room_nights_ly: m.room_nights_ly, gap_pct: r1(m.gap),
      pickup_1d: m.pickup_1d?.value ?? null, pickup_7d: m.pickup_7d?.value ?? null })) })),
    channel_next_days: (state.pace?.next_days || []).map((d) => ({ platform: d.platform, stay_date: d.stay_date, room_nights: d.room_nights, ly: d.room_nights_ly })),
    alerts: (state.monitor?.alerts || []).filter((a) => ["critical", "serious"].includes(a.level)).slice(0, 12)
      .map((a) => ({ id: a.id, level: a.level, title: a.title })),
    open_todos: (state.todos || []).filter((t) => t.status === "open").map((t) => ({ id: t.id, title: t.title, owner: t.owner,
      platform: t.platform, source: t.source, age_days: days(t.created_at), idle_days: days(t.updated_at) })),
    // Any number counts for last_data; last_business_data ignores review counts/scores read off a landing page,
    // so a platform whose sales pages fail is not reported as fresh.
    data_freshness: (state.monitor?.health?.platforms || []).map((p) => {
      const business = (state.metrics || []).filter((m) => m.platform === p.platform && !/^review_|_score$|rating/.test(m.metric) && m.page !== "landing")
        .reduce((d, m) => (m.day > d ? m.day : d), "");
      return { platform: p.platform, last_data: p.last_data, last_business_data: business || null,
        business_days_ago: business ? days(`${business}T00:00:00+07:00`) : null };
    }),
    yesterday_brief: allNotes.find((n) => n.topic === `daily-brief-${yesterday}`)?.note || null,
    // OPERA morning reports (opera-feeds.js): whole-hotel 7-day pickup, OTB by market, channel ADR, country mix.
    opera: state.opera_feeds !== undefined ? operaSummary(state.opera_feeds, now) : null,
    ideas_learning: allNotes.filter((n) => n.topic === "IDeaS学习").slice(0, 3).map((n) => ({ id: n.id, created_at: n.created_at, note: clip(n.note, 900) })),
  };
}

async function notes(db, all = false) {
  const r = await db.prepare(`select id, created_at, topic, note, status from agent_notes ${all ? "" : "where status = 'active'"} order by id desc limit 100`).all();
  return r.results || [];
}

async function metrics(db, q) {
  const where = [], args = [];
  for (const k of ["platform", "metric", "period"]) if (q.get(k)) { where.push(`${k} = ?`); args.push(q.get(k)); }
  // LIKE treats _ and % as wildcards; escape them so "pickup_90d_" matches literally.
  if (q.get("metric_prefix")) { where.push("metric like ? escape '\\'"); args.push(`${q.get("metric_prefix").replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
  if (q.get("since")) { where.push("day >= ?"); args.push(q.get("since")); }
  if (q.get("until")) { where.push("day <= ?"); args.push(q.get("until")); }
  const limit = Math.max(1, Math.min(500, Number(q.get("limit")) || 200));
  const r = await db.prepare(`select day, platform, metric, period, label, value, unit, benchmark, page, run_id from metrics
    ${where.length ? `where ${where.join(" and ")}` : ""} order by day desc, platform, metric limit ${limit}`).bind(...args).all();
  return r.results || [];
}

// Crew live work: which read tool the operator used while answering the currently claimed chat (tool name only).
const STEP_LABEL = { brief: "Read the daily brief", daily: "Checked today's inputs", pace: "Checked pickup and pace", alerts: "Checked alerts",
  wins: "Checked what went well", health: "Checked data health", events: "Checked events and demand", channels: "Compared channels",
  revenue: "Read revenue", todos: "Read open to-dos", decisions: "Read recent decisions", report: "Read the latest analysis",
  runs: "Checked collection runs", glossary: "Looked up a term", knowledge: "Read the playbook", metrics: "Read metrics",
  ideas: "Read IDeaS demand and rates", lighthouse: "Read Lighthouse market and events", opera: "Read OPERA pace, channels and countries", notes: "Read its working notes" };
const PROGRESS_MAX = 30;

export async function noteProgress(db, route, now = Date.now()) {
  const tool = String(route || "").split("/")[0].split("?")[0];
  if (!tool) return;
  const row = await db.prepare("select id from agent_chat where status = 'claimed' and claimed_at >= ? order by claimed_at desc limit 1")
    .bind(iso(now - CLAIM_STALE_S * 1000)).first();
  if (!row) return;
  const n = await db.prepare("select count(*) as n from agent_chat_progress where chat_id = ?").bind(row.id).first();
  if (n && n.n >= PROGRESS_MAX) return;
  await db.prepare("insert into agent_chat_progress (chat_id, at, tool, label) values (?, ?, ?, ?)")
    .bind(row.id, iso(now), clip(tool, 40), STEP_LABEL[tool] || `Read ${clip(tool, 30)}`).run();
}

export async function progressFor(db, id) {
  const r = await db.prepare("select at, tool, label from agent_chat_progress where chat_id = ? order by id limit ?").bind(id, PROGRESS_MAX).all();
  return r.results || [];
}

/** Hand the oldest waiting question to the agent; a claim that went quiet goes back to the queue. */
async function claim(db) {
  const stale = iso(Date.now() - CLAIM_STALE_S * 1000), fresh = iso(Date.now() - CHAT_WAIT_S * 1000);
  const row = await db.prepare(`select * from agent_chat where (status = 'pending' or (status = 'claimed' and claimed_at < ?))
    and created_at >= ? order by id limit 1`).bind(stale, fresh).first();
  if (!row) return null;
  await db.prepare("update agent_chat set status = 'claimed', claimed_at = ? where id = ?").bind(iso(), row.id).run();
  return { id: row.id, created_at: row.created_at, messages: safe(row.messages, []), stay_date: row.stay_date,
    answer_within_s: CHAT_WAIT_S, reply_to: `/api/agent/chat/${row.id}` };
}

/** Dashboard side: queue a question for the agent. */
export async function enqueue(db, history, stayDate) {
  const r = await db.prepare("insert into agent_chat (created_at, messages, stay_date, status) values (?, ?, ?, 'pending')")
    .bind(iso(), clip(JSON.stringify(history.slice(-10)), 20000), stayDate || null).run();
  return r.meta?.last_row_id;
}

/** Store the fallback model's answer on an expired request, so later polls read it. */
export async function settle(db, id, answer) {
  await db.prepare("update agent_chat set status = 'answered', answered_at = ?, reply = ?, actions = ?, model = ? where id = ? and status = 'expired'")
    .bind(iso(), clip(answer.reply, 4000), JSON.stringify(answer.actions || []), clip(`${answer.model || "model"}（备用）`, 80), id).run();
}

/** Dashboard side: the agent's answer, or null while it is still thinking; expires the request after CHAT_WAIT_S. */
export async function poll(db, id) {
  const row = await db.prepare("select * from agent_chat where id = ?").bind(id).first();
  if (!row) return { status: "missing" };
  if (row.status === "answered") return { status: "answered", reply: row.reply, actions: safe(row.actions, []), model: row.model };
  if (["pending", "claimed"].includes(row.status) && Date.now() - Date.parse(row.created_at) > CHAT_WAIT_S * 1000) {
    // Only the poll that flips the row runs the fallback model; later polls wait for its stored answer.
    const r = await db.prepare("update agent_chat set status = 'expired' where id = ? and status in ('pending', 'claimed')").bind(id).run();
    if (r.meta?.changes) return { status: "fallback", messages: safe(row.messages, []), stay_date: row.stay_date };
  }
  return { status: row.status };
}

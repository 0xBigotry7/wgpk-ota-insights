// The OTA operator agent's tool backend. The agent itself (OpenClaw on the hotel Mac mini) calls these endpoints
// with AGENT_TOKEN; the dashboard is a display of the same data. Read tools return slices of the cockpit state;
// the only writes are to-dos, agent notes (durable memory) and chat replies. Nothing here reaches an OTA back office.
import { context, groundAnswer } from "./copilot.js";
import { KNOWLEDGE, ROUTINES } from "./knowledge.js";
import { agentIdeas } from "./ideas.js";

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

import { metricContext } from "./contracts.js";
// OTA cockpit for Wyndham Garden Phuket Kamala: a password-protected page over D1.
//
// Writes come only from the hotel Mac mini's collector (Bearer OTA_INGEST_TOKEN) and carry aggregate
// numbers, page health and daily analysis reports; never page text or guest data. Separate Worker, database and
// secrets from the Review Desk. Viewers (password session) can only manage the cockpit's own to-do list and ask the
// copilot; nothing here reaches an OTA back office.

import { monitor, digest } from "./monitor.js";
import { ask, context, groundAnswer, OWNERS } from "./copilot.js";
import { handleSources, ingestSources } from "./sources.js";
import { ROUTINES, periodKey, explain } from "./knowledge.js";
import { validatePms, ingestPms, revenueView, scenario } from "./revenue.js";
import {channelView} from './channels.js';
import { paceView } from "./pace.js";
import { eventPlan } from "./events.js";
import { operatorView, approveDecision, updateDecision } from "./operator.js";
import { pollPmsArchive } from "./pms-bridge.js";
import { handleAgent, agentStatus, enqueue, poll, settle } from "./agent.js";

const SESSION_COOKIE = "wgpk_ota_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const HISTORY_DAYS = 120;
const PAGE_STATUS_DAYS = 3;
const PLATFORMS = ["booking", "agoda", "expedia", "ctrip", "google", "tripadvisor", "medallia"];
const PAGE_STATUSES = ["ok", "signed_out", "page_missing", "error"];
const BASE_CSP = "frame-ancestors 'none'";
const TODO_STATUSES = ["open", "done", "dropped"];
const COPILOT_PER_HOUR = 60;

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/login" && (request.method === "GET" || request.method === "HEAD")) {
      return html(loginPage(), 200);
    }
    if (path === "/login" && request.method === "POST") return handleLogin(request, env);
    if (path === "/logout") {
      return redirect("/login", { "Set-Cookie": `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax` });
    }

    // The OTA operator agent (OpenClaw on the hotel Mac mini): its own token, read tools + to-dos, notes and chat replies.
    if (path.startsWith("/api/agent/")) {
      if (!agentAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
      if (request.method === "POST" && path === "/api/agent/todos") return createTodo(request, env);
      const t = path.match(/^\/api\/agent\/todos\/(\d+)$/);
      if (request.method === "POST" && t) return updateTodo(request, env, Number(t[1]));
      if (path.startsWith("/api/agent/sources")) {
        const out = await handleSources(request, env.DB, path.slice("/api/agent/".length));
        if (!out) return json({ error: "not found" }, 404);
        return json(out, out.error ? out.status || 400 : 200);
      }
      const out = await handleAgent(request, env, path, loadState);
      if (!out) return json({ error: "not found" }, 404);
      return json(out, out.error ? out.status || 400 : 200);
    }

    // The Mac mini collector: which agent-added pages to probe/read, and what it found.
    if (path.startsWith("/api/ingest/sources")) {
      if (!ingestAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
      const out = await ingestSources(request, env.DB, path);
      if (!out) return json({ error: "not found" }, 404);
      return json(out, out.error ? out.status || 400 : 200);
    }

    if (path.startsWith("/api/")) {
      if (request.method === "POST") {
        if (["/api/ingest", "/api/advice", "/api/pms", "/api/pms/poll"].includes(path)) {
          if (!ingestAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
          if (path === "/api/pms/poll") return json(await pollPmsArchive(env));
          if (path === "/api/pms") {
            let body;
            try { body = await request.json(); } catch { return json({ error: "body must be JSON" }, 400); }
            const errors = validatePms(body);
            if (errors.length) return json({ error: "invalid PMS aggregates", details: errors.slice(0, 20) }, 400);
            return json(await ingestPms(env.DB, body));
          }
          return path === "/api/ingest" ? handleIngest(request, env) : handleAdvice(request, env);
        }
        // Viewer writes: a password session from this site's own pages (no cross-site posts).
        if (!(await sessionAuthorized(request, env)) || request.headers.get("Origin") !== url.origin) {
          return json({ error: "unauthorized" }, 401);
        }
        if (path === "/api/todos") return createTodo(request, env);
        const todo = path.match(/^\/api\/todos\/(\d+)$/);
        if (todo) return updateTodo(request, env, Number(todo[1]));
        if (path === "/api/copilot") return handleCopilot(request, env);
        if (path === "/api/routines") return tickRoutine(request, env);
        if (path === "/api/scenario") {
          try { return json(scenario(await request.json())); } catch { return json({ error: "请输入有效的房量、房价与假设" }, 400); }
        }
        if (path === "/api/operator") {
          try {
            const body = await request.json();
            return json(await approveDecision(env.DB, body, await loadState(env)));
          } catch (e) { return json({ error: e.message }, 400); }
        }
        const decision = path.match(/^\/api\/operator\/(\d+)$/);
        if (decision) {
          try { return json(await updateDecision(env.DB, Number(decision[1]), await request.json())); }
          catch (e) { return json({ error: e.message }, 400); }
        }
        return json({ error: "not found" }, 404);
      }
      if (!(ingestAuthorized(request, env) || (await sessionAuthorized(request, env)))) {
        return json({ error: "unauthorized" }, 401);
      }
      if (request.method === "GET" && path === "/api/state") return json(await loadState(env));
      const queued = path.match(/^\/api\/copilot\/(\d+)$/);
      if (request.method === "GET" && queued) return pollCopilot(env, Number(queued[1]));
      return json({ error: "not found" }, 404);
    }

    if (!(await sessionAuthorized(request, env))) return redirect("/login");
    const response = await env.ASSETS.fetch(request);
    const headers = withSecurityHeaders(new Headers(response.headers));
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  },

  // Daily push after the 10:20 collection (+ the 22:15 fallback): only when TELEGRAM_BOT_TOKEN and
  // TELEGRAM_CHAT_ID are set, so nothing is sent anywhere until someone chooses a chat for it.
  // Also hands every serious alert to its department as a to-do, once per alert while it stays open.
  async scheduled(event, env, ctx) {
    if (event.cron === "7,37 * * * *") {
      ctx.waitUntil(pollPmsArchive(env));
      return;
    }
    ctx.waitUntil(dispatchAlerts(env).then(() => pushDigest(env)));
  },
};

export async function dispatchAlerts(env) {
  const state = await loadState(env);
  const { create, refresh, clear } = planDispatch(state.todos, state.monitor.alerts, state.monitor.health);
  const now = new Date().toISOString();
  const stmts = [
    ...create.map((a) => env.DB.prepare(
      `insert into todos (created_at, updated_at, title, detail, owner, platform, source, source_ref, status)
       values (?, ?, ?, ?, ?, ?, 'auto', ?, 'open')`
    ).bind(now, now, ...todoText(a), a.owner, a.platform || "all", clip(a.id, 120))),
    ...refresh.map(({ id, alert }) => env.DB.prepare("update todos set title = ?, detail = ?, updated_at = ? where id = ?")
      .bind(...todoText(alert), now, id)),
    ...clear.map((id) => env.DB.prepare("update todos set status = 'cleared', updated_at = ? where id = ? and status = 'open'")
      .bind(now, id)),
  ];
  if (stmts.length) await env.DB.batch(stmts);
  return { created: create.length, refreshed: refresh.length, cleared: clear.length };
}

const todoText = (a) => [clip(a.title, 200), clip([a.action, ...(a.steps || []).slice(1)].join("；"), 800)];

/**
 * What the daily dispatch does with auto to-dos. New serious alerts become to-dos, unless one is open or a person
 * closed one in the last week (they decided on it). An open auto to-do whose alert is still up gets today's numbers.
 * One whose alert is gone is cleared, but only when today's run read its platform: no data is not good news.
 */
export function planDispatch(todos = [], alerts = [], hl = null) {
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const taken = new Set(todos.filter((t) => t.status === "open" || (["done", "dropped"].includes(t.status) && t.updated_at >= weekAgo))
    .map((t) => t.source_ref));
  const create = alerts.filter((a) => (a.level === "critical" || a.level === "serious") && !taken.has(a.id));
  const byId = new Map(alerts.map((a) => [a.id, a]));
  const readToday = new Set((hl?.platforms || []).filter((p) => ["ok", "partial"].includes(p.cells.at(-1)?.state)).map((p) => p.platform));
  const refresh = [], clear = [];
  for (const t of todos) {
    if (t.status !== "open" || t.source !== "auto") continue;
    const a = byId.get(t.source_ref);
    if (a) {
      const [title, detail] = todoText(a);
      if (title !== t.title || detail !== t.detail) refresh.push({ id: t.id, alert: a });
    } else if (t.platform === "all" ? readToday.size > 0 : readToday.has(t.platform)) {
      clear.push(t.id);
    }
  }
  return { create, refresh, clear };
}

export async function pushDigest(env, send = fetch) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return { sent: false, reason: "not configured" };
  const state = await loadState(env);
  const text = digest(state.monitor, state.advice[0], env.COCKPIT_URL || "https://ota.wyndhamgardenkamala.com");
  const r = await send(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  return { sent: r.ok };
}

// ─────────────────────── ingest ───────────────────────

export function validateIngest(body) {
  const errors = [];
  const run = body && body.run;
  if (!run || !/^\d{8}-\d{6}$/.test(String(run.id || ""))) errors.push("run.id must look like 20261022-163347");
  if (!run || !run.started_at) errors.push("run.started_at is required");
  const pages = Array.isArray(body && body.pages) ? body.pages : [];
  const metrics = Array.isArray(body && body.metrics) ? body.metrics : [];
  pages.forEach((p, i) => {
    if (!PLATFORMS.includes(p.platform)) errors.push(`pages[${i}].platform unknown`);
    if (!p.page) errors.push(`pages[${i}].page is required`);
    if (!PAGE_STATUSES.includes(p.status)) errors.push(`pages[${i}].status unknown`);
  });
  metrics.forEach((m, i) => {
    if (!PLATFORMS.includes(m.platform)) errors.push(`metrics[${i}].platform unknown`);
    if (!/^[a-z0-9_]{2,64}$/.test(String(m.metric || ""))) errors.push(`metrics[${i}].metric must be a snake_case key`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(m.day || ""))) errors.push(`metrics[${i}].day must be YYYY-MM-DD`);
    if (typeof m.value !== "number" || !Number.isFinite(m.value)) errors.push(`metrics[${i}].value must be a number`);
    if (!m.label) errors.push(`metrics[${i}].label is required`);
    if (m.source_as_of != null && (!/^\d{4}-\d{2}-\d{2}$/.test(m.source_as_of)
      || !Number.isFinite(Date.parse(m.source_as_of)) || new Date(m.source_as_of).toISOString().slice(0,10)!==m.source_as_of || m.source_as_of>m.day
      || !['page_data_as_of','selected_window_end'].includes(m.source_date_basis))) errors.push(`metrics[${i}].source date invalid`);
    if (m.benchmark != null && (typeof m.benchmark !== "number" || !Number.isFinite(m.benchmark))) {
      errors.push(`metrics[${i}].benchmark must be a number or null`);
    }
  });
  if (metrics.length > 2000 || pages.length > 500) errors.push("payload too large");
  return { errors, run, pages, metrics };
}

async function handleIngest(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }
  const { errors, run, pages, metrics } = validateIngest(body);
  if (errors.length) return json({ error: "validation failed", details: errors.slice(0, 20) }, 400);

  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare(
      `insert into runs (id, started_at, finished_at, outcome, received_at) values (?, ?, ?, ?, ?)
       on conflict(id) do update set finished_at=excluded.finished_at, outcome=excluded.outcome, received_at=excluded.received_at`
    ).bind(run.id, run.started_at, run.finished_at || null, run.outcome || null, now),
    ...pages.map((p) => env.DB.prepare(
      `insert or replace into page_status (run_id, platform, page, status, detail) values (?, ?, ?, ?, ?)`
    ).bind(run.id, p.platform, String(p.page).slice(0, 64), p.status, String(p.detail || "").slice(0, 300))),
    ...metrics.map((m) => env.DB.prepare(
      `insert or replace into metrics (day, platform, metric, period, label, value, unit, benchmark, run_id, page)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(m.day, m.platform, m.metric, String(m.period || "").slice(0, 40), String(m.label).slice(0, 80),
      m.value, String(m.unit || "").slice(0, 20), m.benchmark ?? null, run.id, String(m.page || "").slice(0, 64))),
  ];
  for(const m of metrics.filter(m=>m.source_as_of)) statements.push(env.DB.prepare(
    'insert or replace into metric_source_dates(day,platform,metric,period,run_id,source_as_of,source_date_basis) values (?,?,?,?,?,?,?)')
    .bind(m.day,m.platform,m.metric,String(m.period||'').slice(0,40),run.id,m.source_as_of,m.source_date_basis));
  await env.DB.batch(statements);
  return json({ ok: true, run: run.id, pages: pages.length, metrics: metrics.length });
}

export function validateAdvice(body) {
  const errors = [];
  if (!body || !/^(\d{4}-\d{2}-\d{2}|\d{4}-W\d{2})$/.test(String(body.id || ""))) errors.push("id must be a day like 2026-10-22");
  if (!body || !body.summary) errors.push("summary is required");
  const items = Array.isArray(body && body.items) ? body.items : null;
  if (!items) errors.push("items must be a list");
  (items || []).forEach((it, i) => {
    for (const k of ["title", "evidence", "action"]) if (!it[k]) errors.push(`items[${i}].${k} is required`);
    if (it.platform && it.platform !== "all" && !PLATFORMS.includes(it.platform)) errors.push(`items[${i}].platform unknown`);
  });
  for (const k of ["highlights", "watch"]) {
    if (body && body[k] !== undefined && !Array.isArray(body[k])) errors.push(`${k} must be a list`);
  }
  return errors;
}

const clip = (v, n) => String(v ?? "").slice(0, n);

// The advice.items column holds the whole report body ({items, highlights, watch}); old rows hold a bare list.
export function reportBody(body) {
  return {
    items: body.items.slice(0, 12).map((it) => ({
      platform: clip(it.platform, 20), area: clip(it.area, 20), priority: clip(it.priority, 10), owner: clip(it.owner, 20),
      title: clip(it.title, 200), evidence: clip(it.evidence, 600), analysis: clip(it.analysis, 800),
      action: clip(it.action, 800), expected: clip(it.expected, 400),
    })),
    highlights: (body.highlights || []).slice(0, 10).map((h) => ({ platform: clip(h.platform, 20), tone: clip(h.tone, 10), text: clip(h.text, 400) })),
    watch: (body.watch || []).slice(0, 6).map((w) => clip(w, 300)),
  };
}

export function readReport(row) {
  const parsed = safeJson(row.items, []);
  const body = Array.isArray(parsed) ? { items: parsed } : parsed;
  return { ...row, items: body.items || [], highlights: body.highlights || [], watch: body.watch || [] };
}

async function handleAdvice(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }
  const errors = validateAdvice(body);
  if (errors.length) return json({ error: "validation failed", details: errors.slice(0, 20) }, 400);
  await env.DB.prepare(
    `insert or replace into advice (id, generated_at, summary, items, model) values (?, ?, ?, ?, ?)`
  ).bind(body.id, body.generated_at || new Date().toISOString(), String(body.summary).slice(0, 2000),
    JSON.stringify(reportBody(body)), String(body.model || "").slice(0, 80)).run();
  return json({ ok: true, id: body.id });
}

// ─────────────────────── read ───────────────────────

async function loadState(env) {
  const since = new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString().slice(0, 10);
  const keys = Object.fromEntries(Object.keys(ROUTINES).map((c) => [c, periodKey(c)]));
  let [runs, metrics, advice, todos, ticks] = await Promise.all([
    all(env.DB.prepare("select * from runs order by id desc limit 14")),
    all(env.DB.prepare(
      `select m.day,m.platform,m.metric,m.period,m.label,m.value,m.unit,m.benchmark,m.page,m.run_id,x.source_as_of,x.source_date_basis
       from metrics m left join metric_source_dates x on x.day=m.day and x.platform=m.platform and x.metric=m.metric
       and x.period=m.period and x.run_id=m.run_id where m.day >= ? order by m.day`
    ).bind(since)),
    all(env.DB.prepare("select * from advice order by generated_at desc limit 30")),
    all(env.DB.prepare(
      "select * from todos where status = 'open' or updated_at >= ? order by status = 'open' desc, id desc limit 100"
    ).bind(new Date(Date.now() - 14 * 864e5).toISOString())),
    all(env.DB.prepare("select period, item, done_at from routine_ticks where period in (?, ?, ?)")
      .bind(keys.daily, keys.weekly, keys.monthly)),
  ]);
  const latest = runs[0] || null;
  // Latest per page: targeted analytics refreshes must not hide other source pages.
  const recent = new Date(Date.now() - PAGE_STATUS_DAYS * 864e5).toISOString().slice(0, 10).replaceAll("-", "");
  const pages = await all(env.DB.prepare(
    `select p.platform, p.page, p.status, p.detail, p.run_id from page_status p
       join (select platform, page, max(run_id) as run_id from page_status where run_id >= ? group by platform,page) l
         on l.platform = p.platform and l.page = p.page and l.run_id = p.run_id`
  ).bind(recent));
  // Page results of the last two weeks, for the reliability grid.
  const history = await all(env.DB.prepare("select run_id, platform, page, status from page_status where run_id >= ?")
    .bind(new Date(Date.now() - 15 * 864e5).toISOString().slice(0, 10).replaceAll("-", "")));
  // Rows stored before the extractor learned to drop them: a 0 score is an unrendered tile, a 0 comparison a misread.
  metrics = metrics.filter((m) => !(m.value === 0 && String(m.unit).startsWith("/")))
    .map((m) => (m.benchmark === 0 ? { ...m, benchmark: null } : m));
  const snapshots = await all(env.DB.prepare(`select s.*,p.as_of_basis,p.archived_at from pms_snapshots s
    left join pms_snapshot_provenance p on p.snapshot_id=s.id order by s.as_of desc,s.received_at desc,s.id desc limit 8`));
  const daily = snapshots.length ? (await all(env.DB.prepare(`select d.*,x.details from pms_daily d
    left join pms_daily_details x on x.snapshot_id=d.snapshot_id and x.stay_date=d.stay_date and x.kind=d.kind
    where d.snapshot_id in (${snapshots.map(() => "?").join(",")})`).bind(...snapshots.map(s => s.id))))
    .map(r=>({...r,details:safeJson(r.details,null)})) : [];
  const decisions = await all(env.DB.prepare("select * from operator_decisions order by id desc limit 50"));
  const state = {
    harness_version: "3.1-operator-foundations",
    latest_run: latest,
    runs,
    pages,
    metrics: metrics.map(m => ({...m, data_context: metricContext(m)})),
    advice: advice.map(readReport),
    todos,
    routines: Object.fromEntries(Object.entries(ROUTINES).map(([c, items]) => [c, {
      period: keys[c],
      items: items.map((it) => ({ ...it, done_at: ticks.find((t) => t.period === keys[c] && t.item === it.id)?.done_at || null })),
    }])),
    monitor: monitor({ metrics, pages, runs, history }),
    glossary: Object.fromEntries([...new Set(metrics.map((m) => m.metric))].map((k) => [k, explain(k)]).filter(([, v]) => v)),
    platforms: PLATFORMS,
    revenue: revenueView(snapshots, daily),
  };
  state.channels = channelView(state.metrics, state.pages);
  state.pace = paceView(state.metrics);
  state.events = eventPlan(state.metrics, state.pace);
  state.agent = await agentStatus(env.DB).catch(() => ({ online: false }));
  state.agent.notes = await all(env.DB.prepare("select id, created_at, topic, note from agent_notes where status = 'active' order by id desc limit 30")).catch(() => []);
  state.operator = operatorView(state, decisions);
  const feed = await all(env.DB.prepare("select state from pms_feed_state where id = 'opera_archive'"));
  state.revenue.feed = feed[0] ? safeJson(feed[0].state, null) : null;
  state.operator.events = await all(env.DB.prepare("select decision_id, at, event, note from operator_events order by id desc limit 200"));
  return state;
}

// ─────────────────────── to-dos and copilot (viewer writes) ───────────────────────

export function validateTodo(body) {
  const errors = [];
  if (!body || !String(body.title || "").trim()) errors.push("title is required");
  if (body && body.owner && !OWNERS.includes(body.owner)) errors.push("owner unknown");
  if (body && body.platform && body.platform !== "all" && !PLATFORMS.includes(body.platform)) errors.push("platform unknown");
  if (body && body.source && !["report", "alert", "copilot", "manual", "auto", "agent"].includes(body.source)) errors.push("source unknown");
  return errors;
}

async function createTodo(request, env) {
  const body = await request.json().catch(() => null);
  const errors = validateTodo(body);
  if (errors.length) return json({ error: "validation failed", details: errors }, 400);
  const now = new Date().toISOString();
  const ref = clip(body.source_ref, 120);
  // The same alert or report item twice is one to-do.
  if (ref) {
    const dup = await env.DB.prepare("select id from todos where source_ref = ? and status = 'open'").bind(ref).first();
    if (dup) return json({ ok: true, id: dup.id, existing: true });
  }
  const row = await env.DB.prepare(
    `insert into todos (created_at, updated_at, title, detail, owner, platform, source, source_ref, status)
     values (?, ?, ?, ?, ?, ?, ?, ?, 'open') returning id`
  ).bind(now, now, clip(body.title, 200).trim(), clip(body.detail, 800), body.owner || "总经理", body.platform || "all",
    body.source || "manual", ref).first();
  return json({ ok: true, id: row && row.id });
}

async function updateTodo(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || !TODO_STATUSES.includes(body.status)) return json({ error: "status must be open, done or dropped" }, 400);
  await env.DB.prepare("update todos set status = ?, updated_at = ? where id = ?").bind(body.status, new Date().toISOString(), id).run();
  return json({ ok: true, id, status: body.status });
}

// Tick or untick a routine item for its current period only (today, this week, this month).
async function tickRoutine(request, env) {
  const body = await request.json().catch(() => null);
  const cadence = Object.keys(ROUTINES).find((c) => ROUTINES[c].some((it) => it.id === body?.item));
  if (!cadence) return json({ error: "unknown routine item" }, 400);
  const period = periodKey(cadence);
  if (body.done) {
    await env.DB.prepare("insert or replace into routine_ticks (period, item, done_at) values (?, ?, ?)")
      .bind(period, body.item, new Date().toISOString()).run();
  } else {
    await env.DB.prepare("delete from routine_ticks where period = ? and item = ?").bind(period, body.item).run();
  }
  return json({ ok: true, period, item: body.item, done: !!body.done });
}

async function handleCopilot(request, env) {
  const body = await request.json().catch(() => null);
  const history = Array.isArray(body && body.messages) ? body.messages.filter((m) => m && m.content) : [];
  if (!history.length || history.at(-1).role !== "user") return json({ error: "messages must end with a user message" }, 400);
  const hourAgo = new Date(Date.now() - 3600e3).toISOString();
  const used = await env.DB.prepare("select count(*) as n from copilot_log where at >= ?").bind(hourAgo).first();
  if (used && used.n >= COPILOT_PER_HOUR) return json({ error: "Copilot 这一小时问得太多了，稍后再试" }, 429);
  // When the hotel agent is online it answers; the page polls GET /api/copilot/:id and falls back after a wait.
  if (env.AGENT_TOKEN && (await agentStatus(env.DB)).online) {
    const id = await enqueue(env.DB, history, body.stay_date);
    await env.DB.prepare("insert into copilot_log (at, question, reply, model) values (?, ?, ?, ?)")
      .bind(new Date().toISOString(), clip(history.at(-1).content, 2000), `(queued for the hotel agent #${id})`, "agent").run();
    return json({ queued: id, agent: true });
  }
  return answerWithModel(env, history, body.stay_date);
}

async function pollCopilot(env, id) {
  const r = await poll(env.DB, id);
  if (r.status === "answered") return json({ reply: r.reply, actions: r.actions, model: r.model, agent: true });
  if (r.status === "fallback") {
    const res = await answerWithModel(env, r.messages, r.stay_date);
    const j = await res.json();
    if (res.ok) await settle(env.DB, id, j);
    return json({ ...j, fallback: "hotel agent did not answer in time" }, res.status);
  }
  if (r.status === "expired") return json({ error: "酒店 agent 没按时回答，备用模型也没答上，请再问一次" }, 504);
  return json({ status: r.status }, r.status === "missing" ? 404 : 202);
}

async function answerWithModel(env, history, stayDate) {
  const state = await loadState(env);
  let answer;
  try {
    state.selected_stay_date = state.revenue.days.some(d => d.stay_date === stayDate) ? stayDate : null;
    answer = groundAnswer(await ask(env, history, context(state, state.monitor)), state);
  } catch (e) {
    return json({ error: `模型暂时不可用（${String(e.message).slice(0, 80)}），稍后再试` }, 502);
  }
  await env.DB.prepare("insert into copilot_log (at, question, reply, model) values (?, ?, ?, ?)")
    .bind(new Date().toISOString(), clip(history.at(-1).content, 2000), clip(answer.reply, 4000), clip(answer.model, 80)).run();
  return json(answer);
}

// ─────────────────────── auth ───────────────────────

function agentAuthorized(request, env) {
  if (!env.AGENT_TOKEN) return false;
  return timingSafeEqual(request.headers.get("Authorization") || "", `Bearer ${env.AGENT_TOKEN}`);
}

function ingestAuthorized(request, env) {
  if (!env.OTA_INGEST_TOKEN) return false;
  return timingSafeEqual(request.headers.get("Authorization") || "", `Bearer ${env.OTA_INGEST_TOKEN}`);
}

async function handleLogin(request, env) {
  if (!env.DASHBOARD_PASSWORD || !env.SESSION_SECRET) {
    return html(loginPage("登录尚未配置。Login is not configured yet."), 503);
  }
  const form = await request.formData();
  if (!timingSafeEqual(String(form.get("password") || ""), env.DASHBOARD_PASSWORD)) {
    return html(loginPage("密码不对，请再试一次。"), 401);
  }
  const expires = String(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS);
  const token = `${expires}.${await hmac(expires, env.SESSION_SECRET)}`;
  return redirect("/", {
    "Set-Cookie": `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`,
  });
}

async function sessionAuthorized(request, env) {
  if (!env.SESSION_SECRET) return false;
  const prefix = `${SESSION_COOKIE}=`;
  const tokens = (request.headers.get("Cookie") || "").split(";").map((p) => p.trim())
    .filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
  for (const token of tokens) {
    const [expires, signature] = token.split(".");
    if (!Number(expires) || Number(expires) < Math.floor(Date.now() / 1000)) continue;
    if (timingSafeEqual(signature || "", await hmac(expires, env.SESSION_SECRET))) return true;
  }
  return false;
}

async function hmac(message, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function timingSafeEqual(a = "", b = "") {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i += 1) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ─────────────────────── helpers ───────────────────────

async function all(stmt) {
  const res = await stmt.all();
  return res.results || [];
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function withSecurityHeaders(headers) {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "same-origin");
  headers.set("Content-Security-Policy", BASE_CSP);
  return headers;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: withSecurityHeaders(new Headers(jsonHeaders)) });
}

function html(body, status = 200) {
  const headers = withSecurityHeaders(new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }));
  return new Response(body, { status, headers });
}

function redirect(location, extra = {}) {
  const headers = withSecurityHeaders(new Headers({ Location: location, ...extra }));
  return new Response(null, { status: 303, headers });
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function loginPage(error = "") {
  const message = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OTA 驾驶舱登录</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:#F3F5F4;color:#1F2A26;font-family:'PingFang SC','Noto Sans SC',system-ui,-apple-system,sans-serif}
    .card{width:min(380px,100%);background:#fff;border:1px solid #E1E7E3;border-radius:14px;padding:36px 30px}
    h1{margin:0 0 4px;font-size:21px}
    .sub{margin:0 0 24px;font-size:13px;color:#5F6D66}
    label{display:block;font-weight:600;font-size:13px;margin-bottom:8px}
    input{width:100%;height:48px;border:1px solid #D5DED8;border-radius:9px;padding:0 12px;font:inherit;font-size:16px}
    input:focus{outline:none;border-color:#2F6B53;box-shadow:0 0 0 3px rgba(47,107,83,.18)}
    button{width:100%;height:46px;border:0;border-radius:9px;background:#2F6B53;color:#fff;font:inherit;font-weight:700;margin-top:16px;cursor:pointer}
    button:focus-visible{outline:3px solid #9CC8B3}
    .error{margin:0 0 14px;padding:9px 12px;border-radius:8px;background:#F8E4E1;color:#A3332A;font-size:13px}
  </style>
</head>
<body>
  <form class="card" method="post" action="/login">
    <h1>OTA 驾驶舱</h1>
    <p class="sub">Wyndham Garden Phuket Kamala · 各平台数据与运营建议</p>
    ${message}
    <label for="password">访问密码</label>
    <input id="password" name="password" type="password" autofocus autocomplete="current-password" />
    <button type="submit">进入</button>
  </form>
</body>
</html>`;
}

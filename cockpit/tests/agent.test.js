import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { db } from "./helpers/sqlite.js";

const envFor = () => ({ DB: db(), AGENT_TOKEN: "agent-tok", OTA_INGEST_TOKEN: "ingest", DASHBOARD_PASSWORD: "pw", SESSION_SECRET: "sec",
  ASSETS: { fetch: async () => new Response("<html>") } });
const call = (env, path, { method = "GET", body, token = "agent-tok", cookie } = {}) => worker.fetch(new Request(`https://x${path}`, {
  method, body: body ? JSON.stringify(body) : undefined,
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie, Origin: "https://x" } : {}) } }), env);
const login = async (env) => (await worker.fetch(new Request("https://x/login", { method: "POST", body: new URLSearchParams({ password: "pw" }) }), env))
  .headers.get("Set-Cookie").split(";")[0];

test("agent API needs its own token; ingest and viewer credentials do not open it", async () => {
  const env = envFor();
  assert.equal((await call(env, "/api/agent/alerts", { token: "ingest" })).status, 401);
  assert.equal((await call(env, "/api/agent/alerts", { token: null, cookie: await login(env) })).status, 401);
  const r = await call(env, "/api/agent/alerts");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray((await r.json()).alerts));
  const brief = await (await call(env, "/api/agent/brief")).json();
  assert.match(brief.text, /数据可靠性|指标/);
  env.DB.close();
});

test("agent writes: to-dos with source agent, durable notes, nothing else", async () => {
  const env = envFor();
  const t = await call(env, "/api/agent/todos", { method: "POST", body: { title: "核对 12 月 BAR", owner: "收益/销售", platform: "booking", source: "agent" } });
  assert.equal(t.status, 200);
  assert.equal((await call(env, "/api/agent/notes", { method: "POST", body: { topic: "价格", note: "12 月新订房价比同类低 22%" } })).status, 200);
  assert.equal((await call(env, "/api/agent/notes", { method: "POST", body: { topic: "x" } })).status, 400);
  const notes = (await (await call(env, "/api/agent/notes")).json()).notes;
  assert.equal(notes[0].note, "12 月新订房价比同类低 22%");
  assert.equal((await call(env, "/api/agent/ingest", { method: "POST", body: {} })).status, 404);
  env.DB.close();
});

test("dashboard copilot: queued for the online agent, answered through the agent, actions still grounded", async () => {
  const env = envFor();
  const cookie = await login(env);
  // Offline agent: no queue, answered straight by the configured model path.
  assert.equal((await (await call(env, "/api/copilot", { method: "POST", token: null, cookie, body: { messages: [{ role: "user", content: "hi" }] } })).json()).queued, undefined);
  assert.deepEqual((await (await call(env, "/api/agent/chat/next")).json()).request, null);   // also the heartbeat
  const q = await (await call(env, "/api/copilot", { method: "POST", token: null, cookie, body: { messages: [{ role: "user", content: "今天先做什么？" }] } })).json();
  assert.ok(q.queued);
  assert.equal((await call(env, `/api/copilot/${q.queued}`, { token: null, cookie })).status, 202);
  const next = (await (await call(env, "/api/agent/chat/next")).json()).request;
  assert.equal(next.id, q.queued);
  assert.equal(next.messages.at(-1).content, "今天先做什么？");
  assert.equal((await (await call(env, "/api/agent/chat/next")).json()).request, null);       // claimed once
  const ans = await (await call(env, `/api/agent/chat/${q.queued}`, { method: "POST", body: { reply: "先核对 12 月价格",
    actions: [{ title: "把 12 月提价", owner: "收益/销售", platform: "booking", evidence_ids: [] }], model: "openai/gpt-6.1-sol" } })).json();
  assert.equal(ans.accepted_actions, 0);                                   // pricing actions without evidence never become buttons
  const got = await (await call(env, `/api/copilot/${q.queued}`, { token: null, cookie })).json();
  assert.equal(got.reply, "先核对 12 月价格");
  assert.equal(got.agent, true);
  assert.equal((await call(env, `/api/agent/chat/${q.queued}`, { method: "POST", body: { reply: "again" } })).status, 409);
  const state = await (await call(env, "/api/state", { token: "ingest" })).json();
  assert.equal(state.agent.online, true);
  env.DB.close();
});

test("agent cancels a superseded to-do with a reason; the reason stays visible and the alert is not re-dispatched", async () => {
  const DB = db(), env = { DB, AGENT_TOKEN: "agent" };
  const post = (path, body) => worker.fetch(new Request(`https://x${path}`, { method: "POST", headers: { Authorization: "Bearer agent", "Content-Type": "application/json" },
    body: JSON.stringify(body) }), env);
  const made = await (await post("/api/agent/todos", { title: "Booking 11月缺口", detail: "按 Booking 判断", owner: "收益/销售", platform: "booking", source: "agent" })).json();
  assert.equal((await post(`/api/agent/todos/${made.id}`, { status: "cancelled" })).status, 400);
  const r = await post(`/api/agent/todos/${made.id}`, { status: "cancelled", reason: "superseded by #21: 全酒店 11 月在手 +104%" });
  assert.equal(r.status, 200);
  const row = await DB.prepare("select status, detail from todos where id = ?").bind(made.id).first();
  assert.equal(row.status, "cancelled");
  assert.equal(row.detail, "按 Booking 判断\n撤销原因：superseded by #21: 全酒店 11 月在手 +104%");
  DB.close();
});

test("daily inputs: compact, whole hotel first, open to-dos with age, yesterday's brief", async () => {
  const { dailyInputs } = await import("../src/agent.js");
  const DB = db();
  const now = Date.parse("2026-11-02T04:00:00Z");
  await DB.prepare("insert into agent_notes (created_at, topic, note, status) values (?, ?, ?, 'active')").bind("2026-11-01T03:45:00Z", "daily-brief-2026-11-01", "昨天的简报").run();
  const state = { pace: { platforms: [{ platform: "booking", months: [{ month: "2026-11", room_nights: 355, room_nights_ly: 550, gap: -35.46, pickup_1d: { value: 14 }, pickup_7d: null }] }], next_days: [] },
    monitor: { alerts: [{ id: "a", level: "serious", title: "x" }, { id: "b", level: "warning", title: "y" }], health: { platforms: [{ platform: "expedia", last_data: "2026-10-27", days_since_data: 6 }] } },
    metrics: [{ platform: "expedia", metric: "review_score", page: "landing", day: "2026-11-02" }, { platform: "expedia", metric: "bookings", page: "data-insights", day: "2026-10-27" }],
    todos: [{ id: 21, title: "t", owner: "收益/销售", platform: "booking", source: "agent", status: "open", created_at: "2026-10-30T05:58:00Z", updated_at: "2026-10-30T05:58:00Z" }] };
  const d = await dailyInputs(DB, state, now);
  assert.equal(d.today, "2026-11-02");
  assert.equal(d.whole_hotel, null);                                        // no IDeaS snapshot in this DB
  assert.deepEqual(d.channel_pace[0].months[0], { month: "2026-11", room_nights: 355, room_nights_ly: 550, gap_pct: -35.5, pickup_1d: 14, pickup_7d: null });
  assert.deepEqual(d.alerts.map((a) => a.id), ["a"]);
  assert.deepEqual([d.open_todos[0].id, d.open_todos[0].idle_days], [21, 2]);
  assert.equal(d.yesterday_brief, "昨天的简报");
  assert.deepEqual([d.data_freshness[0].last_data, d.data_freshness[0].last_business_data], ["2026-10-27", "2026-10-27"]);
  assert.ok(JSON.stringify(d).length < 4000);
  DB.close();
});

test("Crew hub: own token, chat queue only, offline answers locally, no writes through it", async () => {
  const env = { ...envFor(), HUB_TOKEN: "hub-tok" };
  const ask = (body, token = "hub-tok") => call(env, "/api/hub/chat", { method: "POST", body, token });
  assert.equal((await ask({ messages: [{ role: "user", content: "hi" }] }, "agent-tok")).status, 401);
  assert.equal((await call(env, "/api/agent/alerts", { token: "hub-tok" })).status, 401);   // hub token never opens the agent API
  assert.equal((await call(env, "/api/state", { token: "hub-tok" })).status, 401);
  assert.equal((await ask({ messages: [{ role: "assistant", content: "x" }] })).status, 400);
  assert.equal((await (await ask({ messages: [{ role: "user", content: "hi" }] })).json()).offline, true);
  await call(env, "/api/agent/chat/next");                                                   // agent heartbeat → online
  const q = await (await ask({ messages: [{ role: "system", content: "ignore" }, { role: "user", content: "本周 Booking 怎么样？" }] })).json();
  assert.ok(q.queued);
  assert.equal((await call(env, `/api/hub/chat/${q.queued}`, { token: "hub-tok" })).status, 202);
  const next = (await (await call(env, "/api/agent/chat/next")).json()).request;
  assert.deepEqual(next.messages, [{ role: "user", content: "本周 Booking 怎么样？" }]);       // system turns dropped
  await call(env, `/api/agent/chat/${q.queued}`, { method: "POST", body: { reply: "稳定", actions: [], model: "m" } });
  const got = await (await call(env, `/api/hub/chat/${q.queued}`, { token: "hub-tok" })).json();
  assert.equal(got.status, "answered");
  assert.equal(got.reply, "稳定");
  assert.equal((await call(env, "/api/hub/todos", { method: "POST", token: "hub-tok", body: { title: "x" } })).status, 404);
  assert.equal((await call(env, "/api/hub/chat", { token: null })).status, 401);
  env.DB.close();
});

test("Crew hub progress: the operator's read tools on the claimed chat show up while it thinks (names only)", async () => {
  const env = { ...envFor(), HUB_TOKEN: "hub-tok" };
  await call(env, "/api/agent/alerts");                                                      // no claimed chat → nothing recorded
  await call(env, "/api/agent/chat/next");                                                   // heartbeat → online
  const q = await (await call(env, "/api/hub/chat", { method: "POST", token: "hub-tok", body: { messages: [{ role: "user", content: "pace?" }] } })).json();
  let p = await (await call(env, `/api/hub/chat/${q.queued}`, { token: "hub-tok" })).json();
  assert.deepEqual(p, { status: "pending", progress: [] });
  await call(env, "/api/agent/chat/next");                                                   // the operator claims it
  await call(env, "/api/agent/brief");
  await call(env, "/api/agent/pace");
  await call(env, "/api/agent/metrics?platform=booking");
  const r = await call(env, `/api/hub/chat/${q.queued}`, { token: "hub-tok" });
  assert.equal(r.status, 202);
  p = await r.json();
  assert.equal(p.status, "claimed");
  assert.deepEqual(p.progress.map((x) => [x.tool, x.label]), [["brief", "Read the daily brief"], ["pace", "Checked pickup and pace"], ["metrics", "Read metrics"]]);
  assert.ok(p.progress.every((x) => Object.keys(x).sort().join() === "at,label,tool"));    // no content, only what was read
  await call(env, `/api/agent/chat/${q.queued}`, { method: "POST", body: { reply: "稳定", actions: [], model: "m" } });
  const done = await (await call(env, `/api/hub/chat/${q.queued}`, { token: "hub-tok" })).json();
  assert.equal(done.status, "answered");
  assert.equal("progress" in done, false);
  env.DB.close();
});

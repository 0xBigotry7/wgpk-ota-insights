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

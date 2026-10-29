import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { nextSlot } from "../src/refresh.js";
import { db } from "./helpers/sqlite.js";

const envFor = () => ({ DB: db(), AGENT_TOKEN: "agent-tok", OTA_INGEST_TOKEN: "ingest", SESSION_SECRET: "s", ASSETS: { fetch: async () => new Response("") } });
const call = async (env, path, { method = "GET", body, token = "agent-tok" } = {}) => {
  const r = await worker.fetch(new Request(`https://x${path}`, { method, body: body ? JSON.stringify(body) : undefined,
    headers: token ? { Authorization: `Bearer ${token}` } : {} }), env);
  return { status: r.status, body: await r.json() };
};
const ask = (env, body) => call(env, "/api/agent/refresh", { method: "POST", body });

test("next collector slot is the first free slot after now, Bangkok time", () => {
  assert.equal(nextSlot(Date.parse("2026-10-29T04:30:00Z")), "12:35");   // 11:30 BKK
  assert.equal(nextSlot(Date.parse("2026-10-29T10:00:00Z")), "17:05");   // 17:00 BKK
  assert.equal(nextSlot(Date.parse("2026-10-29T15:20:00Z")), "明天 12:35"); // 22:20 BKK
});

test("agent queues a refresh, the collector claims it, reports done; the agent sees the result", async () => {
  const env = envFor();
  assert.equal((await ask(env, { platforms: ["booking"] })).status, 400);                       // reason required
  assert.equal((await ask(env, { platforms: ["evil"], reason: "x" })).status, 400);             // unknown platform
  assert.equal((await call(env, "/api/agent/refresh", { token: "ingest" })).status, 401);       // agent token only
  const a = await ask(env, { platforms: ["booking"], reason: "老姚问 11 月 Booking 在手" });
  assert.equal(a.status, 200); assert.equal(a.body.status, "pending");
  // A second ask while pending merges into the same request instead of queueing another.
  const b = await ask(env, { platforms: ["agoda", "booking"], reason: "Agoda 转化" });
  assert.equal(b.body.id, a.body.id); assert.deepEqual(b.body.platforms, ["booking", "agoda"]);

  assert.equal((await call(env, "/api/ingest/refresh/next", { token: "agent-tok" })).status, 401);  // collector token only
  const next = await call(env, "/api/ingest/refresh/next", { token: "ingest" });
  assert.deepEqual(next.body.request.platforms, ["booking", "agoda"]);
  assert.equal((await call(env, "/api/ingest/refresh/next", { token: "ingest" })).body.request, null);  // claimed once
  const done = await call(env, `/api/ingest/refresh/${a.body.id}`, { method: "POST", token: "ingest", body: { status: "done", run_id: "20261029-123500" } });
  assert.equal(done.body.status, "done");
  const seen = await call(env, "/api/agent/refresh");
  assert.equal(seen.body.requests[0].status, "done"); assert.equal(seen.body.requests[0].run_id, "20261029-123500");
  env.DB.close();
});

test("a skipped run puts the request back in the queue; one refresh a day at most", async () => {
  const env = envFor();
  const a = await ask(env, { platforms: ["ctrip"], reason: "携程问答" });
  await call(env, "/api/ingest/refresh/next", { token: "ingest" });
  const s = await call(env, `/api/ingest/refresh/${a.body.id}`, { method: "POST", token: "ingest", body: { status: "skipped", detail: "review window 13:45 is near" } });
  assert.equal(s.body.status, "pending");
  assert.equal((await call(env, "/api/ingest/refresh/next", { token: "ingest" })).body.request.id, a.body.id);
  await call(env, `/api/ingest/refresh/${a.body.id}`, { method: "POST", token: "ingest", body: { status: "done" } });
  assert.equal((await ask(env, { platforms: ["booking"], reason: "second today" })).status, 429);
  env.DB.close();
});

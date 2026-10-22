import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { validateIngest, validateAdvice } from "../src/worker.js";

const goodRun = { id: "20261022-163347", started_at: "2026-10-22T16:33:47+07:00", outcome: "done" };
const goodMetric = { day: "2026-10-22", platform: "booking", metric: "review_score", label: "评分", value: 8.6, unit: "score/10", page: "reviews" };

test("ingest accepts aggregate numbers", () => {
  const { errors } = validateIngest({ run: goodRun, pages: [{ platform: "booking", page: "landing", status: "ok" }], metrics: [goodMetric] });
  assert.deepEqual(errors, []);
});

test("ingest rejects unknown platforms, bad keys and non-numbers", () => {
  const { errors } = validateIngest({ run: goodRun, metrics: [
    { ...goodMetric, platform: "airbnb" }, { ...goodMetric, metric: "Review Score" }, { ...goodMetric, value: "8.6" },
    { ...goodMetric, value: NaN }, { ...goodMetric, benchmark: "x" }] });
  assert.equal(errors.length, 5);
});

test("ingest rejects a malformed run id", () => {
  assert.ok(validateIngest({ run: { id: "today", started_at: "x" } }).errors.length);
});

test("advice requires evidence and action on every item", () => {
  assert.deepEqual(validateAdvice({ id: "2026-W43", summary: "s", items: [{ platform: "agoda", title: "t", evidence: "e", action: "a" }] }), []);
  assert.equal(validateAdvice({ id: "2026-W43", summary: "s", items: [{ title: "t" }] }).length, 2);
});

function fakeEnv(secrets = {}) {
  const writes = [];
  const stmt = (sql) => ({ bind: (...a) => ({ sql, a, run: async () => writes.push([sql, a]), all: async () => ({ results: [] }) }),
    all: async () => ({ results: [] }) });
  return { writes, OTA_INGEST_TOKEN: "tok", DASHBOARD_PASSWORD: "pw", SESSION_SECRET: "sec", ...secrets,
    DB: { prepare: stmt, batch: async (s) => writes.push(...s) },
    ASSETS: { fetch: async () => new Response("<html>") } };
}

test("posting without the ingest token is refused", async () => {
  const env = fakeEnv();
  const r = await worker.fetch(new Request("https://x/api/ingest", { method: "POST", body: "{}" }), env);
  assert.equal(r.status, 401);
  assert.equal(env.writes.length, 0);
});

test("a viewer session cannot write", async () => {
  const env = fakeEnv();
  const login = await worker.fetch(new Request("https://x/login", { method: "POST", body: new URLSearchParams({ password: "pw" }) }), env);
  const cookie = login.headers.get("Set-Cookie").split(";")[0];
  const r = await worker.fetch(new Request("https://x/api/ingest", { method: "POST", headers: { Cookie: cookie }, body: "{}" }), env);
  assert.equal(r.status, 401);
  const s = await worker.fetch(new Request("https://x/api/state", { headers: { Cookie: cookie } }), env);
  assert.equal(s.status, 200);
});

test("ingest with the token writes run, pages and metrics in one batch", async () => {
  const env = fakeEnv();
  const body = JSON.stringify({ run: goodRun, pages: [{ platform: "booking", page: "landing", status: "ok" }], metrics: [goodMetric] });
  const r = await worker.fetch(new Request("https://x/api/ingest", { method: "POST", headers: { Authorization: "Bearer tok" }, body }), env);
  assert.equal(r.status, 200);
  assert.equal(env.writes.length, 3);
});

test("no secrets means no login and no ingest", async () => {
  const env = fakeEnv({ OTA_INGEST_TOKEN: undefined, DASHBOARD_PASSWORD: undefined, SESSION_SECRET: undefined });
  const login = await worker.fetch(new Request("https://x/login", { method: "POST", body: new URLSearchParams({ password: "" }) }), env);
  assert.equal(login.status, 503);
  const r = await worker.fetch(new Request("https://x/api/ingest", { method: "POST", headers: { Authorization: "Bearer undefined" }, body: "{}" }), env);
  assert.equal(r.status, 401);
});

test("pages need a session", async () => {
  const r = await worker.fetch(new Request("https://x/"), fakeEnv());
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("Location"), "/login");
});

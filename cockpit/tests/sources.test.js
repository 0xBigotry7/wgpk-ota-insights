import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { urlProblem } from "../src/sources.js";
import { db } from "./helpers/sqlite.js";

const envFor = () => ({ DB: db(), AGENT_TOKEN: "agent-tok", OTA_INGEST_TOKEN: "ingest", SESSION_SECRET: "s", ASSETS: { fetch: async () => new Response("") } });
const call = async (env, path, { method = "GET", body, token = "agent-tok" } = {}) => {
  const r = await worker.fetch(new Request(`https://x${path}`, { method, body: body ? JSON.stringify(body) : undefined,
    headers: token ? { Authorization: `Bearer ${token}` } : {} }), env);
  return { status: r.status, body: await r.json() };
};
const BK = "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage";

test("source URLs: only OTA back-office hosts, never pages that act or hold guest messages", () => {
  assert.equal(urlProblem("booking", `${BK}/statistics/cancellations.html?hotel_id=1`), null);
  assert.equal(urlProblem("booking", `${BK}/statistics/competitiveset.html?activeTab=competitive_set`), null);
  assert.match(urlProblem("booking", "https://evil.example.com/x"), /host/);
  assert.match(urlProblem("booking", "http://admin.booking.com/x"), /https/);
  assert.match(urlProblem("agoda", "https://admin.booking.com/x"), /host/);
  for (const bad of [`${BK}/messaging/inbox.html`, `${BK}/rates/update.html`, `${BK}/x.html?action=cancel`, `${BK}/saveRoomRates`,
    `${BK}/reviews.html`, `${BK}/logout`]) assert.ok(urlProblem("booking", bad), bad);
  // Medallia pages are numbered: an analysis page and one guest's survey look alike, so none are requestable.
  assert.match(urlProblem("medallia", "https://wyndhamhotels.medallia.com/sso/wyndhamhotels/applications/ex_WEB-5/pages/664"), /platform/);
  // Chinese action / guest words, and hash routes, count too.
  for (const bad of ["https://ebooking.ctrip.com/ebkorder/订单列表", "https://ebooking.ctrip.com/comment/点评回复",
    `https://ebooking.ctrip.com/x?tab=${encodeURIComponent("消息")}`, `${BK}/statistics/x.html#/messages`, "https://ycs.agoda.com/x#/inbox"])
    assert.ok(urlProblem(bad.includes("ctrip") ? "ctrip" : bad.includes("agoda") ? "agoda" : "booking", bad), bad);
  assert.equal(urlProblem("ctrip", "https://ebooking.ctrip.com/datacenter/traffic#/analysis"), null);
});

test("agent adds a source, collector probes it, agent sets a catalog, collector reads it daily", async () => {
  const env = envFor();
  const url = `${BK}/statistics/cancellations.html?hotel_id=1`;
  const a = await call(env, "/api/agent/sources", { method: "POST", body: { platform: "booking", url, why: "取消率按入住月" } });
  assert.equal(a.status, 200); assert.equal(a.body.status, "approved");
  assert.equal((await call(env, "/api/agent/sources", { method: "POST", body: { platform: "booking", url, why: "again" } })).status, 409);
  assert.equal((await call(env, "/api/agent/sources", { method: "POST", body: { platform: "booking", url: `${BK}/messaging/inbox.html`, why: "x" } })).status, 400);
  const id = a.body.id;
  assert.equal((await call(env, `/api/agent/sources/${id}/catalog`, { method: "POST", body: { metrics: [{ key: "cancel_rate", label: "取消率", hint: "Cancellation rate" }] } })).status, 409);
  // The collector: agent token cannot use the ingest side, ingest token can.
  assert.equal((await call(env, "/api/ingest/sources")).status, 401);
  const list = await call(env, "/api/ingest/sources", { token: "ingest" });
  assert.deepEqual(list.body.sources.map((s) => [s.id, s.status]), [[id, "approved"]]);
  assert.equal((await call(env, `/api/ingest/sources/${id}/probe`, { method: "POST", token: "ingest",
    body: { ok: true, final_url: url, title: "Cancellations", sample_text: "Cancellation rate 18.2%" } })).body.status, "probed");
  const sample = await call(env, `/api/agent/sources/${id}/sample`);
  assert.equal(sample.body.source.sample_text, "Cancellation rate 18.2%");
  const bad = await call(env, `/api/agent/sources/${id}/catalog`, { method: "POST", body: { metrics: [{ key: "pace_x", label: "x", hint: "y" }] } });
  assert.equal(bad.status, 400);
  const ok = await call(env, `/api/agent/sources/${id}/catalog`, { method: "POST", body: { metrics: [{ key: "cancel_rate", label: "取消率", unit: "%", hint: "Cancellation rate" }] } });
  assert.equal(ok.body.status, "active");
  const daily = await call(env, "/api/ingest/sources", { token: "ingest" });
  assert.equal(daily.body.sources[0].catalog[0].key, "cancel_rate");
  assert.equal((await call(env, `/api/agent/sources/${id}/status`, { method: "POST", body: { status: "retired", reason: "没用" } })).status, 200);
  assert.equal((await call(env, "/api/ingest/sources", { token: "ingest" })).body.sources.length, 0);
  env.DB.close();
});

test("approve mode: the agent can tighten it, only the collector side can loosen it; daily cap", async () => {
  const env = envFor();
  assert.equal((await call(env, "/api/agent/sources/mode", { method: "POST", body: { mode: "auto" } })).status, 400);
  assert.equal((await call(env, "/api/agent/sources/mode", { method: "POST", body: { mode: "approve" } })).status, 200);
  const a = await call(env, "/api/agent/sources", { method: "POST", body: { platform: "agoda", url: "https://ycs.agoda.com/en-us/kipp/1/report", why: "x" } });
  assert.equal(a.body.status, "proposed");
  assert.equal((await call(env, "/api/ingest/sources", { token: "ingest" })).body.sources.length, 0);
  assert.equal((await call(env, `/api/ingest/sources/${a.body.id}/approve`, { method: "POST", token: "ingest" })).body.status, "approved");
  for (const n of [2, 3]) await call(env, "/api/agent/sources", { method: "POST", body: { platform: "agoda", url: `https://ycs.agoda.com/r${n}`, why: "x" } });
  assert.equal((await call(env, "/api/agent/sources", { method: "POST", body: { platform: "agoda", url: "https://ycs.agoda.com/r4", why: "x" } })).status, 429);
  assert.equal((await call(env, "/api/ingest/sources/mode", { method: "POST", token: "ingest", body: { mode: "auto" } })).body.mode, "auto");
  env.DB.close();
});

test("builtin pages: the collector shares the text of fixed analysis pages; they are not read twice", async () => {
  const env = envFor();
  const r = await call(env, "/api/ingest/sources/builtin", { method: "POST", token: "ingest",
    body: { pages: [{ slug: "booking/genius", url: `${BK}/genius/room_select.html`, title: "Genius", sample_text: "Genius level 2 · 10% off" },
      { slug: "bad slug", sample_text: "x" }] } });
  assert.equal(r.body.pages, 1);
  await call(env, "/api/ingest/sources/builtin", { method: "POST", token: "ingest", body: { pages: [{ slug: "booking/genius", url: "u", title: "Genius", sample_text: "Genius level 3" }] } });
  const all = (await call(env, "/api/agent/sources")).body.sources;
  assert.equal(all.length, 1); assert.ok(all[0].builtin && all[0].has_sample);
  assert.equal((await call(env, `/api/agent/sources/${all[0].id}/sample`)).body.source.sample_text, "Genius level 3");
  assert.equal((await call(env, "/api/ingest/sources", { token: "ingest" })).body.sources.length, 0);
  env.DB.close();
});

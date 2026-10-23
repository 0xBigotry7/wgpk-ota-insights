import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { validateIngest, validateAdvice, reportBody, readReport, validateTodo, pushDigest, dispatchAlerts } from "../src/worker.js";
import { KNOWLEDGE, ROUTINES, periodKey, season, explain } from "../src/knowledge.js";
import { monitor, peerGap, digest } from "../src/monitor.js";
import { parseAnswer, context } from "../src/copilot.js";

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

test("daily reports keep highlights and watch, and old weekly rows still read", () => {
  const body = { id: "2026-10-22", summary: "s", highlights: [{ platform: "booking", tone: "bad", text: "均价低 21.14%" }],
    watch: ["点击率"], items: [{ platform: "booking", area: "price", priority: "high", owner: "收益/销售", title: "t",
      evidence: "e", analysis: "why", action: "a", expected: "x" }] };
  assert.deepEqual(validateAdvice(body), []);
  assert.ok(validateAdvice({ ...body, id: "today" }).length);
  const row = readReport({ id: body.id, items: JSON.stringify(reportBody(body)) });
  assert.equal(row.items[0].analysis, "why");
  assert.equal(row.highlights[0].tone, "bad");
  assert.deepEqual(row.watch, ["点击率"]);
  const old = readReport({ id: "2026-W43", items: JSON.stringify([{ title: "t" }]) });
  assert.equal(old.items[0].title, "t");
  assert.deepEqual(old.highlights, []);
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

const mk = (o) => ({ platform: "booking", period: "", unit: "", benchmark: null, page: "p", label: "x", ...o });
const now = new Date("2026-10-23T05:00:00Z");
const runs = [{ id: "20261023-102000" }];

test("gaps to the comp set are signed so that positive is good", () => {
  assert.equal(peerGap(mk({ metric: "click_rate", unit: "%", value: 2.56, benchmark: 3.1 })).toFixed(2), "-0.54");
  assert.ok(peerGap(mk({ metric: "problem_checkin", unit: "%", value: 32.4, benchmark: 17.8 })) < -14);
  assert.ok(peerGap(mk({ metric: "nps_12m", value: 53.6, benchmark: 40.8 })) > 30);
  assert.equal(peerGap(mk({ metric: "lowest_rate_next_28d", value: 1, benchmark: 2 })), null);
});

test("monitor flags trailing peers, drops, sign-outs and stale data; and lists wins", () => {
  const metrics = [
    mk({ metric: "adr_30d", period: "last_30_days", unit: "THB", label: "近30天平均房价", value: 5813, benchmark: 7372, day: "2026-10-23" }),
    mk({ platform: "medallia", metric: "nps_12m", period: "last_12_months", label: "NPS", value: 53.6, benchmark: 40.8, day: "2026-10-23" }),
    mk({ metric: "review_score", unit: "/10", label: "评分", value: 8.6, day: "2026-10-22" }),
    mk({ metric: "review_score", unit: "/10", label: "评分", value: 8.4, day: "2026-10-23" }),
    mk({ metric: "compset_views_rank", period: "last_90_days", value: 8, day: "2026-10-23" }),
    mk({ metric: "compset_size", period: "last_90_days", value: 11, day: "2026-10-23" }),
  ];
  metrics.push(mk({ metric: "adr_last_month", period: "last_month", unit: "THB", label: "上月平均房价", value: 5432, benchmark: 6890, day: "2026-10-23" }));
  const pages = [{ platform: "agoda", page: "landing", status: "signed_out" }, { platform: "expedia", page: "landing", status: "signed_out" }];
  const { alerts, wins } = monitor({ metrics, pages, runs }, now);
  const ids = alerts.map((a) => a.id);
  assert.ok(ids.includes("gap:booking|adr_30d@last_30_days"));
  assert.equal(alerts.find((a) => a.id === "gap:booking|adr_30d@last_30_days").owner, "收益/销售");
  assert.ok(ids.includes("drop:booking|review_score@"));
  assert.ok(ids.includes("page:agoda:landing") && ids.includes("page:expedia:landing"));
  assert.ok(!ids.includes("gap:booking|adr_last_month@last_month"), "this month's ADR gap covers last month's");
  assert.ok(ids.includes("rank:booking|compset_views_rank@last_90_days"));
  assert.ok(!ids.includes("run:stale"));
  assert.deepEqual(wins.map((w) => w.id), ["win:medallia|nps_12m@last_12_months"]);
  assert.equal(monitor({ metrics, pages, runs }, new Date("2026-10-25T05:00:00Z")).alerts[0].id, "run:stale");
  assert.match(digest({ alerts, wins }, { summary: "今天均价偏低" }, "https://ota"), /今天均价偏低[\s\S]*需要处理/);
});

test("copilot answers are parsed defensively and actions are limited to cockpit to-dos", () => {
  const a = parseAnswer('好的 {"reply":"均价低","actions":[{"type":"price","title":"提价","owner":"黑客","platform":"airbnb"}]}');
  assert.equal(a.reply, "均价低");
  assert.deepEqual(a.actions[0], { type: "todo", title: "提价", owner: "总经理", platform: "all", detail: "" });
  assert.deepEqual(parseAnswer("plain text"), { reply: "plain text", actions: [] });
  const c = context({ metrics: [mk({ metric: "adr_30d", label: "ADR", value: 1, benchmark: 2, day: "2026-10-23" })], todos: [] },
    { alerts: [], wins: [] });
  assert.match(c, /Booking ADR: 1，同类 2/);
});

test("to-dos need a title and known owners", () => {
  assert.deepEqual(validateTodo({ title: "t", owner: "前台", platform: "booking", source: "alert" }), []);
  assert.equal(validateTodo({ title: " ", owner: "x" }).length, 2);
});

test("viewer writes need a session from this site", async () => {
  const env = fakeEnv();
  const login = await worker.fetch(new Request("https://x/login", { method: "POST", body: new URLSearchParams({ password: "pw" }) }), env);
  const cookie = login.headers.get("Set-Cookie").split(";")[0];
  const body = JSON.stringify({ title: "t" });
  const cross = await worker.fetch(new Request("https://x/api/todos", { method: "POST", headers: { Cookie: cookie, Origin: "https://evil" }, body }), env);
  assert.equal(cross.status, 401);
  const anon = await worker.fetch(new Request("https://x/api/todos", { method: "POST", headers: { Origin: "https://x" }, body }), env);
  assert.equal(anon.status, 401);
  const token = await worker.fetch(new Request("https://x/api/todos", { method: "POST", headers: { Authorization: "Bearer tok", Origin: "https://x" }, body }), env);
  assert.equal(token.status, 401);
});

test("the daily push sends nothing until a chat is configured", async () => {
  const sent = [];
  assert.deepEqual(await pushDigest(fakeEnv(), async (...a) => sent.push(a)), { sent: false, reason: "not configured" });
  assert.equal(sent.length, 0);
});

test("knowledge: season by month, ISO weeks, glossary, routine ids are unique", () => {
  assert.equal(season(10).name, "旺季前爬坡");
  assert.equal(season(1).name, "旺季高峰");
  assert.equal(season(7).name, "淡季");
  assert.equal(periodKey("weekly", new Date("2026-10-23T05:00:00Z")), "2026-W43");
  assert.equal(periodKey("daily", new Date("2026-10-23T18:00:00Z")), "2026-10-24", "Bangkok day");
  assert.equal(periodKey("monthly", new Date("2026-10-23T05:00:00Z")), "2026-10");
  assert.match(explain("click_rate"), /首图/);
  const ids = Object.values(ROUTINES).flat().map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!KNOWLEDGE.includes("`"));
});

test("playbook diagnoses rate-led volume and the list-view problem instead of single gaps", () => {
  const metrics = [
    mk({ metric: "adr_mtd", period: "month_to_date", unit: "THB", label: "本月平均房价", value: 5813.79, benchmark: 7372.57, day: "2026-10-22" }),
    mk({ metric: "adr_last_month", period: "last_month", unit: "THB", label: "上月平均房价", value: 5432, benchmark: 6890, day: "2026-10-22" }),
    mk({ metric: "room_nights_mtd", period: "month_to_date", label: "本月间夜", value: 950, benchmark: 747, day: "2026-10-22" }),
    mk({ metric: "search_views_vs_peer", period: "funnel", unit: "%", label: "曝光较同类", value: 36.93, day: "2026-10-22" }),
    mk({ metric: "click_rate", period: "funnel", unit: "%", label: "点击率", value: 2.56, benchmark: 3.1, day: "2026-10-22" }),
    mk({ platform: "ctrip", metric: "review_score", unit: "/5", label: "点评分", value: 4.6, day: "2026-10-22" }),
  ];
  const { alerts, season: s } = monitor({ metrics, pages: [], runs }, now);
  const ids = alerts.map((a) => a.id);
  assert.deepEqual(ids.slice(0, 2), ["diag:booking:rate-led", "diag:booking:list-view"]);
  assert.ok(!ids.some((id) => id.startsWith("gap:booking|adr_") || id.startsWith("gap:booking|click_rate")));
  assert.ok(ids.includes("rule:ctrip|review_score@"));
  assert.match(alerts[0].title, /127%.*79%/);
  assert.equal(alerts[0].steps.length, 3);
  assert.equal(s.name, "旺季前爬坡");
});

test("the daily dispatch turns serious alerts into to-dos once", async () => {
  const env = fakeEnv();
  const r = await dispatchAlerts(env);   // empty database: one critical "no runs" alert
  assert.equal(r.created, 1);
  assert.match(env.writes[0].sql, /insert into todos/);
  assert.equal(env.writes[0].a[6], "run:none");
});

test("routine ticks only accept known items", async () => {
  const env = fakeEnv();
  const login = await worker.fetch(new Request("https://x/login", { method: "POST", body: new URLSearchParams({ password: "pw" }) }), env);
  const cookie = login.headers.get("Set-Cookie").split(";")[0];
  const post = (body) => worker.fetch(new Request("https://x/api/routines", { method: "POST",
    headers: { Cookie: cookie, Origin: "https://x" }, body: JSON.stringify(body) }), env);
  assert.equal((await post({ item: "nope", done: true })).status, 400);
  const ok = await post({ item: "d-pickup", done: true });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).period.length, 10);
});

test("health grid, coverage and stale-platform alerts", async () => {
  const { health } = await import("../src/monitor.js");
  const now = new Date("2026-10-25T06:00:00Z");
  const history = [
    { run_id: "20261023-102000", platform: "booking", page: "landing", status: "signed_out" },
    { run_id: "20261024-102000", platform: "booking", page: "landing", status: "signed_out" },
    { run_id: "20261025-102000", platform: "booking", page: "landing", status: "signed_out" },
    { run_id: "20261025-102000", platform: "expedia", page: "landing", status: "ok" },
    { run_id: "20261025-102000", platform: "expedia", page: "home", status: "error" },
    { run_id: "20261025-102000", platform: "medallia", page: "landing", status: "ok" },
  ];
  const runs = [{ id: "20261025-102000" }, { id: "20261024-102000" }, { id: "20261023-102000" }];
  const metrics = [
    { day: "2026-10-22", platform: "booking", metric: "adr_mtd", period: "month_to_date", label: "ADR", value: 5800, unit: "THB" },
    { day: "2026-10-22", platform: "expedia", metric: "page_views", period: "", label: "浏览", value: 10, unit: "" },
    { day: "2026-10-25", platform: "medallia", metric: "nps", period: "", label: "NPS", value: 50, unit: "" },
  ];
  const h = health({ metrics, runs, history }, now);
  assert.equal(h.days.length, 14);
  assert.equal(h.days.at(-1), "2026-10-25");
  const b = h.platforms.find((p) => p.platform === "booking");
  assert.equal(b.signed_out_days, 3);
  assert.equal(b.days_since_data, 3);
  assert.equal(h.platforms.find((p) => p.platform === "expedia").cells.at(-1).state, "partial");
  assert.deepEqual([h.coverage.got, h.coverage.expected], [1, 3]);
  assert.equal(h.runs.days_with_run, 3);

  const pages = [{ platform: "booking", page: "landing", status: "signed_out" }, { platform: "expedia", page: "landing", status: "ok" }];
  const { alerts } = monitor({ metrics, pages, runs, history }, now);
  const so = alerts.find((a) => a.id === "page:booking:landing");
  assert.equal(so.level, "critical");
  assert.match(so.title, /连续 3 天/);
  assert.ok(alerts.find((a) => a.id === "stale:expedia"));
  assert.ok(!alerts.find((a) => a.id === "stale:booking"), "a sign-out already explains booking");
});

test("a skipped run does not count as fresh data", () => {
  const now = new Date("2026-10-25T05:00:00Z");
  const runs = [{ id: "20261025-102000", outcome: "skipped" }, { id: "20261023-102000", outcome: "done" }];
  const ids = monitor({ metrics: [], pages: [], runs }, now).alerts.map((a) => a.id);
  assert.ok(ids.includes("run:skipped"));
  assert.ok(ids.includes("run:stale"));
});

test("pace vs last year, cancellations and lost bookings", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  const metrics = [
    mk({ platform: "booking", metric: "otb_room_nights_30d", period: "next_30_days", label: "未来30天在手间夜", value: 739, benchmark: 1009, day: "2026-10-23" }),
    mk({ platform: "booking", metric: "otb_adr_30d", period: "next_30_days", label: "未来30天在手房价", value: 6448, unit: "THB", benchmark: 4944, day: "2026-10-23" }),
    mk({ platform: "booking", metric: "cancellation_rate", period: "", label: "取消率", value: 38, unit: "%", benchmark: 31, day: "2026-10-23" }),
    mk({ platform: "agoda", metric: "bookings_lost_30d", period: "next_30_days", label: "流失", value: 58, day: "2026-10-23" }),
  ];
  const { alerts, wins } = monitor({ metrics, pages: [], runs: [{ id: "20261023-190541", outcome: "done" }] }, now);
  const pace = alerts.find((a) => a.id === "diag:booking:otb-pace");
  assert.match(pace.title, /少 27%，房价高 30%/);
  assert.ok(!alerts.some((a) => a.id === "gap:booking|otb_room_nights_30d@next_30_days"));
  const cancel = alerts.find((a) => a.id === "gap:booking|cancellation_rate@");
  assert.ok(cancel, "a higher cancellation rate is bad");
  assert.match(cancel.title, /比同类高/);
  assert.ok(!wins.some((w) => /cancellation/.test(w.id)));
  assert.equal(alerts.find((a) => a.id === "rule:agoda|bookings_lost_30d@next_30_days").level, "serious");
  const adr = [...alerts, ...wins].find((x) => x.id.endsWith("otb_adr_30d@next_30_days"));
  assert.match(adr.title, /去年同期/);
});

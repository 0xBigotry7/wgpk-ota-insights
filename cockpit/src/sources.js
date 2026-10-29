// Data sources the agent adds itself: an OTA back-office page to read in the daily collection, and what to extract
// from it. The agent never opens a browser; the Mac mini collector probes and reads these pages read-only (GET
// navigation, no clicks, outside the review operator's slots). The hard limits live here and in the collector.
//
// Lifecycle: proposed → (approved, by mode) → probed | rejected → active (once the agent sets a catalog) → retired.
// mode "auto": a valid request is approved at once; mode "approve": it waits for a person (status stays proposed).

export const SOURCE_HOSTS = {
  booking: ["admin.booking.com"],
  agoda: ["portal.agoda.com", "ycs.agoda.com"],
  ctrip: ["ebooking.ctrip.com"],
  expedia: ["apps.expediapartnercentral.com"],
  // No Medallia: its pages are numbered, so a URL cannot tell an analysis page from one guest's survey.
};
// Pages that act or hold guest conversations: never read, whatever the agent asks. Verbs match whole words of the
// path and query (split on punctuation and camelCase), so "cancellations" or "credit" stay readable while
// "cancel" or "edit" do not; guest-conversation words match anywhere.
const DENY_WORDS = new Set(["reply", "replies", "respond", "submit", "save", "update", "edit", "delete", "remove", "cancel",
  "close", "logout", "signout", "login", "signin", "payment", "payments", "payout", "payouts", "invoice", "invoices", "bank",
  "password", "confirm", "publish", "toggle", "approve", "accept", "decline", "modify", "create"]);
const DENY_ANY = /(message|inbox|chat|conversation|review|guest[-_]?list|reservation[-_]?detail|答复|回复|订单|消息|点评|评论|聊天|预订详情)/i;
const words = (s) => s.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
export const MAX_ACTIVE = 10;
export const MAX_PROPOSED_PER_DAY = 3;
const STATUSES = ["proposed", "approved", "probed", "active", "rejected", "retired"];
const KEY = /^[a-z][a-z0-9_]{2,47}$/;
const BUILTIN_KEY = /^(pace|pickup_\d+d|otb|stayed)_/;   // keys the fixed catalog already owns

const iso = () => new Date().toISOString();
const clip = (s, n) => String(s ?? "").slice(0, n);
const safe = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

/** Why a URL may not be read, or null when it is an allowed read-only OTA back-office page. */
export function urlProblem(platform, raw) {
  const hosts = SOURCE_HOSTS[platform];
  if (!hosts) return `platform must be one of ${Object.keys(SOURCE_HOSTS).join(", ")}`;
  let u;
  try { u = new URL(raw); } catch { return "url must be a full https URL"; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return "url must be plain https";
  if (!hosts.includes(u.hostname)) return `host must be one of ${hosts.join(", ")}`;
  let text;
  try { text = decodeURIComponent(u.pathname + u.search + u.hash); } catch { return "url is not decodable"; }
  if (DENY_ANY.test(text) || words(text).some((w) => DENY_WORDS.has(w))) return "this page can act or holds guest messages; not readable";
  return null;
}

function catalogProblems(metrics) {
  if (!Array.isArray(metrics) || !metrics.length || metrics.length > 30) return ["metrics: 1–30 entries"];
  const out = [];
  metrics.forEach((m, i) => {
    if (!m || !KEY.test(m.key || "")) out.push(`metrics[${i}].key: lower_snake_case, 3–48 chars`);
    else if (BUILTIN_KEY.test(m.key)) out.push(`metrics[${i}].key: ${m.key} belongs to the fixed catalog`);
    if (!String(m?.label || "").trim()) out.push(`metrics[${i}].label required`);
    if (!String(m?.hint || "").trim()) out.push(`metrics[${i}].hint required: the label text next to the number on the page`);
  });
  return out;
}

const view = (r, withSample = false) => ({ id: r.id, platform: r.platform, url: r.url, why: r.why, status: r.status,
  reason: r.reason || null, created_at: r.created_at, updated_at: r.updated_at, probed_at: r.probed_at || null,
  final_url: r.final_url || null, title: r.title || null, catalog: safe(r.catalog, []), builtin: !!r.builtin, slug: r.slug || null,
  ...(withSample ? { sample_text: r.sample_text || null } : { has_sample: !!r.sample_text }) });

export async function sourceMode(db) {
  const r = await db.prepare("select value from agent_settings where key = 'source_mode'").first().catch(() => null);
  return r?.value === "approve" ? "approve" : "auto";
}

export async function setMode(db, mode) {
  await db.prepare(`insert into agent_settings (key, value, updated_at) values ('source_mode', ?, ?)
    on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`).bind(mode, iso()).run();
}

/** Agent side: /api/agent/sources[...]. Returns a JSON-able object, with status for errors. */
export async function handleSources(request, db, route) {
  const body = request.method === "POST" ? await request.json().catch(() => null) : null;
  if (request.method === "GET" && route === "sources") {
    const r = await db.prepare("select * from agent_sources order by id desc limit 100").all();
    return { mode: await sourceMode(db), limits: { active: MAX_ACTIVE, proposed_per_day: MAX_PROPOSED_PER_DAY, hosts: SOURCE_HOSTS },
      sources: (r.results || []).map((x) => view(x)) };
  }
  if (request.method === "POST" && route === "sources") {
    if (!body) return { error: "body must be JSON", status: 400 };
    const problem = urlProblem(body.platform, body.url);
    if (problem) return { error: problem, status: 400 };
    if (!String(body.why || "").trim()) return { error: "why is required: what decision this data serves", status: 400 };
    const dup = await db.prepare("select id, status from agent_sources where url = ? and status not in ('rejected', 'retired')").bind(body.url).first();
    if (dup) return { error: `already requested as #${dup.id} (${dup.status})`, status: 409 };
    const today = await db.prepare("select count(*) as n from agent_sources where builtin = 0 and created_at >= ?").bind(iso().slice(0, 10)).first();
    if ((today?.n || 0) >= MAX_PROPOSED_PER_DAY) return { error: `at most ${MAX_PROPOSED_PER_DAY} new sources a day`, status: 429 };
    const status = (await sourceMode(db)) === "auto" ? "approved" : "proposed";
    const r = await db.prepare(`insert into agent_sources (platform, url, why, status, catalog, created_at, updated_at, builtin)
      values (?, ?, ?, ?, ?, ?, ?, 0)`).bind(body.platform, body.url, clip(body.why.trim(), 500), status, "[]", iso(), iso()).run();
    return { ok: true, id: r.meta?.last_row_id, status,
      next: status === "approved" ? "the collector probes it in its next free window; then read GET /api/agent/sources/:id/sample"
        : "waiting for Gary's approval" };
  }
  if (request.method === "POST" && route === "sources/mode") {
    // The agent can only make itself stricter; going back to auto is Gary's call (ingest/admin side).
    if (body?.mode !== "approve") return { error: "the agent can only switch to approve mode", status: 400 };
    await setMode(db, "approve");
    return { ok: true, mode: "approve" };
  }
  const m = route.match(/^sources\/(\d+)(?:\/(sample|catalog|status))?$/);
  if (!m) return null;
  const row = await db.prepare("select * from agent_sources where id = ?").bind(Number(m[1])).first();
  if (!row) return { error: "unknown source", status: 404 };
  if (request.method === "GET" && (!m[2] || m[2] === "sample")) return { source: view(row, m[2] === "sample") };
  if (request.method === "POST" && m[2] === "catalog") {
    if (!["probed", "active"].includes(row.status)) return { error: `source is ${row.status}; a catalog needs a probed page`, status: 409 };
    const errs = catalogProblems(body?.metrics);
    if (errs.length) return { error: "invalid catalog", details: errs, status: 400 };
    const active = await db.prepare("select count(*) as n from agent_sources where status = 'active' and builtin = 0 and id != ?").bind(row.id).first();
    if (!row.builtin && (active?.n || 0) >= MAX_ACTIVE) return { error: `at most ${MAX_ACTIVE} active sources; retire one first`, status: 429 };
    const catalog = body.metrics.map((x) => ({ key: x.key, label: clip(x.label, 60), unit: clip(x.unit, 12), period: clip(x.period, 20),
      hint: clip(x.hint, 200), peer: !!x.peer }));
    await db.prepare("update agent_sources set catalog = ?, status = 'active', updated_at = ? where id = ?").bind(JSON.stringify(catalog), iso(), row.id).run();
    return { ok: true, status: "active", metrics: catalog.length, next: "read daily from the next 10:20 collection" };
  }
  if (request.method === "POST" && m[2] === "status") {
    if (body?.status !== "retired") return { error: "the agent can only retire a source", status: 400 };
    await db.prepare("update agent_sources set status = 'retired', reason = ?, updated_at = ? where id = ?").bind(clip(body.reason, 300), iso(), row.id).run();
    return { ok: true };
  }
  return null;
}

/** Collector side (OTA_INGEST_TOKEN): what to probe and read, and probe results back. */
export async function ingestSources(request, db, path) {
  if (request.method === "GET" && path === "/api/ingest/sources") {
    const r = await db.prepare("select * from agent_sources where status in ('approved', 'active') and builtin = 0 order by id").all();
    // Re-check every URL on the way out: a row edited by hand still cannot reach a denied page.
    return { mode: await sourceMode(db), sources: (r.results || []).filter((x) => !urlProblem(x.platform, x.url))
      .map((x) => ({ id: x.id, platform: x.platform, url: x.url, status: x.status, catalog: safe(x.catalog, []) })) };
  }
  if (request.method === "POST" && path === "/api/ingest/sources/mode") {
    const body = await request.json().catch(() => null);
    if (!["auto", "approve"].includes(body?.mode)) return { error: "mode must be auto or approve", status: 400 };
    await setMode(db, body.mode);
    return { ok: true, mode: body.mode };
  }
  if (request.method === "POST" && path === "/api/ingest/sources/builtin") {
    // Text of the collector's fixed analysis pages (Genius, competitive set, opportunities...), already sanitized.
    const body = await request.json().catch(() => null);
    const pages = Array.isArray(body?.pages) ? body.pages.slice(0, 30) : [];
    let n = 0;
    for (const p of pages) {
      if (!/^[a-z]+\/[a-z0-9-]+$/.test(p?.slug || "") || !SOURCE_HOSTS[p.slug.split("/")[0]] || !String(p.sample_text || "").trim()) continue;
      const row = await db.prepare("select id from agent_sources where builtin = 1 and slug = ?").bind(p.slug).first();
      const vals = [clip(p.url, 500), clip(p.title, 200), clip(p.sample_text, 20000), iso()];
      if (row) await db.prepare("update agent_sources set url = ?, title = ?, sample_text = ?, probed_at = ?, updated_at = probed_at where id = ?").bind(...vals, row.id).run();
      else await db.prepare(`insert into agent_sources (platform, url, why, status, catalog, created_at, updated_at, probed_at, title, sample_text, builtin, slug)
        values (?, ?, ?, 'active', '[]', ?, ?, ?, ?, ?, 1, ?)`).bind(p.slug.split("/")[0], vals[0], `固定采集页 ${p.slug} 的文字内容`, vals[3], vals[3], vals[3], vals[1], vals[2], p.slug).run();
      n++;
    }
    return { ok: true, pages: n };
  }
  const ap = path.match(/^\/api\/ingest\/sources\/(\d+)\/approve$/);
  if (request.method === "POST" && ap) {
    const r = await db.prepare("update agent_sources set status = 'approved', updated_at = ? where id = ? and status = 'proposed'").bind(iso(), Number(ap[1])).run();
    return r.meta?.changes ? { ok: true, status: "approved" } : { error: "not a proposed source", status: 409 };
  }
  const m = path.match(/^\/api\/ingest\/sources\/(\d+)\/probe$/);
  if (request.method === "POST" && m) {
    const body = await request.json().catch(() => null);
    const row = await db.prepare("select * from agent_sources where id = ?").bind(Number(m[1])).first();
    if (!row) return { error: "unknown source", status: 404 };
    if (!body || typeof body.ok !== "boolean") return { error: "ok (boolean) is required", status: 400 };
    const next = body.ok ? (row.status === "active" ? "active" : "probed") : "rejected";
    await db.prepare(`update agent_sources set status = ?, reason = ?, probed_at = ?, final_url = ?, title = ?, sample_text = ?, updated_at = ?
      where id = ?`).bind(next, body.ok ? null : clip(body.reason || "probe failed", 300), iso(), clip(body.final_url, 500),
      clip(body.title, 200), body.ok ? clip(body.sample_text, 20000) : null, iso(), row.id).run();
    return { ok: true, status: next };
  }
  return null;
}

export { STATUSES };

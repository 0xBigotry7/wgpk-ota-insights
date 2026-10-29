// On-demand re-collection the agent asks for (Gary 2026-10-29): when a platform's numbers are stale or someone asks
// about it, the agent queues a refresh; the Mac mini collector reads those platforms read-only at its next free
// slot (outside the review operator's windows, holding its lock) and reports back. The agent never drives a browser.
//
// Lifecycle: pending → running (claimed by the collector) → done | skipped (back to pending) | failed.
// A new request while one is pending merges its platforms into it, so the queue never holds more than one.

export const REFRESH_PLATFORMS = ["booking", "agoda", "expedia", "ctrip", "google", "tripadvisor", "medallia"];
// Gary 2026-10-29: OTA work is not hour-by-hour; the daily 10:20 read plus at most one extra read a day.
export const MAX_REFRESH_PER_DAY = 1;
// The collector's launchd slots after the daily 10:20 run, all clear of the review windows (Asia/Bangkok).
export const REFRESH_SLOTS = ["12:35", "17:05", "19:30", "22:15"];
const RUNNING_STALE_S = 1800;           // a claim this old without a result goes back to pending

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const clip = (s, n) => String(s ?? "").slice(0, n);
const safe = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const bkkDay = (ms = Date.now()) => new Date(ms + 7 * 3600e3).toISOString().slice(0, 10);

/** The next collector slot after now, as "HH:MM" Bangkok time (tomorrow's first slot after the last one). */
export function nextSlot(ms = Date.now()) {
  const hm = new Date(ms + 7 * 3600e3).toISOString().slice(11, 16);
  return REFRESH_SLOTS.find((s) => s > hm) || `明天 ${REFRESH_SLOTS[0]}`;
}

const view = (r) => ({ id: r.id, created_at: r.created_at, platforms: safe(r.platforms, []), reason: r.reason, status: r.status,
  picked_at: r.picked_at, finished_at: r.finished_at, run_id: r.run_id, detail: r.detail });

/** Agent side: GET /api/agent/refresh (recent requests) and POST /api/agent/refresh {platforms, reason}. */
export async function handleRefresh(request, db, now = Date.now()) {
  if (request.method === "GET") {
    const r = await db.prepare("select * from refresh_requests order by id desc limit 10").all();
    return { limits: { per_day: MAX_REFRESH_PER_DAY, platforms: REFRESH_PLATFORMS, slots: REFRESH_SLOTS }, next_slot: nextSlot(now),
      requests: (r.results || []).map(view) };
  }
  const body = await request.json().catch(() => null);
  if (!body) return { error: "body must be JSON", status: 400 };
  const platforms = [...new Set((Array.isArray(body.platforms) ? body.platforms : []).map((p) => String(p).trim().toLowerCase()))];
  const bad = platforms.filter((p) => !REFRESH_PLATFORMS.includes(p));
  if (!platforms.length || bad.length) return { error: `platforms must be a non-empty list from ${REFRESH_PLATFORMS.join(", ")}`, status: 400 };
  const reason = clip(String(body.reason || "").trim(), 300);
  if (!reason) return { error: "reason is required: which question or decision needs fresher numbers", status: 400 };

  const open = await db.prepare("select * from refresh_requests where status = 'pending' order by id limit 1").first();
  if (open) {
    const merged = [...new Set([...safe(open.platforms, []), ...platforms])];
    await db.prepare("update refresh_requests set platforms = ?, reason = ? where id = ?")
      .bind(JSON.stringify(merged), clip(`${open.reason}；${reason}`, 600), open.id).run();
    return { ok: true, id: open.id, status: "pending", merged: true, platforms: merged, next_slot: nextSlot(now) };
  }
  // Failed requests do not count: the agent may ask again after a collector error.
  const today = bkkDay(now);
  const recent = (await db.prepare("select created_at from refresh_requests where status != 'failed' order by id desc limit 10").all()).results || [];
  if (recent.filter((r) => bkkDay(Date.parse(r.created_at)) === today).length >= MAX_REFRESH_PER_DAY) {
    return { error: `daily limit reached (${MAX_REFRESH_PER_DAY} refresh a day besides the 10:20 read); use the numbers you have and say how old they are`, status: 429 };
  }
  const r = await db.prepare("insert into refresh_requests (created_at, platforms, reason, status) values (?, ?, ?, 'pending')")
    .bind(iso(now), JSON.stringify(platforms), reason).run();
  return { ok: true, id: r.meta?.last_row_id, status: "pending", platforms, next_slot: nextSlot(now) };
}

/** Collector side: GET /api/ingest/refresh/next claims the waiting request; POST /api/ingest/refresh/:id reports. */
export async function ingestRefresh(request, db, path, now = Date.now()) {
  if (request.method === "GET" && path === "/api/ingest/refresh/next") {
    await db.prepare("update refresh_requests set status = 'pending', picked_at = null where status = 'running' and picked_at < ?")
      .bind(iso(now - RUNNING_STALE_S * 1000)).run();
    const row = await db.prepare("select * from refresh_requests where status = 'pending' order by id limit 1").first();
    if (!row) return { request: null };
    await db.prepare("update refresh_requests set status = 'running', picked_at = ? where id = ?").bind(iso(now), row.id).run();
    return { request: { id: row.id, platforms: safe(row.platforms, []).filter((p) => REFRESH_PLATFORMS.includes(p)), reason: row.reason } };
  }
  const m = path.match(/^\/api\/ingest\/refresh\/(\d+)$/);
  if (request.method === "POST" && m) {
    const body = await request.json().catch(() => null);
    if (!["done", "skipped", "failed"].includes(body?.status)) return { error: "status must be done, skipped or failed", status: 400 };
    const row = await db.prepare("select * from refresh_requests where id = ?").bind(Number(m[1])).first();
    if (!row) return { error: "unknown request", status: 404 };
    // Skipped (a review window, the operator busy, no Chrome): back in the queue for the next slot.
    const status = body.status === "skipped" ? "pending" : body.status;
    await db.prepare(`update refresh_requests set status = ?, finished_at = ?, run_id = ?, detail = ?${status === "pending" ? ", picked_at = null" : ""} where id = ?`)
      .bind(status, status === "pending" ? null : iso(now), clip(body.run_id || "", 40) || null, clip(body.detail || "", 500) || null, row.id).run();
    return { ok: true, id: row.id, status };
  }
  return null;
}

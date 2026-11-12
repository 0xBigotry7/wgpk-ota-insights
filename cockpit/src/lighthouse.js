// Lighthouse (ex OTA Insight) market and events views for the ota agent. Event-driven, no poller: when a report
// reaches lighthouse-reports@, the inbox Worker wgpk-lighthouse-email-ingest (wgpk-concierge
// infra/lighthouse-email-worker) parses the XLSX (a port of ota/lighthouse_mail.py) and posts the views here over a
// service binding: latest market, latest events, market change between the last two deliveries, and `status`
// (did the newest report parse). The cockpit stores only the latest of each; history stays in the inbox's D1.
export const LIGHTHOUSE_VIEWS = ["market", "events", "compare_market", "status"];
export const AGENT_VIEWS = [...LIGHTHOUSE_VIEWS, "brief", "briefs"];
const MAX_VIEW_BYTES = 1_500_000;

/** POST /api/ingest/lighthouse {generated_at, views: {market, events, compare_market, status}} (Bearer OTA_INGEST_TOKEN). */
export async function ingestLighthouse(request, db, now = new Date()) {
  let body;
  try { body = await request.json(); } catch { return { error: "body must be JSON", status: 400 }; }
  const views = body?.views;
  if (!views || typeof views !== "object" || Array.isArray(views)) return { error: "views must be an object", status: 400 };
  const unknown = Object.keys(views).filter((v) => !LIGHTHOUSE_VIEWS.includes(v));
  if (unknown.length) return { error: `unknown view: ${unknown.join(", ")}`, status: 400 };
  const at = now.toISOString(), stmts = [], stored = [];
  for (const view of LIGHTHOUSE_VIEWS) {
    const data = views[view];
    if (data === undefined || data === null) continue;                     // nothing yet: keep what is there
    if (typeof data !== "object" || Array.isArray(data)) return { error: `${view} must be an object`, status: 400 };
    const text = JSON.stringify(data);
    if (text.length > MAX_VIEW_BYTES) return { error: `${view} over 1.5 MB`, status: 413 };
    const received = typeof data.received_at === "string" ? data.received_at
      : typeof data.current_received_at === "string" ? data.current_received_at : null;
    stmts.push(db.prepare(`insert into lighthouse_views (view, received_at, generated_at, stored_at, body) values (?, ?, ?, ?, ?)
      on conflict(view) do update set received_at = excluded.received_at, generated_at = excluded.generated_at,
      stored_at = excluded.stored_at, body = excluded.body`)
      .bind(view, received, String(body.generated_at || at).slice(0, 40), at, text));
    stored.push(view);
    if (view === "market" && received) {
      stmts.push(db.prepare("insert or ignore into lighthouse_market_history (received_at, stored_at, body) values (?, ?, ?)").bind(received, at, text));
    }
  }
  if (stmts.length) await db.batch(stmts);
  return { ok: true, stored };
}

const viewRow = (db, view) =>
  db.prepare("select view, received_at, generated_at, stored_at, body from lighthouse_views where view = ?").bind(view).first();

/** GET /api/agent/lighthouse?view=market|events|compare_market|status|brief|briefs (default market). brief = the
 * Lighthouse × OTA cross-read for today (lighthouse-brief.js), briefs = headlines of the stored daily briefs. Every answer carries
 * `inbox_status`, so the agent can say "a new report arrived but could not be read". */
export async function agentLighthouse(db, params, briefOf = null) {
  const view = params.get("view") || "market";
  if (!AGENT_VIEWS.includes(view)) return { error: `view must be one of ${AGENT_VIEWS.join(", ")}`, status: 400 };
  if (view === "brief") return { view, ...(briefOf ? await briefOf() : { available: false }) };
  if (view === "briefs") {
    const days = Math.max(1, Math.min(60, Number(params.get("days")) || 14));
    const r = await db.prepare("select day, received_at, generated_at, body from lighthouse_briefs order by day desc limit ?").bind(days).all();
    return { view, briefs: (r.results || []).map((x) => { const b = JSON.parse(x.body);
      return { day: x.day, received_at: x.received_at, generated_at: x.generated_at, headline: b.headline,
        actions: (b.actions || []).map((a) => ({ kind: a.kind, title: a.title, channels: a.channels, date_text: a.date_text })) }; }) };
  }
  const [row, status] = await Promise.all([viewRow(db, view), view === "status" ? null : viewRow(db, "status")]);
  const inbox_status = status ? JSON.parse(status.body) : null;
  if (!row) {
    return { view, available: false, inbox_status,
      note: "No Lighthouse delivery yet (needs a scheduled report e-mailed to lighthouse-reports@; compare_market needs two)." };
  }
  return { view, available: true, received_at: row.received_at, generated_at: row.generated_at, stored_at: row.stored_at,
    note: "received_at is when the e-mail arrived, not Lighthouse's own refresh time. Prices are public rates, not ADR.",
    data: JSON.parse(row.body), ...(view === "status" ? {} : { inbox_status }) };
}

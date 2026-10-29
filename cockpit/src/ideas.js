// IDeaS G3 Data Extraction report (Excel, property level) -> per stay date numbers the agent learns from.
// The report arrives at ideas-reports@ (archive Worker wgpk-ideas-email-ingest) or, until IDeaS scheduling is
// allowed, as one manual export posted to /api/ingest/ideas. IDeaS output is a teacher to compare against,
// not ground truth. Only numbers and the special-event label are kept; report criteria such as the user who
// ran it or the account id are never read.
const VERSION = 'ideas-bridge-v1';
export const IDEAS_ADDRESS = 'ideas-reports@wyndhamgardenkamala.com';
const MAX_BYTES = 3 * 1024 * 1024;
const sha = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');

// ---- minimal xlsx reader: zip central directory + deflate-raw + sheet XML (inline or shared strings) ----

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzip(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('unsupported_ideas_file');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = new Map(), decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('unsupported_ideas_file');
    const method = view.getUint16(p + 10, true), size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true), extraLen = view.getUint16(p + 30, true), commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true), name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    files.set(name, { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...files.keys()],
    async text(name) {
      const f = files.get(name);
      if (!f) return null;
      const start = f.local + 30 + view.getUint16(f.local + 26, true) + view.getUint16(f.local + 28, true);
      const raw = bytes.subarray(start, start + f.size);
      if (f.method === 0) return decoder.decode(raw);
      if (f.method === 8) return decoder.decode(await inflate(raw));
      throw new Error('unsupported_ideas_file');
    },
  };
}

const unescape = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const runText = s => unescape([...s.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1]).join(''));

/** Rows of a sheet as {column letter: value}; numbers stay strings so callers decide how to read them. */
export function sheetRows(xml, shared = []) {
  const rows = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = c[1].match(/r="([A-Z]+)\d+"/), type = (c[1].match(/t="(\w+)"/) || [])[1] || '', inner = c[2] || '';
      if (!ref) continue;
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      cells[ref[1]] = type === 'inlineStr' ? runText(inner) : type === 's' ? (shared[Number(v)] ?? '') : unescape(v ?? '');
    }
    rows.push(cells);
  }
  return rows;
}

async function workbook(bytes) {
  const zip = await unzip(bytes);
  const shared = await zip.text('xl/sharedStrings.xml');
  const strings = shared ? [...shared.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => runText(m[1])) : [];
  const wb = await zip.text('xl/workbook.xml'), rels = await zip.text('xl/_rels/workbook.xml.rels');
  if (!wb || !rels) throw new Error('unsupported_ideas_file');
  const sheets = {};
  for (const s of wb.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const target = (rels.match(new RegExp(`Id="${s[2]}"[^>]*Target="([^"]+)"`)) || rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${s[2]}"`)) || [])[1];
    if (target) sheets[unescape(s[1])] = target.replace(/^\/?(xl\/)?/, 'xl/');
  }
  return { sheet: async name => sheets[name] ? sheetRows(await zip.text(sheets[name]) || '', strings) : null };
}

// ---- Data Extraction layout ----

const FIELDS = {
  capacity: 'Physical Capacity This Year',
  remaining: 'Remaining Capacity This Year',
  otb: 'Occupancy On Books This Year',
  otb_stly: 'Occupancy On Books STLY',
  otb_group: 'Rooms Sold - Group This Year',
  otb_transient: 'Rooms Sold - Transient This Year',
  ooo: 'Rooms N/A - Out of Order This Year',
  cancelled: 'Cancelled This Year',
  revenue_otb: 'Booked Room Revenue This Year',
  revenue_stly: 'Booked Room Revenue STLY',
  revenue_forecast: 'Forecasted Room Revenue This Year',
  budget_revenue: 'Budget Room Revenue This Year',
  occ_forecast: 'Occupancy Forecast - Total This Year',
  budget_rooms: 'Budget Occupancy - Total This Year',
  unconstrained_demand: 'System Total Demand - Total This Year',
  overbooking: 'Overbooking This Year',
  revpar: 'RevPAR On Books This Year',
  revpar_forecast: 'RevPAR Forecast This Year',
  adr: 'ADR On Books This Year',
  adr_forecast: 'ADR Forecast This Year',
  lrv: 'Last Room Value This Year',
  wash_pct: 'Wash % This Year',
  bar: 'BAR',
  floor: 'Floor',
  ceiling: 'Ceiling',
};
export const IDEAS_FIELDS = Object.keys(FIELDS);
const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function num(value) {
  const s = String(value ?? '').trim().replaceAll(',', '');
  if (!s) return null;
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) throw new Error('invalid_ideas_number');
  return Number(s);
}

/** Excel serial (46324 = 2026-10-29) or dd-Mon-yyyy. */
export function ideasDate(value) {
  const s = String(value ?? '').trim();
  if (/^\d{5}(\.0+)?$/.test(s)) return new Date(Date.UTC(1899, 11, 30) + Number(s) * 864e5).toISOString().slice(0, 10);
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (m && MONTHS.includes(m[2].toLowerCase())) return `${m[3]}-${String(MONTHS.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  throw new Error('invalid_ideas_date');
}

/** Parse one Data Extraction export: {snapshot, rows}. Fails closed on any layout it does not recognise. */
export async function parseIdeas(bytes) {
  if (bytes.byteLength > MAX_BYTES) throw new Error('unsupported_ideas_file');
  const checksum = await sha(bytes);
  const book = await workbook(bytes);
  const data = await book.sheet('Property');
  if (!data || !data.length) throw new Error('unsupported_ideas_layout');
  const header = data[0], col = {};
  for (const [letter, name] of Object.entries(header)) col[norm(name)] = letter;
  const need = ['Occupancy Date', FIELDS.otb, FIELDS.occ_forecast, FIELDS.bar];
  if (!need.every(n => col[norm(n)])) throw new Error('unsupported_ideas_layout');
  const competitors = Object.entries(header).map(([letter, name]) => [letter, String(name).match(/^Competitor Rate For\s*(.+?) This Year$/i)?.[1]])
    .filter(([, name]) => name);

  // Report Criteria: generation time and currency only.
  let generated = null, currency = null;
  const criteria = await book.sheet('Report Criteria');
  if (criteria) {
    const head = criteria.findIndex(r => Object.values(r).some(v => norm(v) === 'generated on'));
    if (head >= 0) {
      const h = criteria[head], values = criteria[head + 1] || {};
      const at = Object.keys(h).find(k => norm(h[k]) === 'generated on'), cur = Object.keys(h).find(k => norm(h[k]) === 'currency');
      generated = at ? String(values[at] || '').trim() : null;
      currency = cur ? String(values[cur] || '').trim().slice(0, 8) || null : null;
    }
  }
  const rows = [];
  for (const r of data.slice(1)) {
    const raw = r[col[norm('Occupancy Date')]];
    if (raw === undefined || raw === '') continue;
    const row = { stay_date: ideasDate(raw) };
    for (const [key, name] of Object.entries(FIELDS)) row[key] = col[norm(name)] ? num(r[col[norm(name)]]) : null;
    const event = col[norm('Special Event This Year')] ? String(r[col[norm('Special Event This Year')]] || '').trim() : '';
    row.special_event = event ? event.slice(0, 120) : null;
    const rates = {};
    for (const [letter, name] of competitors) { const v = num(r[letter]); if (v !== null && v > 0) rates[name.slice(0, 80)] = v; }
    const own = Object.keys(rates).filter(n => norm(n) === norm(r[col[norm('Property Name')]] || ''));
    for (const n of own) delete rates[n];                   // the hotel's own column is not a competitor
    const values = Object.values(rates).sort((a, b) => a - b);
    row.competitor_median = values.length ? (values.length % 2 ? values[(values.length - 1) / 2] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2) : null;
    row.competitors = values.length ? rates : null;
    rows.push(row);
  }
  if (!rows.length) throw new Error('unsupported_ideas_layout');
  rows.sort((a, b) => a.stay_date.localeCompare(b.stay_date));
  // The snapshot day is when IDeaS generated it (ICT), else the first stay date (the report starts "today").
  let snapshot_date = rows[0].stay_date;
  if (generated) { try { snapshot_date = ideasDate(generated); } catch { /* keep the first stay date */ } }
  return { snapshot: { snapshot_date, generated_at: generated, currency, source_sha256: checksum, rows: rows.length }, rows };
}

/** Store a parsed export; a later export for the same day replaces that day's rows, earlier days stay as history. */
export async function storeIdeas(db, parsed, receivedAt, origin) {
  const { snapshot, rows } = parsed, at = new Date().toISOString();
  const existing = await db.prepare('select source_sha256 from ideas_snapshots where snapshot_date = ?').bind(snapshot.snapshot_date).first();
  if (existing?.source_sha256 === snapshot.source_sha256) return { duplicate: true, snapshot_date: snapshot.snapshot_date, rows: 0 };
  const cols = ['snapshot_date', 'stay_date', ...IDEAS_FIELDS, 'special_event', 'competitor_median', 'competitors'];
  const stmts = [
    db.prepare('delete from ideas_daily where snapshot_date = ?').bind(snapshot.snapshot_date),
    db.prepare(`insert into ideas_snapshots (snapshot_date, generated_at, currency, source_sha256, received_at, imported_at, origin, rows)
      values (?, ?, ?, ?, ?, ?, ?, ?) on conflict(snapshot_date) do update set generated_at = excluded.generated_at,
      currency = excluded.currency, source_sha256 = excluded.source_sha256, received_at = excluded.received_at,
      imported_at = excluded.imported_at, origin = excluded.origin, rows = excluded.rows`)
      .bind(snapshot.snapshot_date, snapshot.generated_at, snapshot.currency, snapshot.source_sha256, receivedAt, at, origin, rows.length),
    ...rows.map(r => db.prepare(`insert into ideas_daily (${cols.join(', ')}) values (${cols.map(() => '?').join(', ')})`)
      .bind(snapshot.snapshot_date, r.stay_date, ...IDEAS_FIELDS.map(k => r[k]), r.special_event, r.competitor_median,
        r.competitors ? JSON.stringify(r.competitors) : null)),
  ];
  await db.batch(stmts);
  return { duplicate: false, snapshot_date: snapshot.snapshot_date, rows: rows.length };
}

/** POST /api/ingest/ideas: one export as the raw request body (manual import until scheduling is allowed). */
export async function ingestIdeas(request, env) {
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) return { error: 'body must be one Data Extraction .xlsx up to 3 MB', status: 400 };
  try {
    return { ok: true, ...(await storeIdeas(env.DB, await parseIdeas(bytes), new Date().toISOString(), 'manual')) };
  } catch (e) {
    return { error: String(e.message || 'invalid_ideas_file').slice(0, 80), status: 400 };
  }
}

const all = async stmt => (await stmt.all()).results || [];

/** Cron: import new IDeaS attachments from the read-only archive (same D1/R2 as OPERA, recipient ideas-reports@). */
export async function pollIdeasArchive(env, now = new Date()) {
  if (!env.PMS_ARCHIVE_DB || !env.PMS_REPORTS) return { status: 'not_configured', imported: 0 };
  const at = now.toISOString();
  let files;
  try {
    files = await all(env.PMS_ARCHIVE_DB.prepare(`select f.id, f.object_key, f.bytes, f.checksum_sha256, e.received_at
    from report_files f join report_emails e on f.email_id = e.id
    where e.recipient = ? and lower(f.filename) glob '*.xlsx' order by e.received_at desc, f.id desc limit 10`).bind(IDEAS_ADDRESS));
  } catch {
    return { status: 'archive_unreadable', imported: 0 };          // never let the IDeaS lane break the OPERA poll
  }
  let imported = 0, blocked = 0, processed = 0;
  for (const file of files) {
    const old = await env.DB.prepare('select status, attempts from ideas_bridge_receipts where file_id = ? and checksum = ? and bridge_version = ?')
      .bind(file.id, file.checksum_sha256, VERSION).first();
    if (old && ['imported', 'blocked'].includes(old.status)) { if (old.status === 'blocked') blocked++; continue; }
    if (processed >= 2) break;
    processed++;
    const attempts = (old?.attempts || 0) + 1;
    let status = 'retry', reason = '', day = null;
    try {
      if (!file.object_key.startsWith('reports/') || file.bytes > MAX_BYTES) throw new Error('unsupported_ideas_file');
      const object = await env.PMS_REPORTS.get(file.object_key);
      if (!object) throw new Error('archive_object_missing');
      const bytes = await object.arrayBuffer();
      if (await sha(bytes) !== file.checksum_sha256) throw new Error('archive_checksum_mismatch');
      const out = await storeIdeas(env.DB, await parseIdeas(bytes), file.received_at, 'email');
      day = out.snapshot_date;
      if (!out.duplicate) imported++;
      status = 'imported';
    } catch (error) {
      const known = ['unsupported_ideas_file', 'unsupported_ideas_layout', 'invalid_ideas_number', 'invalid_ideas_date', 'archive_checksum_mismatch'];
      reason = known.includes(error.message) ? error.message : 'archive_read_or_store_failed';
      if (known.includes(reason) || attempts >= 3) { status = 'blocked'; blocked++; }
    }
    await env.DB.prepare(`insert into ideas_bridge_receipts (file_id, checksum, bridge_version, processed_at, status, attempts, snapshot_date, reason)
      values (?, ?, ?, ?, ?, ?, ?, ?) on conflict(file_id, checksum, bridge_version) do update set processed_at = excluded.processed_at,
      status = excluded.status, attempts = excluded.attempts, snapshot_date = excluded.snapshot_date, reason = excluded.reason`)
      .bind(file.id, file.checksum_sha256, VERSION, at, status, attempts, day, reason).run();
  }
  const latest = await env.DB.prepare('select snapshot_date, origin from ideas_snapshots order by snapshot_date desc limit 1').first();
  const state = { bridge_version: VERSION, last_poll_at: at, last_archive_received_at: files[0]?.received_at || null,
    latest_snapshot: latest?.snapshot_date || null, latest_origin: latest?.origin || null, imported, blocked, checked: files.length, processed };
  await env.DB.prepare("insert into pms_feed_state (id, state) values ('ideas_archive', ?) on conflict(id) do update set state = excluded.state")
    .bind(JSON.stringify(state)).run();
  return state;
}

const round = (v, d = 1) => v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d;
const diff = (a, b) => a === null || a === undefined || b === null || b === undefined ? null : round(a - b, 2);

/** GET /api/agent/ideas?days=60&from=YYYY-MM-DD: the latest IDeaS view per stay date, its change since the previous
 *  snapshot, and our Booking pace for the same stay date / month where the collector has it. */
export async function agentIdeas(db, q) {
  const snaps = await all(db.prepare('select snapshot_date, generated_at, currency, origin, rows from ideas_snapshots order by snapshot_date desc limit 2'));
  if (!snaps.length) return { snapshot: null, previous: null, days: [], months: [], note: 'no IDeaS export imported yet' };
  const [latest, prev] = snaps, days = Math.max(1, Math.min(365, Number(q.get('days')) || 60));
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.get('from') || '') ? q.get('from') : latest.snapshot_date;
  const rows = await all(db.prepare('select * from ideas_daily where snapshot_date = ? and stay_date >= ? order by stay_date limit ?')
    .bind(latest.snapshot_date, from, days));
  const before = prev ? Object.fromEntries((await all(db.prepare('select stay_date, otb, occ_forecast, bar, lrv, competitor_median from ideas_daily where snapshot_date = ?')
    .bind(prev.snapshot_date))).map(r => [r.stay_date, r])) : {};
  // Booking pace from the collector: latest reading per stay period (daily for the next 7 days, monthly beyond).
  const pace = Object.fromEntries((await all(db.prepare(`select period, value, benchmark, day from metrics where platform = 'booking'
    and metric = 'pace_room_nights' and period like 'stay_%' and day = (select max(day) from metrics where platform = 'booking' and metric = 'pace_room_nights')`)))
    .map(r => [r.period.slice(5), r]));
  const out = rows.map(r => {
    const p = before[r.stay_date], b = pace[r.stay_date];
    return {
      stay_date: r.stay_date, otb: r.otb, otb_stly: r.otb_stly, capacity: r.capacity, remaining: r.remaining,
      occ_forecast: round(r.occ_forecast), unconstrained_demand: round(r.unconstrained_demand), budget_rooms: r.budget_rooms,
      bar: r.bar, floor: r.floor, ceiling: r.ceiling, lrv: round(r.lrv, 0), competitor_median: r.competitor_median,
      competitors: r.competitors ? JSON.parse(r.competitors) : null, adr_otb: round(r.adr, 0), adr_forecast: round(r.adr_forecast, 0),
      revenue_otb: round(r.revenue_otb, 0), revenue_forecast: round(r.revenue_forecast, 0), cancelled: r.cancelled,
      wash_pct: r.wash_pct, special_event: r.special_event,
      change: p ? { otb: diff(r.otb, p.otb), occ_forecast: diff(r.occ_forecast, p.occ_forecast), bar: diff(r.bar, p.bar), lrv: diff(r.lrv, p.lrv),
        competitor_median: diff(r.competitor_median, p.competitor_median) } : null,
      booking: b ? { room_nights: b.value, room_nights_ly: b.benchmark, read_on: b.day } : null,
    };
  });
  const byMonth = {};
  for (const r of await all(db.prepare(`select substr(stay_date, 1, 7) m, sum(otb) otb, sum(otb_stly) otb_stly, sum(occ_forecast) occ_forecast,
    sum(budget_rooms) budget_rooms, avg(bar) bar, sum(capacity) capacity from ideas_daily where snapshot_date = ? group by m order by m`).bind(latest.snapshot_date))) {
    const b = pace[r.m];
    byMonth[r.m] = { month: r.m, otb: r.otb, otb_stly: r.otb_stly, occ_forecast: round(r.occ_forecast), budget_rooms: r.budget_rooms,
      avg_bar: round(r.bar, 0), forecast_occupancy_pct: r.capacity ? round(100 * r.occ_forecast / r.capacity) : null,
      booking: b ? { room_nights: b.value, room_nights_ly: b.benchmark, share_of_otb_pct: r.otb ? round(100 * b.value / r.otb) : null } : null };
  }
  return { snapshot: latest, previous: prev || null, days: out, months: Object.values(byMonth),
    note: 'IDeaS is a teacher, not ground truth: compare your own call first, then score both against actual pickup.' };
}

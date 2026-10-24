import { occupancyBand, stayContext } from "./contracts.js";
import { detailErrors, operatingDetails } from './pms-details.js';
// Property aggregates only. Source time is deliberately independent of upload time.
export const bkkDay = (now = new Date()) => new Date(now.getTime() + 7 * 3600e3).toISOString().slice(0, 10);
const day = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const finite = (v) => v === null || (typeof v === "number" && Number.isFinite(v));
const keysOnly = (o, keys) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).every(k => keys.includes(k));
const ROW_KEYS = ["stay_date", "kind", "inventory", "rooms_sold", "room_revenue", "reported_adr", "reported_occupancy"];
const META_KEYS = ["id", "source", "source_sha256", "as_of", "currency", "scope", "precision", "projection_semantics"];
export function validatePms(body, today = bkkDay()) {
  const errors = [], s = body?.snapshot, rows = body?.rows;
  if (!keysOnly(body, ["schema_version", "snapshot", "rows"]) || body?.schema_version !== 1) errors.push("aggregate schema v1 required");
  if (!keysOnly(s, META_KEYS)) errors.push("unknown snapshot fields");
  if (!s || !/^[a-f0-9]{64}$/.test(s.id || "") || !/^[a-f0-9]{64}$/.test(s.source_sha256 || "")) errors.push("SHA256 identity required");
  if (!s || !day(s.as_of) || s.as_of > today) errors.push("invalid source as_of date");
  if (s?.source !== "opera_history_forecast" || s?.scope !== "property") errors.push("property OPERA daily aggregates only");
  if (s?.projection_semantics !== "pms_report_projection_not_rms_demand_forecast") errors.push("projection semantics required");
  if (!["legacy_rounded", "source_report"].includes(s?.precision)) errors.push("unknown precision");
  if (s?.currency !== null && !/^[A-Z]{3}$/.test(s?.currency || "")) errors.push("currency must be verified code or null");
  if (!Array.isArray(rows) || !rows.length || rows.length > 1500) errors.push("1–1500 daily aggregate rows required");
  const seen = new Set();
  for (const [i, r] of (Array.isArray(rows) ? rows.slice(0, 1501) : []).entries()) {
    if (!keysOnly(r, [...ROW_KEYS, 'details']) || ROW_KEYS.some(k => !(k in r))) { errors.push(`row ${i}: only daily numeric aggregate fields allowed`); continue; }
    if ('details' in r) errors.push(...detailErrors(r.details).map(e=>`row ${i}: ${e}`));
    if (!day(r.stay_date) || !["actual", "pms_projection"].includes(r.kind)) errors.push(`row ${i}: invalid date/kind`);
    if (r.kind === "actual" && r.stay_date > s?.as_of) errors.push(`row ${i}: future actuals`);
    if (!ROW_KEYS.slice(2).every(k => finite(r[k]))) errors.push(`row ${i}: invalid numeric value`);
    if ((r.inventory !== null && r.inventory <= 0) || (r.rooms_sold !== null && r.rooms_sold < 0)) errors.push(`row ${i}: invalid inventory/rooms`);
    const key = `${r.stay_date}|${r.kind}`;
    if (seen.has(key)) errors.push(`row ${i}: duplicate date/kind; check scope`);
    seen.add(key);
  }
  return errors;
}

export async function ingestPms(db, body, now = new Date()) {
  const s = body.snapshot;
  // A snapshot is immutable. Re-upload is idempotent, never a new vintage.
  const old = await db.prepare("select id from pms_snapshots where id = ?").bind(s.id).first();
  const stmts = old ? [] : [db.prepare(`insert into pms_snapshots
    (id, source_sha256, as_of, received_at, currency, precision, scope, source)
    values (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(s.id, s.source_sha256, s.as_of, now.toISOString(), s.currency, s.precision, s.scope, s.source)];
  for (const r of body.rows) {
    if (!old) stmts.push(db.prepare(`insert into pms_daily
    (snapshot_id, stay_date, kind, inventory, rooms_sold, room_revenue, reported_adr, reported_occupancy)
    values (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(s.id, ...ROW_KEYS.map(k => r[k])));
    if (r.details) stmts.push(db.prepare(`insert or ignore into pms_daily_details
      (snapshot_id,stay_date,kind,details) select ?,?,?,? where exists
      (select 1 from pms_daily where snapshot_id=? and stay_date=? and kind=?)`)
      .bind(s.id,r.stay_date,r.kind,JSON.stringify(r.details),s.id,r.stay_date,r.kind));
  }
  if (stmts.length) await db.batch(stmts);
  return { ok: true, duplicate: !!old, snapshot: s.id, rows: body.rows.length };
}

const ratio = (a, b, scale = 1) => a !== null && b !== null && b > 0 ? a / b * scale : null;
const sum = (rows, k) => rows.length && rows.every(r => Number.isFinite(r[k])) ? rows.reduce((n, r) => n + r[k], 0) : null;
export function totals(rows) {
  const revenue = sum(rows, "room_revenue"), rooms = sum(rows, "rooms_sold"), inventory = sum(rows, "inventory");
  return { days: rows.length, room_revenue: revenue, rooms_sold: rooms, inventory,
    occupancy: ratio(rooms, inventory, 100), adr: ratio(revenue, rooms), revpar: ratio(revenue, inventory) };
}

export function revenueView(snapshots = [], rows = [], today = bkkDay()) {
  const sorted = [...snapshots].sort((a, b) => b.as_of.localeCompare(a.as_of) || b.received_at.localeCompare(a.received_at) || b.id.localeCompare(a.id));
  const source = sorted[0];
  if (!source) return { status: "missing", source: null, days: [], months: [], gaps: ["尚未导入 OPERA 经营日报；入住/退房同步不等于收益数据接入"] };
  const age = Math.max(0, Math.floor((Date.parse(today) - Date.parse(source.as_of)) / 864e5));
  const current = rows.filter(r => r.snapshot_id === source.id);
  const prior = sorted.find(s => s.as_of < source.as_of && s.currency === source.currency && s.scope === source.scope && s.source === source.source && s.precision === source.precision);
  const previous = new Map(rows.filter(r => r.snapshot_id === prior?.id).map(r => [`${r.stay_date}|${r.kind}`, r]));
  const days = current.map(r => {
    const p = previous.get(`${r.stay_date}|${r.kind}`);
    // Future-to-future only. Historic corrections are not booking pickup, nor are PMS projections true OTB.
    const comparable = r.kind === "pms_projection" && r.stay_date > source.as_of && r.stay_date > prior?.as_of;
    return { ...r, ...totals([r]), operations: operatingDetails(r), room_revenue: r.room_revenue, rooms_sold: r.rooms_sold, inventory: r.inventory,
      occupancy_band: occupancyBand(totals([r]).occupancy),
      evidence_id: `pms:${source.id}:${r.stay_date}:${r.kind}`,
      projection_change: comparable && Number.isFinite(p?.rooms_sold) && Number.isFinite(r.rooms_sold) ? r.rooms_sold - p.rooms_sold : null,
      change_from: comparable && p ? prior.as_of : null };
  }).sort((a, b) => a.stay_date.localeCompare(b.stay_date) || a.kind.localeCompare(b.kind));
  const groups = new Map();
  for (const r of days) { const k = `${r.stay_date.slice(0, 7)}|${r.kind}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  return { status: age > 1 ? "stale" : "current", source, age_days: age, days,
    months: [...groups].map(([k, rs]) => ({ month: k.split("|")[0], kind: rs[0].kind, ...totals(rs) })),
    snapshots: sorted.map(s => ({ id: s.id, as_of: s.as_of, received_at: s.received_at, precision: s.precision })),
    gaps: ["未接入逐入住日的 OTA 渠道拆分、净佣金收入与可比竞品挂牌价", "PMS 未来值 ≠ 无约束需求预测；变化值 ≠ 已确认 pickup", "BAR、LRV、超售控制未接入，不从 ADR 或入住率推算"],
    data_context: stayContext({source, status: age > 1 ? "stale" : "current"}),
    formulas: { occupancy: "Σ已售间夜 ÷ Σ可售间夜", adr: "Σ客房收入 ÷ Σ已售间夜", revpar: "Σ客房收入 ÷ Σ可售间夜" } };
}

// Arithmetic sensitivity only: no elasticity model, no demand prediction, no executable pricing instruction.
export function scenario({ inventory, rooms, adr, rate_change = 0, room_change = 0, commission = 0 }) {
  if (![inventory, rooms, adr, rate_change, room_change, commission].every(Number.isFinite)
      || inventory <= 0 || rooms < 0 || rooms > inventory || adr < 0 || rate_change < -100 || rate_change > 100
      || commission < 0 || commission > 100 || rooms + room_change < 0 || rooms + room_change > inventory) throw new Error("invalid scenario inputs");
  const afterRooms = rooms + room_change, afterAdr = adr * (1 + rate_change / 100);
  const before = rooms * adr, after = afterRooms * afterAdr;
  return { before_revenue: before, after_revenue: after, delta: after - before,
    net_after: after * (1 - commission / 100), break_even_rooms: afterAdr > 0 ? before / afterAdr : null,
    occupancy: afterRooms / inventory * 100, disclaimer: "算术情景，不是需求预测或调价建议；佣金由用户假设，不含其他成本" };
}

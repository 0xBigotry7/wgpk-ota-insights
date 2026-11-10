import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { loadOperaFeeds, operaAlerts, operaSummary, OPERA_LIMITS } from '../src/opera-feeds.js';
import { db } from './helpers/sqlite.js';

// Synthetic summaries in the archive Worker's schemaVersion-2 shape (wgpk-concierge report-metrics.ts).
const BD = '2026-11-11';
const day = (i) => new Date(Date.parse(`${BD}T00:00:00Z`) + i * 864e5).toISOString().slice(0, 10);
const pace = (pickup) => ({ kind: 'pace', businessDate: BD, compareWindow: 'x',
  days: Array.from({ length: 40 }, (_, i) => ({ d: day(i), otbFrom: 100, otb: 100 + pickup(i), pickup: pickup(i),
    pickupInd: pickup(i) + 1, pickupBlk: -1, revFrom: 100000, rev: 100000 + pickup(i) * 1000, revPickup: pickup(i) * 1000, availFrom: 300, avail: 300 })) });
const market = { kind: 'otb_by_market', rows: [[day(0), 'P', 30, 90000, 3.5], [day(1), 'X', 50, 75000, 2], [day(40), 'P', 9, 9, 1]],
  totals: [[day(0), 30, 90000], [day(1), 50, 75000]] };
const p = (rooms, revenue) => ({ rooms, revenue, adr: rooms ? revenue / rooms : 0 });
const source = (bkgMtdAdr) => ({ kind: 'actuals_by_source',
  hotel: { day: { ...p(300, 600000), occ: 70 }, mtd: { ...p(3000, 6000000), occ: 60 }, ytd: { ...p(50000, 100000000), occ: 40 } },
  codes: [
    { group: 'ALL', code: 'BKGDC', name: 'Booking.com', day: p(20, 60000), mtd: p(100, 100 * bkgMtdAdr), ytd: p(3000, 9000000), guest_name: 'never export this' },
    { group: 'ALL', code: 'AGODA', name: 'Agoda.com', day: p(10, 20000), mtd: p(80, 160000), ytd: p(1700, 3400000) },
    { group: 'ALL', code: 'HSE', name: 'House Use Only', day: p(3, 0), mtd: p(30, 0), ytd: p(1800, 0) }] });
const country = { kind: 'actuals_by_country', countries: [
  { country: 'RU', name: 'Russian Federation', day: p(200, 300000), mtd: p(1400, 2100000), ytd: p(15000, 25000000) },
  { country: 'TH', name: 'Thailand', day: p(10, 20000), mtd: p(80, 120000), ytd: p(9000, 28000000) }] };

async function archive(rows) {
  const A = db();
  await A.prepare('create table report_emails(id text, received_at text)').run();
  await A.prepare('create table report_files(id text, email_id text, filename text, object_key text)').run();
  await A.prepare('create table report_analyses(file_id text, report_type text, summary_json text)').run();
  let i = 0;
  for (const [type, received, metrics] of rows) {
    i += 1;
    await A.prepare('insert into report_emails values (?, ?)').bind(`e${i}`, received).run();
    await A.prepare('insert into report_files values (?, ?, ?, ?)').bind(`f${i}`, `e${i}`, `${type}7228${i}.txt`, `reports/secret-key-${i}`).run();
    await A.prepare('insert into report_analyses values (?, ?, ?)')
      .bind(`f${i}`, type, JSON.stringify({ schemaVersion: metrics ? 2 : 1, piiStored: false, ...(metrics ? { metrics } : {}) })).run();
  }
  const statements = [];
  return { A, statements, ro: { prepare(sql) { statements.push(sql); assert.match(sql.trim(), /^select /i); return A.prepare(sql); } } };
}

const morning = '2026-11-10T23:45:00.000Z';                       // 06:45 Bangkok, 11/11
const fresh = Date.parse('2026-11-11T03:00:00.000Z');

test('opera views: agent token, aggregates only, newest delivery, read-only archive', async () => {
  const { A, ro, statements } = await archive([
    ['reservation_pace', '2026-11-09T23:35:00.000Z', pace(() => 99)],               // older delivery: must lose
    ['reservation_pace', morning, pace((i) => (i === 2 ? -12 : 2))],
    ['los_market_forecast', morning, market],
    ['stat_dmy_source', morning, source(3000)],
    ['stat_dmy_seg', morning, null],                                                  // v1 summary: ignored
    ['stat_country_revenue', morning, country]]);
  const DB = db(), env = { DB, PMS_ARCHIVE_DB: ro, AGENT_TOKEN: 'agent' };
  const get = (q, auth = 'agent') => worker.fetch(new Request(`https://x/api/agent/opera${q}`, { headers: { Authorization: `Bearer ${auth}` } }), env);
  try {
    assert.equal((await get('?view=pace', 'nope')).status, 401);
    assert.equal((await get('?view=rooms')).status, 400);
    let r = (await (await get('?view=pace')).json()).opera;
    assert.equal(r.available, true);
    assert.equal(r.business_date, BD);
    assert.equal(r.report_date, '2026-11-10');
    assert.equal(r.days[2].pickup_7d, -12);
    assert.equal(r.days[0].pickup_7d, 2);
    r = (await (await get('?view=market')).json()).opera;
    assert.deepEqual(r.rows[0], { stay_date: day(0), market: 'P', rooms: 30, room_revenue: 90000, adr: 3000, avg_los: 3.5 });
    r = (await (await get('?view=source')).json()).opera;
    assert.equal(r.hotel.mtd.adr, 2000);
    assert.equal(r.codes[0].code, 'BKGDC');
    assert.equal(r.by_market, null);
    const bkg = r.channel_adr.find((c) => c.code === 'BKGDC');
    assert.equal(bkg.adr_vs_hotel_mtd, 1.5);
    assert.equal(bkg.relative_change, 1);
    r = (await (await get('?view=country')).json()).opera;
    assert.deepEqual(r.countries.map((c) => c.country), ['RU', 'TH']);
    for (const q of ['', '?view=pace', '?view=market', '?view=source', '?view=country']) {
      const text = await (await get(q)).text();
      assert.ok(!text.includes('never export'), `guest field leaked in ${q}`);
      assert.ok(!text.includes('secret-key'), `object key leaked in ${q}`);
    }
    assert.ok(statements.length > 0);
  } finally { DB.close(); A.close(); }
});

test('opera summary and the daily block', async () => {
  const { A, ro } = await archive([['reservation_pace', morning, pace((i) => (i < 14 ? -1 : 3))],
    ['los_market_forecast', morning, market], ['stat_dmy_source', morning, source(3000)], ['stat_country_revenue', morning, country]]);
  try {
    const s = operaSummary(await loadOperaFeeds(ro), fresh);
    assert.equal(s.available, true);
    assert.equal(s.age_hours, 3);
    assert.deepEqual(s.pickup_7d.next_14_days, { stay_dates: 14, pickup_7d: -14, transient: 0, group: -14, revenue_pickup_7d: -14000 });
    assert.equal(s.pickup_7d.next_30_days.pickup_7d, -14 + 16 * 3);
    assert.equal(s.pickup_7d.biggest_losses.length, 3);
    assert.deepEqual(s.otb_by_market_next_30_days.map((m) => [m.market, m.rooms, m.share_pct]), [['X', 50, 62.5], ['P', 30, 37.5]]);
    assert.deepEqual(s.top_countries_mtd.map((c) => c.country), ['RU', 'TH']);
    assert.ok(s.channels.some((c) => c.code === 'BKGDC'));
    assert.ok(!JSON.stringify(s).includes('never export'));
    assert.deepEqual(operaSummary(null), { available: false, note: operaSummary(null).note });
  } finally { A.close(); }
});

test('opera alerts: stale feed, negative pickup, single-date cancellations, channel ADR drop', async () => {
  const { A, ro } = await archive([['reservation_pace', morning, pace((i) => (i === 3 ? -15 : -1))],
    ['stat_dmy_source', morning, source(2000)]]);                  // Booking 1.0× hotel this month vs 1.5× this year
  try {
    const feeds = await loadOperaFeeds(ro);
    const ids = (list) => Object.fromEntries(list.map((a) => [a.id, a.level]));
    let a = ids(operaAlerts(feeds, fresh));
    assert.equal(a['opera:pickup-negative'], 'serious');          // 29 × −1 − 15 = −44 ≤ −30
    assert.equal(a['opera:date-cancellations'], 'warning');
    assert.equal(a['opera:adr-drop:BKGDC'], 'serious');           // 1.0 / 1.5 = 0.67 < 0.75
    assert.equal(a['opera:adr-drop:AGODA'], undefined);
    assert.equal(a['opera:adr-drop:HSE'], undefined);             // no revenue: never judged
    a = ids(operaAlerts(feeds, fresh + (OPERA_LIMITS.stale_hours + 2) * 3600e3));
    assert.deepEqual(a, { 'opera:stale': 'serious' });
    assert.deepEqual(operaAlerts(null, fresh), []);
  } finally { A.close(); }
});

test('cockpit without the archive binding still serves daily and says opera is unavailable', async () => {
  const DB = db(), env = { DB, AGENT_TOKEN: 'agent' };
  try {
    const r = await (await worker.fetch(new Request('https://x/api/agent/opera', { headers: { Authorization: 'Bearer agent' } }), env)).json();
    assert.equal(r.opera.available, false);
    const d = await (await worker.fetch(new Request('https://x/api/agent/daily', { headers: { Authorization: 'Bearer agent' } }), env)).json();
    assert.equal(d.daily.opera.available, false);
  } finally { DB.close(); }
});

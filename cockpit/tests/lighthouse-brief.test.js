import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { buildBrief, ranges } from '../src/lighthouse-brief.js';
import { db } from './helpers/sqlite.js';

const day = (Date, o = {}) => ({ Date, Day: 'Mon', 'Demand level': 'High', 'My price': 5000, 'My price level': 'High',
  'Smart Compset price level': 'High', 'My OTB': 0.7, 'Market OTB': 0.6, 'Unavailable hotels': 0.05, 'Nr. of events and holidays': 0,
  'Origin hotels 1': 'IN', ...o });
const market = { property: 'WGPK', currency: 'THB', geo: [
  { 'Top 10 countries searching for hotels': 'IN', 'Top 10 countries searching for hotels % mix': 0.12, 'Top 10 countries searching for hotels avg. LOS': 2.8 },
  { 'Top 10 countries searching for hotels': 'RU', 'Top 10 countries searching for hotels % mix': 0.06, 'Top 10 countries searching for hotels avg. LOS': 7.8 }],
  stay_patterns: [], daily: [
    day('2026-12-24', { 'My price': 'Sold out', 'My price level': 'Sold out', 'Demand level': 'Very high', 'Smart Compset price level': 'Very high', 'My OTB': 0.65 }),
    day('2026-12-25', { 'My price': 'Sold out', 'My price level': 'Sold out', 'Demand level': 'Very high', 'Smart Compset price level': 'Very high', 'My OTB': 0.67 }),
    day('2026-12-12', { 'My price': 3790, 'My price level': 'Low' }),
    day('2026-12-13', { 'My price': 3790, 'My price level': 'Low' }),
    day('2026-11-20', { 'My price': 'Sold out', 'My price level': 'Sold out', 'My OTB': 0.98 }),
  ] };
const opera = { received_at: '2026-11-12T00:00:00Z', business_date: '2026-11-12', days: [
  { stay_date: '2026-12-24', otb: 274, pickup_7d: 1 }, { stay_date: '2026-12-25', otb: 283, pickup_7d: 0 },
  { stay_date: '2026-12-12', otb: 290, pickup_7d: 5 }, { stay_date: '2026-11-20', otb: 414, pickup_7d: 0 }] };

test('ranges groups consecutive dates', () => {
  assert.deepEqual(ranges(['2026-12-25', '2026-12-24', '2026-12-27']), [{ from: '2026-12-24', to: '2026-12-25' }, { from: '2026-12-27', to: '2026-12-27' }]);
});

test('brief: sold out with rooms left, underpriced vs compset, searched-not-staying market — with OTA evidence', () => {
  const b = buildBrief({ market, opera, countries: [{ country: 'RU', share_pct: 63 }, { country: 'IN', share_pct: 1 }],
    ideas: { snapshot_date: '2026-11-01', days: [{ stay_date: '2026-12-12', bar: 6380, remaining: 130 }, { stay_date: '2026-12-24', bar: 13335, remaining: 150 }] },
    metrics: [{ day: '2026-11-11', platform: 'agoda', metric: 'bookings_lost_30d', period: 'next_30_days', value: 57 }],
    received_at: '2026-11-12T02:32:00Z', today: '2026-11-12' });
  assert.equal(b.available, true);
  const kinds = b.actions.map((a) => a.kind);
  assert.equal(kinds[0], 'closed_out');                          // sold out on the shop, 148 + 139 rooms unsold
  const closed = b.actions[0];
  assert.deepEqual(closed.dates, ['2026-12-24', '2026-12-25']);  // 11/20 is genuinely full (414/422), not flagged
  assert.match(closed.title, /287 间夜/);
  assert.ok(closed.evidence.some((x) => /Agoda 未来30天流失 57 单/.test(x)));
  const under = b.actions.find((a) => a.kind === 'underpriced');
  assert.deepEqual(under.dates, ['2026-12-12', '2026-12-13']);
  assert.ok(under.evidence.some((x) => /BAR 6,380 低 2,590/.test(x)));
  const mkt = b.actions.find((a) => a.kind === 'source_market');
  assert.match(mkt.title, /印度/);
  assert.deepEqual(mkt.channels, ['Agoda', 'Booking']);
  assert.equal(b.strip.length, 5);
});

test('ingest keeps market history; agent view=brief computes and stores the day', async () => {
  const DB = db(), env = { DB, OTA_INGEST_TOKEN: 'tok', AGENT_TOKEN: 'agent' };
  const post = (body) => worker.fetch(new Request('https://x/api/ingest/lighthouse', {
    method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);
  const get = (q) => worker.fetch(new Request(`https://x/api/agent/lighthouse${q}`, { headers: { Authorization: 'Bearer agent' } }), env);
  try {
    const r = await (await post({ views: { market: { ...market, received_at: '2026-11-12T02:32:00Z' } } })).json();
    assert.deepEqual(r.stored, ['market']);
    assert.equal((await DB.prepare('select count(*) n from lighthouse_market_history').first()).n, 1);
    const b = (await (await get('?view=brief')).json()).lighthouse;
    assert.equal(b.view, 'brief');
    assert.equal(b.available, true);
    assert.ok(b.actions.length >= 1);
    const h = (await (await get('?view=briefs')).json()).lighthouse;
    assert.equal(h.briefs.length, 1);
    assert.equal(h.briefs[0].headline, b.headline);
  } finally { DB.close(); }
});

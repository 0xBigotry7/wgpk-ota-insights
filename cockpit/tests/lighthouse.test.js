import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { db } from './helpers/sqlite.js';

const market = { received_at: '2026-11-11T01:30:00+00:00', sha256: 'a', data_hash: 'b', property: 'Wyndham Garden Phuket Kamala',
  currency: 'THB', daily: [{ Date: '2026-11-20', 'Demand level': 'High', 'My price': 6380, 'My OTB': 0.71, 'Market OTB': 0.65 }],
  geo: [], stay_patterns: [] };

test('lighthouse views: ingest needs the ingest token, the agent reads the latest view', async () => {
  const DB = db(), env = { DB, OTA_INGEST_TOKEN: 'tok', AGENT_TOKEN: 'agent' };
  const post = (auth, body) => worker.fetch(new Request('https://x/api/ingest/lighthouse', {
    method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);
  const get = q => worker.fetch(new Request(`https://x/api/agent/lighthouse${q}`, { headers: { Authorization: 'Bearer agent' } }), env);
  try {
    assert.equal((await post('agent', { views: { market } })).status, 401);
    let r = await (await get('')).json();
    assert.equal(r.lighthouse.available, false);
    assert.equal((await post('tok', { views: { nope: {} } })).status, 400);
    r = await (await post('tok', { generated_at: '2026-11-11T01:31:00Z', views: { market, events: null, compare_market: null } })).json();
    assert.deepEqual(r.stored, ['market']);
    r = await (await get('?view=market')).json();
    assert.equal(r.lighthouse.available, true);
    assert.equal(r.lighthouse.received_at, market.received_at);
    assert.equal(r.lighthouse.data.daily[0]['My price'], 6380);
    assert.equal((await (await get('?view=events')).json()).lighthouse.available, false);
    assert.equal((await get('?view=prices')).status, 400);
    const status = { last_report_at: '2026-11-12T01:30:00Z', files: [{ filename: 'x.xlsx', status: 'parse_failed', kind: null, reason: 'workbook headers changed' }] };
    await post('tok', { views: { status } });
    r = await (await get('?view=market')).json();
    assert.equal(r.lighthouse.inbox_status.files[0].status, 'parse_failed');
    assert.equal(r.lighthouse.data.daily[0]['My price'], 6380);
  } finally { DB.close(); }
});

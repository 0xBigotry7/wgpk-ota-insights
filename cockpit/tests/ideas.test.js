import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { parseIdeas, storeIdeas, agentIdeas, pollIdeasArchive, ideasDate, IDEAS_ADDRESS } from '../src/ideas.js';
import worker from '../src/worker.js';
import { db } from './helpers/sqlite.js';

// A tiny synthetic Data Extraction export in the same layout as IDeaS G3's (made-up numbers): inline strings,
// Excel serial dates, a "Property" sheet and a "Report Criteria" sheet.
function zip(files) {
  const enc = new TextEncoder(), local = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name), data = deflateRawSync(Buffer.from(text));
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(data.length, 18); head.writeUInt32LE(text.length, 22); head.writeUInt16LE(nameBytes.length, 26);
    local.push(head, nameBytes, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10); c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(text.length, 24); c.writeUInt16LE(nameBytes.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  const b = Buffer.concat([...local, cd, end]);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
}
const cols = n => { let s = ''; for (n++; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
const cell = (r, i, v) => typeof v === 'number' ? `<c r="${cols(i)}${r}" t="n"><v>${v}</v></c>`
  : v === null ? `<c r="${cols(i)}${r}"/>` : `<c r="${cols(i)}${r}" t="inlineStr"><is><r><t xml:space="preserve">${v}</t></r></is></c>`;
const sheet = rows => `<worksheet><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => cell(i + 1, j, v)).join('')}</row>`).join('')}</sheetData></worksheet>`;
const HEAD = ['Property Name', 'Day of Week', 'Occupancy Date', 'Special Event This Year', 'Physical Capacity This Year',
  'Remaining Capacity This Year', 'Occupancy On Books This Year', 'Occupancy On Books STLY', 'Occupancy Forecast - Total This Year',
  'System Total Demand - Total This Year', 'Budget  Occupancy - Total This Year', 'ADR On Books This Year', 'Last Room Value This Year',
  'BAR', 'Floor', 'Ceiling', 'Competitor Rate ForTest Hotel This Year', 'Competitor Rate ForRival A This Year', 'Competitor Rate ForRival B This Year'];
function exportFile({ generated = '29-Oct-2026 15:52:36 ICT', otb = 100, bar = '2800.00' } = {}) {
  const rows = [HEAD,
    ['Test Hotel', 'Thursday', 46324, null, 100, 20, otb, 50, 90.5, 95.2, 80, 1200.5, 0, bar, 2500, 6500, null, 3000, 5000],
    ['Test Hotel', 'Friday', 46325, 'Loy Krathong', 100, 30, 70, 60, 75.25, 80, 82, 1300, 1500.4, '3100.00', 2500, 6500, 9999, 4000, null],
    ['Dummy for excel - new worksheet']];
  const criteria = [['Data Extraction Report'], ['Property Name', 'Start Date', 'End Date', 'Currency', 'Created By', 'Generated On', 'Account ID'],
    ['Test Hotel', 46324, 46325, 'THB', 'Some Person', generated, '0000-0000']];
  return zip({
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Property" sheetId="1" r:id="rId1"/><sheet name="Report Criteria" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet(rows),
    'xl/worksheets/sheet2.xml': sheet(criteria),
  });
}

test('Excel serial and dd-Mon-yyyy dates', () => {
  assert.equal(ideasDate('46324.0'), '2026-10-29');
  assert.equal(ideasDate('29-Oct-2026 15:52:36 ICT'), '2026-10-29');
  assert.throws(() => ideasDate('tomorrow'));
});

test('parser reads the Data Extraction layout and keeps only numbers and the event label', async () => {
  const { snapshot, rows } = await parseIdeas(exportFile());
  assert.equal(snapshot.snapshot_date, '2026-10-29');
  assert.equal(snapshot.currency, 'THB');
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].stay_date, rows[0].otb, rows[0].occ_forecast, rows[0].bar, rows[0].lrv], ['2026-10-29', 100, 90.5, 2800, 0]);
  assert.equal(rows[0].competitor_median, 4000);                   // the hotel's own column is not a competitor
  assert.equal(rows[1].competitor_median, 4000);                   // own column 9999 dropped, one rival left
  assert.equal(rows[1].special_event, 'Loy Krathong');
  assert.ok(!JSON.stringify({ snapshot, rows }).includes('Some Person') && !JSON.stringify({ snapshot, rows }).includes('0000-0000'));
});

test('unknown layouts and non-numbers fail closed', async () => {
  await assert.rejects(() => parseIdeas(new TextEncoder().encode('not a zip').buffer), /unsupported_ideas_file/);
  await assert.rejects(() => parseIdeas(exportFile({ bar: 'call us' })), /invalid_ideas_number/);
});

test('history per snapshot day, change since the previous snapshot, Booking pace alongside', async () => {
  const DB = db();
  await storeIdeas(DB, await parseIdeas(exportFile({ generated: '28-Oct-2026 07:00:00 ICT', otb: 90, bar: '2600.00' })), '2026-10-28T00:00:00Z', 'email');
  const today = await parseIdeas(exportFile());
  assert.equal((await storeIdeas(DB, today, '2026-10-29T00:00:00Z', 'manual')).rows, 2);
  assert.equal((await storeIdeas(DB, today, '2026-10-29T01:00:00Z', 'manual')).duplicate, true);
  await DB.prepare(`insert into metrics (day, platform, metric, period, label, value, unit, benchmark, run_id, page)
    values ('2026-10-29', 'booking', 'pace_room_nights', 'stay_2026-10-29', 'x', 21, '', 16, 'r', 'pace-7d')`).run();
  const out = await agentIdeas(DB, new URLSearchParams('days=5'));
  assert.equal(out.snapshot.snapshot_date, '2026-10-29');
  assert.equal(out.previous.snapshot_date, '2026-10-28');
  assert.deepEqual(out.days[0].change, { otb: 10, occ_forecast: 0, bar: 200, lrv: 0, competitor_median: 0 });
  assert.deepEqual(out.days[0].booking, { room_nights: 21, room_nights_ly: 16, read_on: '2026-10-29' });
  assert.equal(out.months[0].month, '2026-10');
  assert.equal((await DB.prepare('select count(*) n from ideas_daily').first()).n, 4);
  DB.close();
});

test('archive poll imports xlsx sent to the IDeaS address once, read-only on the archive', async () => {
  const DB = db(), ARCHIVE = db(), bytes = exportFile(), checksum = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
  await ARCHIVE.prepare('create table report_emails(id text, received_at text, recipient text)').run();
  await ARCHIVE.prepare('create table report_files(id text, email_id text, filename text, object_key text, bytes integer, checksum_sha256 text)').run();
  await ARCHIVE.prepare('insert into report_emails values (?, ?, ?)').bind('e1', '2026-10-29T00:05:00Z', IDEAS_ADDRESS).run();
  await ARCHIVE.prepare('insert into report_emails values (?, ?, ?)').bind('e2', '2026-10-29T00:06:00Z', 'opera-analytics@wyndhamgardenkamala.com').run();
  await ARCHIVE.prepare('insert into report_files values (?, ?, ?, ?, ?, ?)').bind('f1', 'e1', 'G3_DataExtraction.xlsx', 'reports/a/1.xlsx', bytes.byteLength, checksum).run();
  await ARCHIVE.prepare('insert into report_files values (?, ?, ?, ?, ?, ?)').bind('f2', 'e2', 'other.xlsx', 'reports/b/1.xlsx', 1, 'x').run();
  const env = { DB, PMS_ARCHIVE_DB: { prepare(sql) { assert.match(sql.trim(), /^select /i); return ARCHIVE.prepare(sql); } },
    PMS_REPORTS: { get: async key => { assert.equal(key, 'reports/a/1.xlsx'); return { arrayBuffer: async () => bytes }; } } };
  const first = await pollIdeasArchive(env);
  assert.deepEqual([first.imported, first.checked, first.latest_snapshot], [1, 1, '2026-10-29']);
  const second = await pollIdeasArchive(env);
  assert.deepEqual([second.imported, second.processed], [0, 0]);
  DB.close(); ARCHIVE.close();
});

test('manual import needs the ingest token; the agent reads it with its own token', async () => {
  const DB = db(), env = { DB, OTA_INGEST_TOKEN: 'tok', AGENT_TOKEN: 'agent' };
  const post = auth => worker.fetch(new Request('https://x/api/ingest/ideas', { method: 'POST', headers: { Authorization: `Bearer ${auth}` }, body: exportFile() }), env);
  assert.equal((await post('nope')).status, 401);
  const ok = await (await post('tok')).json();
  assert.deepEqual([ok.ok, ok.rows, ok.snapshot_date], [true, 2, '2026-10-29']);
  const r = await worker.fetch(new Request('https://x/api/agent/ideas?days=1', { headers: { Authorization: 'Bearer agent' } }), env);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ideas.days[0].bar, 2800);
  DB.close();
});

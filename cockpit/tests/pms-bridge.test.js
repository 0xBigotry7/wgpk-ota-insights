import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseReport,pollPmsArchive} from '../src/pms-bridge.js';
import worker from '../src/worker.js';
import {db} from './helpers/sqlite.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const report=(actual='27-JUL-26',future='28-JUL-26')=>new TextEncoder().encode(`REC_TYPE\tCONSIDERED_DATE\tCF_OCCUPANCY\tCF_AVERAGE_ROOM_RATE\tREVENUE\tNO_ROOMS\tINVENTORY_ROOMS\tGUEST_NAME\nA_STAT\t${actual}\t50\t1,000\t50,000\t50\t100\tnever export this\nB_FORE\t${future}\t60\t1000\t60000\t60\t100\tnever export this`);
const now=new Date('2026-10-24T04:00:00Z');
async function envFor(bytes=report()){
 const DB=db(),ARCHIVE=db(),checksum=hash(bytes),key='reports/test/history_forecast.txt';
 await ARCHIVE.prepare('create table report_emails(id text,received_at text)').run();
 await ARCHIVE.prepare('create table report_files(id text,email_id text,filename text,object_key text,bytes integer,checksum_sha256 text)').run();
 await ARCHIVE.prepare('insert into report_emails values (?,?)').bind('email','2026-10-24T03:00:00Z').run();
 await ARCHIVE.prepare('insert into report_files values (?,?,?,?,?,?)').bind('file','email','history_forecast_123.txt',key,bytes.length,checksum).run();
 const archiveStatements=[];
 const PMS_ARCHIVE_DB={prepare(sql){archiveStatements.push(sql);assert.match(sql.trim(),/^select /i);return ARCHIVE.prepare(sql);}};
 return {DB,ARCHIVE,PMS_ARCHIVE_DB,archiveStatements,OTA_INGEST_TOKEN:'tok',PMS_REPORTS:{get:async requested=>{assert.equal(requested,key);return {size:bytes.length,arrayBuffer:async()=>bytes.buffer};}},close(){DB.close();ARCHIVE.close();}};
}
test('raw report parser keeps full precision, only numeric allowlisted fields and source business cutoff',async()=>{
 const bytes=report(),body=await parseReport(bytes,hash(bytes),'2026-10-24');
 assert.equal(body.snapshot.as_of,'2026-07-28');assert.equal(body.snapshot.precision,'source_report');assert.equal(body.rows.length,2);assert.equal(body.rows[0].room_revenue,50000);assert.equal(body.snapshot.currency,null);assert.ok(!JSON.stringify(body).includes('never export'));
 assert.equal((await parseReport(bytes,hash(bytes),'2026-10-24')).snapshot.id,body.snapshot.id);
});
test('report receipt today cannot refresh an old source; mismatches and ambiguous boundaries fail closed',async()=>{
 const bytes=report();await assert.rejects(()=>parseReport(bytes,'bad','2026-10-24'),/checksum/);
 for(const b of [report('27-JUL-26','29-JUL-26'),report('30-FEB-26','01-MAR-26'),report('27-JUL-27','28-JUL-27')])await assert.rejects(()=>parseReport(b,hash(b),'2026-10-24'));
 const futureOnly=new TextEncoder().encode(new TextDecoder().decode(bytes).split('\n').filter(l=>!l.startsWith('A_STAT')).join('\n'));
 await assert.rejects(()=>parseReport(futureOnly,hash(futureOnly),'2026-10-24'),/cutoff/);
});
test('archive-to-D1 full SQL flow is automatic, idempotent, provenance-aware and source archive read-only',async()=>{
 const env=await envFor(),first=await pollPmsArchive(env,now);
 assert.equal(first.imported,1);assert.equal(first.source_as_of,'2026-07-28');assert.equal(first.status,'waiting_for_new_report');
 assert.equal((await env.DB.prepare('select count(*) n from pms_daily').first()).n,2);
 const provenance=await env.DB.prepare('select * from pms_snapshot_provenance').first();assert.equal(provenance.as_of_basis,'actual_projection_business_cutoff');
 const second=await pollPmsArchive(env,now);assert.equal(second.imported,0);assert.equal(second.processed,0);
 assert.equal((await env.DB.prepare('select attempts from pms_bridge_receipts').first()).attempts,1);
 assert.equal((await env.DB.prepare('select count(*) n from pms_bridge_lease').first()).n,0);
 assert.equal((await env.ARCHIVE.prepare('select count(*) n from report_files').first()).n,1);env.close();
});
test('bad reports are quarantined without partial aggregates or endless retry',async()=>{
 const env=await envFor(report('27-JUL-26','29-JUL-26'));
 const first=await pollPmsArchive(env,now);assert.equal(first.blocked,1);assert.equal(first.status,'needs_review');
 assert.equal((await env.DB.prepare('select count(*) n from pms_snapshots').first()).n,0);
 assert.equal((await pollPmsArchive(env,now)).processed,0);env.close();
});
test('transient archive failures retry at most 3 times then require review',async()=>{
 const env=await envFor();env.PMS_REPORTS.get=async()=>{throw new Error('network failure with secret detail');};
 for(let i=0;i<4;i++)await pollPmsArchive(env,new Date(now.getTime()+i*1800000));
 const receipt=await env.DB.prepare('select * from pms_bridge_receipts').first();assert.equal(receipt.attempts,3);assert.equal(receipt.status,'blocked');assert.equal(receipt.reason,'archive_read_or_store_failed');env.close();
});
test('manual poll requires ingest token; new cron does not send daily notifications or create to-dos',async()=>{
 const env=await envFor();
 assert.equal((await worker.fetch(new Request('https://x/api/pms/poll',{method:'POST'}),env)).status,401);
 const r=await worker.fetch(new Request('https://x/api/pms/poll',{method:'POST',headers:{Authorization:'Bearer tok'}}),env);assert.equal(r.status,200);
 const jobs=[];await worker.scheduled({cron:'7,37 * * * *'},env,{waitUntil:p=>jobs.push(p)});await Promise.all(jobs);
 assert.equal((await env.DB.prepare('select count(*) n from todos').first()).n,0);
 const state=await(await worker.fetch(new Request('https://x/api/state',{headers:{Authorization:'Bearer tok'}}),env)).json();
 assert.equal(state.revenue.source.as_of_basis,'actual_projection_business_cutoff');assert.equal(state.revenue.feed.source_as_of,'2026-07-28');env.close();
});
test('concurrent polling lease prevents duplicate work and expiry permits recovery',async()=>{
 const env=await envFor();await env.DB.prepare("insert into pms_bridge_lease values ('archive','other',?)").bind(now.getTime()+30000).run();
 assert.equal((await pollPmsArchive(env,now)).status,'already_running');
 assert.equal((await pollPmsArchive(env,new Date(now.getTime()+60000))).imported,1);env.close();
});

test('a genuinely newer source report advances the cockpit; same archive re-poll never duplicates it',async t=>{
 // /api/state reads the clock; pin it just after the import so the test does not expire.
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-24T04:06:00Z')});
 const env=await envFor();await pollPmsArchive(env,now);
 const bytes=report('23-OCT-26','24-OCT-26'),key='reports/test/newhistory.txt';
 await env.ARCHIVE.prepare('insert into report_emails values (?,?)').bind('new-email','2026-10-24T04:01:00Z').run();
 await env.ARCHIVE.prepare('insert into report_files values (?,?,?,?,?,?)').bind('new-file','new-email','history_forecast_456.txt',key,bytes.length,hash(bytes)).run();
 const oldGet=env.PMS_REPORTS.get;env.PMS_REPORTS.get=async requested=>requested===key?{size:bytes.length,arrayBuffer:async()=>bytes.buffer}:oldGet(requested);
 const imported=await pollPmsArchive(env,new Date('2026-10-24T04:05:00Z'));
 assert.equal(imported.imported,1);assert.equal(imported.status,'current');assert.equal(imported.source_as_of,'2026-10-24');
 const state=await(await worker.fetch(new Request('https://x/api/state',{headers:{Authorization:'Bearer tok'}}),env)).json();
 assert.equal(state.revenue.source.as_of,'2026-10-24');assert.equal(state.revenue.status,'current');assert.equal(state.revenue.days.length,2);
 assert.equal((await pollPmsArchive(env,new Date('2026-10-24T04:10:00Z'))).imported,0);
 assert.equal((await env.DB.prepare('select count(*) n from pms_snapshots').first()).n,2);env.close();
});

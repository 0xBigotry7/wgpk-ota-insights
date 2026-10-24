// Independent of the live guest sync. Only SELECTs the analytics archive and exports numeric aggregates.
import { bkkDay, validatePms, ingestPms } from './revenue.js';
const VERSION = 'archive-bridge-v1';
const REQUIRED = ['REC_TYPE','CONSIDERED_DATE','CF_OCCUPANCY','CF_AVERAGE_ROOM_RATE','REVENUE','NO_ROOMS','INVENTORY_ROOMS'];
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const sha = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
const encoder = new TextEncoder();
function reportDate(value) {
  const s=String(value||'').trim().toUpperCase();
  let date=s;
  const m=s.match(/^(\d{2})-([A-Z]{3})-(\d{2})$/);
  if(m)date=`20${m[3]}-${String(MONTHS.indexOf(m[2])+1).padStart(2,'0')}-${m[1]}`;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw new Error('invalid_report_date');
  return date;
}
function numeric(value) {
  const s=String(value??'').trim().replaceAll(',','');if(!s)return null;
  if(!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s))throw new Error('invalid_report_number');
  const n=Number(s);if(!Number.isFinite(n))throw new Error('invalid_report_number');return n;
}
export async function parseReport(bytes, expectedChecksum, today=bkkDay(), currency=null) {
  const checksum=await sha(bytes);
  if(checksum!==expectedChecksum)throw new Error('archive_checksum_mismatch');
  const lines=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'').split(/\r?\n/);
  const headers=lines.shift().split('\t');
  if(!REQUIRED.every(k=>headers.filter(h=>h===k).length===1))throw new Error('unsupported_history_forecast_schema');
  const rows=[];
  for(const line of lines){
    if(!line.trim())continue;
    const values=line.split('\t'),get=k=>values[headers.indexOf(k)]??'';
    const type=get('REC_TYPE').trim();if(!['A_STAT','B_FORE'].includes(type))continue;
    rows.push({stay_date:reportDate(get('CONSIDERED_DATE')),kind:type==='A_STAT'?'actual':'pms_projection',
      inventory:numeric(get('INVENTORY_ROOMS')),rooms_sold:numeric(get('NO_ROOMS')),room_revenue:numeric(get('REVENUE')),
      reported_adr:numeric(get('CF_AVERAGE_ROOM_RATE')),reported_occupancy:numeric(get('CF_OCCUPANCY'))});
  }
  const actual=rows.filter(r=>r.kind==='actual').map(r=>r.stay_date).sort(),future=rows.filter(r=>r.kind==='pms_projection').map(r=>r.stay_date).sort();
  // This is a source business cutoff, NOT a guessed export/receipt date. Preserve the distinction in provenance/UI.
  if(!actual.length||!future.length||new Date(Date.parse(actual.at(-1))+864e5).toISOString().slice(0,10)!==future[0])throw new Error('ambiguous_source_business_cutoff');
  const as_of=future[0];
  const id=await sha(encoder.encode(`${checksum}|${as_of}|${currency||''}`));
  const body={schema_version:1,snapshot:{id,source:'opera_history_forecast',source_sha256:checksum,as_of,currency,scope:'property',precision:'source_report',projection_semantics:'pms_report_projection_not_rms_demand_forecast'},rows:rows.sort((a,b)=>a.stay_date.localeCompare(b.stay_date))};
  if(validatePms(body,today).length)throw new Error('invalid_property_day_aggregates');
  return body;
}
const all=async stmt=>(await stmt.all()).results||[];
export async function pollPmsArchive(env, now=new Date()) {
  if(!env.PMS_ARCHIVE_DB||!env.PMS_REPORTS)return {status:'not_configured',imported:0};
  const owner=crypto.randomUUID(),until=now.getTime()+120000;
  const claimed=await env.DB.prepare(`insert into pms_bridge_lease(id,owner,until_ms) values ('archive',?,?)
    on conflict(id) do update set owner=excluded.owner,until_ms=excluded.until_ms where pms_bridge_lease.until_ms<=?`)
    .bind(owner,until,now.getTime()).run();
  if(!claimed.meta.changes)return {status:'already_running',imported:0};
  try{return await pollUnlocked(env,now);}
  finally{await env.DB.prepare("delete from pms_bridge_lease where id='archive' and owner=?").bind(owner).run();}
}
async function pollUnlocked(env, now) {
  const at=now.toISOString(),today=bkkDay(now);
  const files=await all(env.PMS_ARCHIVE_DB.prepare(`select f.id,f.object_key,f.bytes,f.checksum_sha256,e.received_at
    from report_files f join report_emails e on f.email_id=e.id
    where lower(f.filename) glob 'history_forecast*.txt' or lower(f.filename) glob 'history_forecast*.tsv'
    order by e.received_at desc,f.id desc limit 10`));
  let imported=0,blocked=0;const seen=files[0]?.received_at||null;
  let processed=0;
  for(const file of files){
    const old=await env.DB.prepare('select status,attempts from pms_bridge_receipts where file_id=? and checksum=? and bridge_version=?').bind(file.id,file.checksum_sha256,VERSION).first();
    if(old&&['imported','blocked'].includes(old.status)){if(old.status==='blocked')blocked++;continue;}
    if(processed>=2)break;
    processed++;
    const attempts=(old?.attempts||0)+1;let status='retry',reason='',snapshot=null;
    try{
      if(!file.object_key.startsWith('reports/')||file.bytes>3*1024*1024)throw new Error('unsupported_archive_size_or_key');
      const object=await env.PMS_REPORTS.get(file.object_key);if(!object)throw new Error('archive_object_missing');
      if(object.size>3*1024*1024)throw new Error('unsupported_archive_size_or_key');
      const body=await parseReport(await object.arrayBuffer(),file.checksum_sha256,today,env.PMS_VERIFIED_CURRENCY||null);
      snapshot=body.snapshot.id;
      const result=await ingestPms(env.DB,body,now);if(!result.duplicate)imported++;
      await env.DB.prepare(`insert or ignore into pms_snapshot_provenance(snapshot_id,as_of_basis,archived_at) values (?,'actual_projection_business_cutoff',?)`).bind(snapshot,file.received_at).run();
      status='imported';
    }catch(error){
      const known=['archive_checksum_mismatch','invalid_report_date','invalid_report_number','unsupported_history_forecast_schema','ambiguous_source_business_cutoff','invalid_property_day_aggregates','unsupported_archive_size_or_key'];
      reason=known.includes(error.message)?error.message:'archive_read_or_store_failed';
      if(known.includes(reason)||attempts>=3){status='blocked';blocked++;}
    }
    await env.DB.prepare(`insert into pms_bridge_receipts(file_id,checksum,bridge_version,processed_at,status,attempts,snapshot_id,reason)
      values (?,?,?,?,?,?,?,?) on conflict(file_id,checksum,bridge_version) do update set processed_at=excluded.processed_at,status=excluded.status,attempts=excluded.attempts,snapshot_id=excluded.snapshot_id,reason=excluded.reason`)
      .bind(file.id,file.checksum_sha256,VERSION,at,status,attempts,snapshot,reason).run();
  }
  const latest=await env.DB.prepare('select as_of from pms_snapshots order by as_of desc limit 1').first();
  const sourceAge=latest?Math.floor((Date.parse(today)-Date.parse(latest.as_of))/864e5):null;
  const state={bridge_version:VERSION,last_poll_at:at,last_archive_received_at:seen,source_as_of:latest?.as_of||null,
    status:blocked?'needs_review':!seen?'waiting_for_report':sourceAge===null||sourceAge>1?'waiting_for_new_report':'current',imported,blocked,checked:files.length,processed};
  await env.DB.prepare("insert into pms_feed_state(id,state) values ('opera_archive',?) on conflict(id) do update set state=excluded.state").bind(JSON.stringify(state)).run();
  return state;
}

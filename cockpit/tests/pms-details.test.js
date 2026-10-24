import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {db} from './helpers/sqlite.js';
import {parseReport} from '../src/pms-bridge.js';
import {validatePms,ingestPms} from '../src/revenue.js';
import {operatingDetails} from '../src/pms-details.js';
import worker from '../src/worker.js';
const headers='REC_TYPE CONSIDERED_DATE CF_OCCUPANCY CF_AVERAGE_ROOM_RATE REVENUE NO_ROOMS INVENTORY_ROOMS CF_CALC_INV_ROOMS CF_CALC_OCC_ROOMS CF_OOO_ROOMS IND_DEDUCT_ROOMS GRP_DEDUCT_ROOMS IND_NON_DEDUCT_ROOMS GRP_NON_DEDUCT_ROOMS IND_DEDUCT_REVENUE GRP_DEDUCT_REVENUE NO_SHOW_ROOMS'.split(' ');
async function payload(){
 const line=(type,date,noShow)=>[type,date,80,1000,80000,80,120,100,80,20,50,30,0,10,50000,30000,noShow].join('\t');
 const bytes=new TextEncoder().encode([headers.join('\t'),line('A_STAT','23-OCT-26','2'),line('B_FORE','24-OCT-26','')].join('\n'));
 return parseReport(bytes,createHash('sha256').update(bytes).digest('hex'),'2026-10-24');
}
test('raw operating details reconcile effective capacity and group splits; missing is not zero',async()=>{
 const p=await payload();assert.deepEqual(validatePms(p,'2026-10-24'),[]);
 const actual=operatingDetails(p.rows[0]),future=operatingDetails(p.rows[1]);
 assert.equal(actual.effective_occupancy,80);assert.equal(actual.effective_revpar,800);
 assert.equal(actual.effective_headroom,20);assert.equal(actual.individual_adr,1000);assert.equal(actual.group_adr,1000);
 assert.ok(Object.values(actual.reconciliation).every(v=>v===true));
 assert.equal(future.no_show,null);assert.equal(actual.no_show,2);
 assert.equal(actual.group_non_deduct_rooms,10); // never added to 80 sold rooms
 const bad=operatingDetails({...p.rows[0],details:{...p.rows[0].details,effective_inventory:90}});
 assert.equal(bad.reconciliation.inventory,false);assert.equal(bad.reconciliation.occupancy,false);
 const missing=operatingDetails({...p.rows[0],details:{effective_inventory:null}});
 assert.equal(missing.effective_occupancy,null);assert.equal(missing.reconciliation.inventory,null);
 for(const details of [{guest_name:'bad'},{arrivals:-1},{no_show:true},{out_of_order:Infinity},{},null]){
   const q=structuredClone(p);q.rows[0].details=details;assert.ok(validatePms(q,'2026-10-24').length);
 }
});
test('upgrade enriches an existing immutable vintage and API exposes both denominators without refreshing source',async()=>{
 const DB=db(),p=await payload(),env={DB,OTA_INGEST_TOKEN:'test'};
 const old=structuredClone(p);for(const r of old.rows)delete r.details;
 await ingestPms(DB,old,new Date('2026-10-24T00:00:00Z'));
 assert.equal((await ingestPms(DB,p)).duplicate,true);
 await ingestPms(DB,p);
 assert.equal((await DB.prepare('select count(*) n from pms_daily_details').first()).n,2);
 assert.equal((await DB.prepare('select received_at from pms_snapshots').first()).received_at,'2026-10-24T00:00:00.000Z');
 const state=await(await worker.fetch(new Request('https://x/api/state',{headers:{Authorization:'Bearer test'}}),env)).json();
 const r=state.revenue.days[0];assert.equal(r.occupancy,80/120*100);assert.equal(r.operations.effective_occupancy,80);
 assert.equal(state.revenue.source.as_of,'2026-10-24');DB.close();
});

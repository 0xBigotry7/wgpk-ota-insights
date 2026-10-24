import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export const db = () => {
  // Real SQLite through Python, available on the hotel host and CI; no Node experimental API/dependency.
  const dir=mkdtempSync(join(tmpdir(),'ota-sql-')), file=join(dir,'db.sqlite');
  const execute=input=>{
    const script=`import json,sys,sqlite3
p=json.load(sys.stdin)
c=sqlite3.connect(p['file'])
c.row_factory=sqlite3.Row
out=[]
try:
 if 'schema' in p: c.executescript(p['schema'])
 else:
  for q in p['queries']:
   cur=c.execute(q['sql'],q.get('args',[]))
   rows=[dict(r) for r in cur.fetchall()] if cur.description else []
   out.append({'results':rows,'meta':{'last_row_id':cur.lastrowid,'changes':cur.rowcount}})
 c.commit()
 print(json.dumps(out))
finally: c.close()`;
    const result=spawnSync('python3',['-c',script],{input:JSON.stringify({file,...input}),encoding:'utf8'});
    if(result.status!==0)throw new Error(result.stderr);return JSON.parse(result.stdout);
  };
  execute({schema:readFileSync(new URL('../../schema.sql',import.meta.url),'utf8')});
  return {prepare(sql){const bound=args=>({sql,args,async first(){return execute({queries:[{sql,args}]})[0].results[0]||null;},async all(){return execute({queries:[{sql,args}]})[0];},async run(){return execute({queries:[{sql,args}]})[0];}});return {...bound([]),bind:(...args)=>bound(args)};},async batch(stmts){return execute({queries:stmts.map(s=>({sql:s.sql,args:s.args}))});},close(){rmSync(dir,{recursive:true,force:true});}};
};

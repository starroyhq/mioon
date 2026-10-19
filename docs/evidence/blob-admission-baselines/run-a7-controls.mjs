import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const base=path.dirname(new URL(import.meta.url).pathname),results=[];
for(const name of ['pre-a7','a7','ff85','current']){
 const root=path.join(base,name),args=['--import',path.join(base,'source-guard.mjs'),'--test','--test-reporter=tap','--test-name-pattern','ordinary current-schema reopen (?:keeps raw|rejects legacy BLOB)','tests/workspace-restore-schema.test.mjs'];
 const r=spawnSync(process.execPath,args,{cwd:root,env:{...process.env,TMPDIR:path.join(base,'canonical-test-tmp'),BLOB_CHECKOUT_ROOT:root,BLOB_IMPORT_AUDIT:path.join(base,name+'-controls-imports.txt')},encoding:'utf8',maxBuffer:1024**2});
 const text=r.stdout+r.stderr,log=name+'-a7-controls.tap';fs.writeFileSync(path.join(base,log),text);
 const counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped'].map(k=>[k,Number(text.match(new RegExp('^# '+k+' (\\d+)$','m'))?.[1]??NaN)]));
 results.push({name,code:r.status,signal:r.signal,counts,command:[process.execPath,...args],log});console.log(JSON.stringify(results.at(-1)));
}
fs.writeFileSync(path.join(base,'a7-controls-results.json'),JSON.stringify({node:process.execPath,version:process.version,scope:'Only the ordinary-current dynamic seed test changed by a7 and its retained BLOB refusal control; not the independent golden six.',results},null,2)+'\n');

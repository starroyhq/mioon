import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const base=path.dirname(new URL(import.meta.url).pathname);
const pattern='frozen ordinary24(?:-mock)?-seeded reopens|independent frozen restored25(?:-mock)?-seeded opens|ordinary runtime retains baseline repair eligibility for (?:known-marker-gap|initial-markers-absent)';
const results=[];const tmp=path.join(base,'canonical-test-tmp');fs.mkdirSync(tmp,{recursive:true,mode:0o700});
for(const name of ['pre-a7','a7','ff85','current']){
 const root=path.join(base,name),output=path.join(base,name+'-native.tap'),imports=path.join(base,name+'-imports.txt');
 const args=['--import',path.join(base,'source-guard.mjs'),'--test','--test-reporter=tap','--test-name-pattern',pattern,'tests/workspace-schema-profiles.test.mjs'];
 const r=spawnSync(process.execPath,args,{cwd:root,env:{...process.env,TMPDIR:tmp,BLOB_CHECKOUT_ROOT:root,BLOB_IMPORT_AUDIT:imports},encoding:'utf8',maxBuffer:8*1024**2});
 const text=r.stdout+r.stderr;fs.writeFileSync(output,text);
 const counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped'].map(k=>[k,Number(text.match(new RegExp('^# '+k+' (\\d+)$','m'))?.[1]??NaN)]));
 const cases=[...text.matchAll(/^(?:not )?ok \d+ - (.*)$/gm)].map(m=>({name:m[1],passed:!m[0].startsWith('not ')}));
 const sha=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout.trim();
 const log=fs.existsSync(imports)?fs.readFileSync(imports,'utf8').trim().split('\n'):[];
 const sources=[...new Set(log)].map(file=>({path:path.relative(root,file),sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
 results.push({name,sha,code:r.status,signal:r.signal,counts,cases,command:[process.execPath,...args],environment:{TMPDIR:tmp,scope:'per-child canonical temporary path only; no host/system setting changes'},testSha256:createHash('sha256').update(fs.readFileSync(path.join(root,'tests/workspace-schema-profiles.test.mjs'))).digest('hex'),log:path.basename(output),localSources:sources});
 console.log(JSON.stringify({name,sha,code:r.status,counts,cases}));
}
fs.writeFileSync(path.join(base,'native-results.json'),JSON.stringify({node:process.execPath,version:process.version,platform:process.platform,arch:process.arch,mode:'Each exact snapshot native test file; only six selected current-open cases. Version34 expectations in older native files are not rewritten. All imported workspace sources guarded against main-tree fallback.',results},null,2)+'\n');

import {reverseReviewedWanVideo} from './helpers/current-wan-video-delta.ts';
import {withoutReviewedInteractionObjects,currentOrdinary56Delta,reverseReviewedSchema56} from './helpers/current-schema56-delta.ts';
function withoutReviewedCurrentAgentObjects(objects){return withoutReviewedConversationObjects(withoutReviewedInteractionObjects(objects));}
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {openStore,classifyCurrentWorkspaceSchema} from '../packages/business/src/db.ts';
import {currentMarkerChain,currentOrdinary48Delta,currentOrdinary50Delta,currentOrdinary52Delta} from './helpers/current-schema-delta.ts';
import {currentOrdinary54Delta,withoutReviewedConversationObjects,reviewedSchema54SourceDeltas,reverseReviewedSchema54} from './helpers/current-schema54-delta.ts';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentEditService} from '../packages/business/src/agent/edit-proposals.ts';
import {isUnavailableRestoredRoute} from '../packages/business/src/workspace-restore-policy.ts';
import {EDIT_TOOL_DEFINITIONS,EDIT_TOOL_CATALOG_HASH,editToolPolicy,parseEditToolArguments} from '../packages/business/src/agent/edit-tool-policy.ts';
import {TIMELINE_EDIT_TOOL_DEFINITIONS,TIMELINE_EDIT_TOOL_CATALOG_HASH,timelineEditToolPolicy,parseTimelineEditToolArguments} from '../packages/business/src/agent/timeline-edit-tool-policy.ts';
import {READ_TOOL_DEFINITIONS,READ_TOOL_CATALOG_HASH,readToolPolicy,parseReadToolArguments} from '../packages/business/src/agent/read-tool-policy.ts';
import {agentTimelineGainFixture} from './helpers/agent-timeline-gain-fixture.ts';

const repo=fileURLToPath(new URL('..',import.meta.url));
const baseline=JSON.parse(fs.readFileSync(new URL('./fixtures/agent-gain-baseline-c3a0a57.json',import.meta.url),'utf8'));
const compatibility=JSON.parse(fs.readFileSync(new URL('./fixtures/agent-gain-c3a0a57-schema26-closure.json',import.meta.url),'utf8'));
// The TypeScript source migration renamed `.mjs` files to `.ts` and added
// erasable type annotations. Historical hashes/bytes in the baseline fixture
// stay authoritative and unchanged; the reviewed migration map binds each
// legacy key to its current `.ts` source and pins deterministic esbuild
// type-erased hashes so later edits are still detected.
const migrationMap=JSON.parse(fs.readFileSync(new URL('./fixtures/agent-gain-ts-migration-map.json',import.meta.url),'utf8')).mapping;
const schema50RuntimeMap=JSON.parse(fs.readFileSync(new URL('./fixtures/agent-gain-schema50-runtime-map.json',import.meta.url),'utf8')).mapping;
assert.deepEqual(Object.keys(schema50RuntimeMap).sort(),['packages/business/src/workspace-restore-policy.mjs','packages/contracts/src/index.mjs','packages/contracts/src/operation-effects.mjs','packages/contracts/src/workspace-restore.mjs'].sort());
const schema52RuntimeMap=JSON.parse(fs.readFileSync(new URL('./fixtures/agent-gain-schema52-runtime-map.json',import.meta.url),'utf8')).mapping;
assert.deepEqual(Object.keys(schema52RuntimeMap).sort(),['packages/business/src/db.mjs','packages/business/src/workspace-restore-policy.mjs','packages/contracts/src/index.mjs','packages/contracts/src/operation-effects.mjs','packages/contracts/src/subject-generation.mjs','packages/contracts/src/workspace-backup.mjs','packages/contracts/src/workspace-restore.mjs'].sort());
const subjectClosure=JSON.parse(fs.readFileSync(new URL('./fixtures/agent-gain-origin-main-subject-closure.json',import.meta.url),'utf8'));
// The schema52 pins include both the reviewed LRA and v2 changes. Check their
// actual whole source; schema50 remains the unchanged predecessor pin below.
const reviewedLoudnessRangeFragments=Object.freeze({
 'packages/contracts/src/index.mjs':"export * from './loudness-range.ts';\n",
 'packages/contracts/src/operation-effects.mjs':'Reports bounded complete-window loudness range. An explicit optional LUFS/dBTP target prepares an actually measured supported fixed-gain candidate; no implicit target or apply authority. No persistent report,',
});
const currentPath=file=>migrationMap[file]?.currentPath??file;
const cliDeltaBytes=fs.readFileSync(new URL('./fixtures/agent-cli-reviewed-source-deltas.json',import.meta.url));
const cliDeltas=JSON.parse(cliDeltaBytes);
// Keep all historical and migration pins intact. Only the exact reviewed CLI
// deltas are reversed before comparing the existing raw/type-erased pins.
function reverseReviewedCli(file,bytes){
 const delta=cliDeltas.files.find(item=>item.path===currentPath(file));if(!delta)return bytes;
 const label=`Baseline dependency changed: ${file}; reviewed CLI delta`;
 assert.equal(bytes.byteLength,delta.afterBytes,label);assert.equal(sha(bytes),delta.afterSha256,label);
 let source=bytes.toString('utf8');
 for(const inverse of delta.inverse){assert.equal(inverse.occurrences,1);assert.ok(inverse.after.length>0);assert.equal(source.split(inverse.after).length-1,1,label);source=source.replace(inverse.after,inverse.before);}
 const previous=Buffer.from(source);assert.equal(previous.byteLength,delta.beforeBytes,label);assert.equal(sha(previous),delta.beforeSha256,label);return previous;
}
// The compatible video service (OpenAI video format) adds one provider ID to
// generation.submit and to its connection-only rule. Reverse exactly these two
// unique additions before the unchanged schema52 pin; any other byte still fails.
const reviewedCompatibleVideoInverses=Object.freeze({
 'packages/contracts/src/index.mjs':Object.freeze([
  {before:"providerId:z.enum(['mock','runway','ark','veo','minimax','vidu','kling','wan']),",after:"providerId:z.enum(['mock','runway','ark','veo','minimax','vidu','kling','wan','compatible']),"},
  {before:"!has&&['kling','wan'].includes(value.providerId)",after:"!has&&['kling','wan','compatible'].includes(value.providerId)"},
 ]),
});
function reverseReviewedCompatibleVideo(file,bytes){
 // Undo newer Wan bytes first; keep this older inverse and all its pins intact.
 bytes=reverseReviewedWanVideo(currentPath(file),bytes);
 const inverses=reviewedCompatibleVideoInverses[file];if(!inverses)return bytes;
 let source=bytes.toString('utf8');
 for(const inverse of inverses){assert.equal(source.split(inverse.after).length-1,1,`Baseline dependency changed: ${file}; reviewed compatible-video delta`);source=source.replace(inverse.after,inverse.before);}
 return Buffer.from(source);
}
// Deterministic drift detection: every mapped legacy key pins the current
// whole-body hash in all environments, and additionally pins an esbuild
// type-erased body hash (tolerates erasable type-only edits). The esbuild
// native binary is platform-specific, so the type-erased half is verified when
// that binary is available (host gate); the canonical container verifies the
// exact whole-body pins and the untouched historical hashes below.
const transform={transformSync:null};
try{Object.assign(transform,await import('esbuild'));}catch{/* native esbuild binary not installed for this platform */}
function eraseSource(source){if(!transform.transformSync)return null;try{return transform.transformSync(source,{loader:'ts',format:'esm',target:'es2022'}).code;}catch{return null;}}
function assertPinnedCurrent(file,read=null){
 const mapping=migrationMap[file];if(!mapping)return;
 const reviewed=schema50RuntimeMap[file];
 if(reviewed){assert.equal(reviewed.currentPath,mapping.currentPath);assert.equal(reviewed.previousCurrentSha256,mapping.currentSha256);assert.equal(reviewed.previousTypeErasedSha256,mapping.typeErasedSha256);}
 const prior=reviewed??mapping,next=schema52RuntimeMap[file];
 if(next){assert.equal(next.currentPath,mapping.currentPath);assert.equal(next.previousCurrentSha256,prior.currentSha256);assert.equal(next.previousTypeErasedSha256,prior.typeErasedSha256);}
 const pin=next??prior;
 const text=reverseReviewedSchema54(mapping.currentPath,reverseReviewedCompatibleVideo(file,reverseReviewedCli(file,Buffer.from(read?read(file):fs.readFileSync(path.join(repo,mapping.currentPath)))))).toString();
 assert.equal(sha(text),pin.currentSha256,`Baseline dependency changed: ${file}; explicitly freeze and review it before using this harness.`);
 const erased=eraseSource(text);
 if(erased!==null)assert.equal(sha(erased),pin.typeErasedSha256,`${file}: deterministic type-erased current body`);
}
const plain=value=>JSON.parse(JSON.stringify(value));
const sha=value=>createHash('sha256').update(value).digest('hex');
const code=expected=>error=>error.code===expected;
const raw=value=>' \n'+JSON.stringify(Object.fromEntries(Object.entries(value).reverse()),null,'\t')+'\n ';
const objects=db=>plain(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all());
const sequences=db=>plain(db.prepare('SELECT rowid AS __rowid__,* FROM sqlite_sequence ORDER BY rowid').all());
const markers=db=>plain(db.prepare('SELECT * FROM schema_version ORDER BY version').all());
const tableRows=(db,table)=>plain(db.prepare(`SELECT rowid AS __rowid__,* FROM "${table}" ORDER BY rowid`).all());
function allRows(db){return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name})=>[name,tableRows(db,name)]));}
const domain=db=>Object.fromEntries(['projects','assets','shots','jobs','versions','timelines','timeline_history','timeline_history_cursors','timeline_requests'].map(table=>[table,tableRows(db,table)]));
const fields=(f,extra={})=>({projectId:f.project.id,expectedRevision:f.current().revision,requestId:randomUUID(),...extra});
function sqlState(db){return {objects:objects(db),sequence:sequences(db),markers:markers(db)};}
function reviewedCurrentObjects(all){
 const reviewedNames=new Set(currentOrdinary52Delta.objectNames),v2=all.filter(object=>reviewedNames.has(object.name));
 assert.equal(v2.length,currentOrdinary52Delta.v2Catalog.count,'reviewed v2 catalog size');assert.equal(sha(JSON.stringify(v2)),currentOrdinary52Delta.v2Catalog.sha256,'reviewed v2 catalog sha256');
 const actual=withoutReviewedCurrentAgentObjects(all).filter(object=>!reviewedNames.has(object.name));
 // Reviewed current-schema48 view of the historical24 catalog: retained objects
 // keep their frozen historical SQL except for reviewed objectSql upgrades;
 // annotation/LUT/lifecycle additions are pinned by the reviewed catalog hashes
 // in tests/fixtures/workspace-schema-profiles/current-ordinary-48-delta.json.
 const expected=structuredClone(baseline.objects);
 for(const object of expected){const reviewed=currentOrdinary48Delta.objectSql[object.name];if(reviewed!==undefined)object.sql=reviewed;}
 const additions=[];
 const take=(predicate,catalog,label)=>{
  const matched=actual.filter(object=>predicate(object)&&!expected.some(value=>value.name===object.name));
  assert.equal(matched.length,catalog.count,`${label} catalog size`);assert.equal(sha(JSON.stringify(matched)),catalog.sha256,`${label} catalog sha256`);additions.push(...matched);
 };
 const lutTables=new Set(['project_lut_resources','lut_import_requests']);
 take(object=>lutTables.has(object.tbl_name)||lutTables.has(object.name),currentOrdinary48Delta.lutCatalog,'LUT');
 take(object=>/annotation/.test(object.name)||/annotation/.test(object.tbl_name),currentOrdinary48Delta.annotationCatalog,'annotation');
 const lifecycleNames=new Set(currentOrdinary48Delta.lifecycleObjects.map(object=>object.name));
 take(object=>lifecycleNames.has(object.name),currentOrdinary48Delta.lifecycleCatalog,'lifecycle');
 const taskNames=new Set(currentOrdinary50Delta.objects.map(object=>object.name));take(object=>taskNames.has(object.name),currentOrdinary50Delta.catalog,'task-disposition50');
 assert.deepEqual(actual.filter(object=>taskNames.has(object.name)),currentOrdinary50Delta.objects);
 const unreviewed=actual.filter(object=>!expected.some(value=>value.name===object.name)&&!additions.some(value=>value.name===object.name));
 assert.deepEqual(unreviewed,[],'only reviewed current-schema additions');
 return [...expected,...additions,...v2,...currentOrdinary54Delta.objects,...currentOrdinary56Delta.objects].sort((a,b)=>a.type.localeCompare(b.type)||a.name.localeCompare(b.name));
}
function legacyRows(db){return Object.fromEntries(Object.entries(baseline.tables).filter(([table])=>!['schema_version','agent_chat_quota'].includes(table)).map(([table,rows])=>{
 const ids=rows.map(row=>row.id??row.requestId??row.projectId),key=Object.hasOwn(rows[0],'id')?'id':Object.hasOwn(rows[0],'requestId')?'requestId':'projectId';
 return [table,plain(db.prepare(`SELECT rowid AS __rowid__,* FROM "${table}" WHERE "${key}" IN (${ids.map(()=>'?').join(',')}) ORDER BY rowid`).all(...ids))];
}));}
function installBaseline(store,{merge=false}={}){
 const db=store.db;db.exec('PRAGMA foreign_keys=OFF;BEGIN IMMEDIATE;');
 try{
  for(const [table,rows]of Object.entries(baseline.tables)){
   if(['schema_version','agent_chat_quota'].includes(table)){if(merge)continue;db.prepare(`DELETE FROM "${table}"`).run();}
   for(const row of rows){const columns=Object.keys(row).filter(key=>key!=='__rowid__'),explicit=!merge;
    db.prepare(`INSERT INTO "${table}"(${explicit?'rowid,':''}${columns.map(key=>'"'+key+'"').join(',')}) VALUES(${Array(columns.length+(explicit?1:0)).fill('?').join(',')})`).run(...(explicit?[row.__rowid__]:[]),...columns.map(key=>row[key]));
   }
  }
  if(!merge){db.exec('DELETE FROM sqlite_sequence;');for(const row of baseline.sequence)db.prepare('INSERT INTO sqlite_sequence(rowid,name,seq) VALUES(?,?,?)').run(row.__rowid__,row.name,row.seq);}
  else for(const row of baseline.sequence)db.prepare('UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name=?').run(row.seq,row.name);
  db.exec('COMMIT;PRAGMA foreign_keys=ON;');
 }catch(error){if(db.isTransaction)db.exec('ROLLBACK');db.exec('PRAGMA foreign_keys=ON;');throw error;}
 const media=path.join(store.root,baseline.media.relativePath);fs.mkdirSync(path.dirname(media),{recursive:true,mode:0o700});fs.writeFileSync(media,Buffer.from(baseline.media.base64,'base64'),{mode:0o600});
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
}
function legacyFixture(t){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-fixed-agent-baseline-'));
 // Reconstruct a real historical24 database before current startup migrates it.
 // Loading old marker rows into a newly created26 table would be a false fixture.
 const db=new DatabaseSync(path.join(root,'workbench.sqlite'));db.exec('PRAGMA trusted_schema=OFF;PRAGMA foreign_keys=ON');initializeWorkspaceSchemaThrough24(db);installBaseline({db,root});
 assert.deepEqual(objects(db),baseline.objects);assert.deepEqual(sequences(db),baseline.sequence);const before=allRows(db);db.close();let store=openStore(root);
 const after=allRows(store.db);for(const [table,rows]of Object.entries(before))assert.deepEqual(table==='schema_version'?after[table].filter(row=>row.version<=24):after[table],rows,table);
 assert.deepEqual(objects(store.db),reviewedCurrentObjects(objects(store.db)));assert.deepEqual(sequences(store.db),baseline.sequence);assert.deepEqual(markers(store.db).map(row=>row.version),[...currentMarkerChain]);
 t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,get store(){return store;},reopen(){store.close();store=openStore(root);return store;}};
}

// A frozen old runtime cannot open26. Exercise its JSON validator separately
// against genuine trusted24 DDL containing the same retained scalar values,
// rather than changing its detector or relabeling a26 table as24.
function historicalStore(t,source){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const before=allRows(source.db),frozenTables=new Set(baseline.objects.filter(object=>object.type==='table').map(object=>object.name));
 db.exec('PRAGMA trusted_schema=OFF;PRAGMA foreign_keys=OFF;BEGIN');
 for(const object of baseline.objects)if(object.type==='table'&&object.name!=='sqlite_sequence')db.exec(object.sql);
 for(const table of Object.keys(before)){
  if(table==='sqlite_sequence'||!frozenTables.has(table))continue;
  const rows=source.db.prepare(`SELECT rowid AS __rowid__,* FROM "${table}" ORDER BY rowid`).all();
  for(const row of rows){
   // The frozen harness reconstructs only the trusted historical24 marker chain;
   // later current-schema markers are outside this fake old database.
   if(table==='schema_version'&&Number(row.version)>24)continue;
   const columns=Object.keys(row).filter(key=>key!=='__rowid__');
   db.prepare(`INSERT INTO "${table}"(rowid,${columns.map(key=>'"'+key+'"').join(',')}) VALUES(${Array(columns.length+1).fill('?').join(',')})`).run(row.__rowid__,...columns.map(key=>row[key]));
  }
 }
 db.exec('DELETE FROM sqlite_sequence');for(const row of before.sqlite_sequence)db.prepare('INSERT INTO sqlite_sequence(rowid,name,seq) VALUES(?,?,?)').run(row.__rowid__,row.name,row.seq);
 for(const object of baseline.objects)if(object.type!=='table'&&object.sql!==null)db.exec(object.sql);
 db.exec('COMMIT;PRAGMA foreign_keys=ON');assert.deepEqual(objects(db),baseline.objects);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 // The frozen harness reconstructs the trusted historical DDL only. The source
 // store has already been migrated to the current schema, so later tables and
 // marker rows are outside this frozen view; normalize the expectation to the
 // frozen object catalog plus the historical marker chain instead of asserting
 // the current migration additions inside a fake old database.
 const expected={};
 for(const [table,rows]of Object.entries(before)){
  if(!frozenTables.has(table))continue;
  expected[table]=rows;
 }
 expected.schema_version=before.schema_version.filter(row=>Number(row.version)<=24);
 assert.deepEqual(allRows(db),expected);
 return {db,tx(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}}};
}

// This is a frozen validator harness, not a packaged old binary. Whole old
// modules remain verbatim in the fixture; only import specifiers are redirected.
// File URLs preserve the original db/restore-schema cycle and native TS loading.
// The canonical snippet is the existing exact frozen substitution. Every live
// direct dependency remains hash-pinned, including schema-only dependencies.
// Other live helpers still load their own transitive imports; this is not a
// fully frozen application dependency graph or an application downgrade test.
let frozen;
async function loadFrozenValidators(fixture=baseline,readDependency=file=>fs.readFileSync(path.join(repo,currentPath(file)))){
 assert.equal(compatibility.sourceCommit,baseline.sourceCommit);
 assert.deepEqual(Object.keys(compatibility.sources).sort(),['packages/business/src/timeline-recovery.mjs','packages/contracts/src/edit-tasks.mjs','packages/contracts/src/workspace-backup.mjs','packages/contracts/src/workspace-restore-offline.mjs','packages/contracts/src/workspace-restore.mjs']);
 for(const [file,saved]of Object.entries(compatibility.sources)){assert.equal(Object.hasOwn(fixture.sources,file),false);assert.equal(saved.sha256,baseline.dependencyHashes[file]);}
 assert.deepEqual(compatibility.dependencyHashes,{
  'packages/business/src/timeline-format-receipts.mjs':'038bb41b5b84b8eaa0af1c09b987a767c4a3a3a2be40046f0e81536b987c1ff1',
  'packages/business/src/inspection.mjs':'2e65efe72987b3f7f9e370387081431147f09eb05cdf2a0f71d713a5d7e7c995',
  'packages/business/src/timeline-inputs.mjs':'ec83abd83d7477d20db55a140d8197e0931403ad27686c8bb660a3a3a871cd7e',
 });
 assert.equal(subjectClosure.sourceCommit,baseline.sourceCommit);assert.deepEqual(Object.keys(subjectClosure.sources),['packages/contracts/src/subject-generation.mjs']);for(const[file,saved]of Object.entries(subjectClosure.sources)){assert.equal(saved.sha256,baseline.dependencyHashes[file]);assert.equal(sha(saved.text),saved.sha256);}
 fixture={...fixture,sources:{...fixture.sources,...compatibility.sources,...subjectClosure.sources},dependencyHashes:{...fixture.dependencyHashes,...compatibility.dependencyHashes}};
 for(const [file,hash]of Object.entries(fixture.dependencyHashes)){
  const frozenSource=fixture.sources[file];
  if(frozenSource){assert.equal(sha(frozenSource.text),hash,`Baseline dependency changed: ${file}; explicitly freeze and review it before using this harness.`);continue;}
  const mapping=migrationMap[file],text=readDependency(file).toString();
  if(mapping){assert.equal(mapping.legacySha256,hash,`${file}: historical dependency pin must not be re-baselined`);assertPinnedCurrent(file,()=>text);}
  else assert.equal(sha(text),hash,`Baseline dependency changed: ${file}; explicitly freeze and review it before using this harness.`);
 }
 for(const [file,saved]of Object.entries(fixture.sources)){
  assert.match(file,/^packages\/(?:business|contracts)\/src\/[a-zA-Z0-9_./-]+\.(?:mjs|ts)$/u);
  assert.equal(path.posix.normalize(file),file);assert.ok(!file.split('/').includes('..'));
  assert.equal(sha(saved.text),saved.sha256,`Frozen source changed: ${file}`);
  const mapping=migrationMap[file];
  if(mapping)assertPinnedCurrent(file);
 }
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-old-agent-modules-'));
 const absolute=file=>pathToFileURL(path.join(repo,file)).href;
 const requireContracts=createRequire(absolute('packages/contracts/package.json'));
 const local=file=>path.join(directory,file),url=file=>pathToFileURL(local(file)).href;
 const canonical=pathToFileURL(path.join(directory,'canonical.mjs')).href;
 try{
  fs.writeFileSync(path.join(directory,'canonical.mjs'),fixture.substitutions.canonicalSource,{mode:0o600});
  for(const [file,saved]of Object.entries(fixture.sources)){
   const source=saved.text.replace(/(from\s+)(['"])([^'"]+)\2/gu,(_match,prefix,_quote,specifier)=>{
    let destination=specifier;
    if(specifier==='@mioon/contracts')destination=url('packages/contracts/src/index.mjs');
    else if(specifier==='@mioon/contracts/private-storage'&&file==='packages/business/src/db.mjs'){
     const dependency='packages/contracts/src/private-storage.mjs';assert.ok(Object.hasOwn(fixture.dependencyHashes,dependency));destination=absolute(currentPath(dependency));
    }else if(specifier.startsWith('.')){
     const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(file),specifier));
     if(resolved==='packages/business/src/services.mjs')destination=canonical;
     else if(Object.hasOwn(fixture.sources,resolved))destination=url(resolved);
     else{assert.ok(Object.hasOwn(fixture.dependencyHashes,resolved),`Unpinned frozen-validator import: ${file} -> ${resolved}`);destination=absolute(currentPath(resolved));}
    }else if(specifier==='zod'&&['packages/contracts/src/index.mjs','packages/contracts/src/timeline-export-profile.mjs','packages/contracts/src/local-delivery.ts','packages/contracts/src/workspace-backup.mjs','packages/contracts/src/workspace-restore-offline.mjs','packages/contracts/src/workspace-restore.mjs','packages/contracts/src/edit-tasks.mjs','packages/contracts/src/subject-generation.mjs'].includes(file))destination=pathToFileURL(requireContracts.resolve('zod')).href;
    else assert.ok(['node:crypto','node:net'].includes(specifier)||file==='packages/business/src/db.mjs'&&['node:sqlite','node:util/types','node:path'].includes(specifier)||file==='packages/business/src/workspace-restore-schema.mjs'&&specifier==='node:sqlite',`Unexpected frozen-validator import: ${file} -> ${specifier}`);
    return prefix+JSON.stringify(destination);
   });
   fs.mkdirSync(path.dirname(local(file)),{recursive:true,mode:0o700});fs.writeFileSync(local(file),source,{mode:0o600});
  }
  const edit=await import(url('packages/business/src/agent/edit-proposals.mjs')),context=await import(url('packages/business/src/agent/chat-context.mjs'));
  return {...edit,...context,contracts:await import(url('packages/contracts/src/index.mjs')),restorePolicy:await import(url('packages/business/src/workspace-restore-policy.mjs'))};
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
}
async function frozenValidators(){return frozen??=await loadFrozenValidators();}

function tree(root){return fs.readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{const file=path.join(root,entry.name),info=fs.lstatSync(file);return [{path:file,mode:info.mode,...(entry.isFile()?{sha256:sha(fs.readFileSync(file))}:{})},...(entry.isDirectory()?tree(file):[])];});}
async function backupCli(t,args){
 const child=spawn(process.execPath,[path.join(repo,'apps/cli/src/backup.ts'),...args],{cwd:repo,env:{PATH:process.env.PATH,HOME:process.env.HOME,MIOON_ENABLE_LIVE_PROVIDER:'0'},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',failure,closed=false;
 const done=new Promise(resolve=>{child.once('error',error=>{failure=error;});child.once('close',(exitCode,signal)=>{closed=true;resolve({exitCode,signal});});});
 for(const [stream,key]of [[child.stdout,'out'],[child.stderr,'err']])stream.setEncoding('utf8').on('data',text=>{if(key==='out')stdout+=text;else stderr+=text;if(stdout.length+stderr.length>512*1024){failure=Error('bounded CLI output exceeded');child.kill('SIGKILL');}});
 const timeout=setTimeout(()=>{failure=Error('offline backup CLI deadline');child.kill('SIGKILL');},30000);
 t.after(async()=>{if(!closed){child.kill('SIGKILL');await done;}});
 let result;try{result=await done;}finally{clearTimeout(timeout);}if(failure)throw failure;
 assert.equal(result.signal,null,stderr);assert.equal(result.exitCode,0,stdout+stderr);const body=JSON.parse(stdout);assert.equal(body.ok,true,stdout);return body.data;
}

async function capturedGainStates(t){
 const f=await agentTimelineGainFixture(t),bytes=Buffer.from('Only synthetic managed media bytes; no decode or model request.');
 f.store.put('assets',{...f.asset,sha256:sha(bytes),sizeBytes:bytes.length});fs.writeFileSync(path.join(f.root,f.asset.relativePath),bytes,{mode:0o600});installBaseline(f.store,{merge:true});
 const proposals=[];
 for(const status of ['pending','approved','unknown','applied']){
  const p=f.proposal({gain:status==='applied'?0.4:0.6});
  if(status==='approved'){f.setFault(label=>{if(label==='afterApproval')throw Error('synthetic durable approval interruption');});await assert.rejects(f.edits.approve(f.request(p)),/synthetic durable approval interruption/);f.setFault(()=>{});}
  else if(status==='unknown'){f.setDispatch(()=>{throw Error('synthetic uncertain dispatch');});assert.equal((await f.edits.approve(f.request(p))).status,'unknown');f.setDispatch(null);}
  else if(status==='applied')assert.equal((await f.edits.approve(f.request(p))).status,'applied');
  const row=f.row(p);assert.equal(row.status,status);proposals.push({proposal:p,row:plain(row),definition:JSON.parse(row.definition),status});
 }
 return {f,proposals};
}

test('frozen c3a0a57 schema dependency cycle preserves exact original source hashes',()=>{
 const expected={
  'packages/business/src/db.mjs':'84af099e2b1422574fcabf27d9f3984c0c9c1f045d00860f20f16d247707544f',
  'packages/business/src/workspace-fixed-schema.mjs':'9751e2f2d74b64c1cbd070d61e11941d1eba135ca8748bbdc20bd20ebab05bab',
  'packages/business/src/workspace-restore-schema.mjs':'9b3861b3e0ec72b0ab1d1b676657205f5b3a934342abf308a4cc394307c3670b',
  'packages/business/src/image-schema.mjs':'8a364f2d61669cff35ba6a77d5a8a6fd5a26044bfa970b09e78ce780929931e3',
  'packages/business/src/frame-schema.mjs':'d1310a5945bfcf577b5e2780159507e753eb28f3b4e94d5e109c4bf65ced2655',
 };
 assert.equal(baseline.sourceCommit,'c3a0a57da7b54f62a999fe006dbc47d46d6c83c0');
 for(const [file,hash]of Object.entries(expected)){
  const saved=baseline.sources[file],mapping=migrationMap[file];
  assert.equal(saved.sha256,hash);assert.equal(sha(saved.text),hash);assert.equal(baseline.dependencyHashes[file],hash);
  assert.ok(mapping,`${file}: reviewed legacy-to-current migration map`);assert.equal(mapping.legacySha256,hash);
  assertPinnedCurrent(file);
 }
});
test('reviewed schema50 current-runtime pins reject every additional source byte while preserving old pins',()=>{
 for(const file of new Set([...Object.keys(schema50RuntimeMap),...Object.keys(schema52RuntimeMap)])){assertPinnedCurrent(file);assert.throws(()=>assertPinnedCurrent(file,()=>fs.readFileSync(path.join(repo,currentPath(file)),'utf8')+'\n// synthetic unauthorized drift\n'),/Baseline dependency changed/);}
});
test('reviewed schema54 source edits reverse exactly to frozen52 pins and reject changed, repeated or unknown bytes',()=>{
 assert.deepEqual(reviewedSchema54SourceDeltas.map(delta=>delta.path),['packages/business/src/workspace-restore-policy.ts','packages/contracts/src/workspace-backup.ts','packages/contracts/src/workspace-restore.ts']);
 for(const delta of reviewedSchema54SourceDeltas){
  const file=Object.keys(schema52RuntimeMap).find(key=>currentPath(key)===delta.path);assert.ok(file);
  const before=execFileSync('git',['show',`4355c0746821dad76622b9fdaaed72400bdc5a92:${delta.path}`],{cwd:repo,maxBuffer:1024*1024,timeout:5000}),source=reverseReviewedSchema56(delta.path,fs.readFileSync(path.join(repo,delta.path))).toString('utf8');
  assert.equal(sha(before),schema52RuntimeMap[file].currentSha256,'the old schema52 pin is unchanged');
  assert.deepEqual(reverseReviewedSchema54(delta.path,Buffer.from(source)),before,'only the reviewed capability/profile bytes reverse');assertPinnedCurrent(file);
  for(const inverse of delta.inverse)for(const changed of [source.replace(inverse.after,inverse.after+' '),source.replace(inverse.after,inverse.after+inverse.after),source.replace(inverse.after,''),source+'\nimport unknown from "./not-a-reviewed-dependency.ts";\n'])assert.throws(()=>assertPinnedCurrent(file,()=>changed),/Baseline dependency changed/);
 }
});
test('finite CLI source deltas recover exact Git predecessors without changing historical or migration pins',()=>{
 assert.equal(sha(cliDeltaBytes),'46376e8cbbb647cd28790fdfbebfc795cb462cbe180d918ff12df160af491398');
 assert.equal(cliDeltas.formatVersion,1);assert.equal(cliDeltas.predecessorCommit,'3e5ed71c01ff8d06403e1c4b2cb082cd81e26907');assert.equal(cliDeltas.acceptedCommit,'6904a53249a2cdec1ee6a84c8bfb01f8e0056353');
 assert.deepEqual(cliDeltas.files.map(item=>item.path),['packages/business/src/agent/chat-errors.ts','packages/business/src/local-drafts.ts','packages/business/src/workspace-lock.ts','packages/contracts/src/private-storage.ts']);
 for(const delta of cliDeltas.files){
  const before=execFileSync('git',['show',`${cliDeltas.predecessorCommit}:${delta.path}`],{cwd:repo,maxBuffer:1024*1024,timeout:5000}),accepted=execFileSync('git',['show',`${cliDeltas.acceptedCommit}:${delta.path}`],{cwd:repo,maxBuffer:1024*1024,timeout:5000});
  assert.equal(sha(before),delta.beforeSha256);assert.equal(sha(accepted),delta.afterSha256);assert.deepEqual(reverseReviewedCli(delta.path,accepted),before);assert.ok(delta.review.length>40);
  const file=Object.keys(migrationMap).find(key=>currentPath(key)===delta.path);if(!file)continue;
  assert.equal(delta.beforeSha256,migrationMap[file].currentSha256,'unchanged migration pin');assertPinnedCurrent(file);
  const source=reverseReviewedSchema56(delta.path,fs.readFileSync(path.join(repo,delta.path))).toString('utf8');
  for(const inverse of delta.inverse)for(const changed of [source.replace(inverse.after,inverse.after+' '),source.replace(inverse.after,inverse.after+inverse.after),source.replace(inverse.after,''),source+'\nimport unknown from "./not-a-reviewed-dependency.ts";\n'])assert.throws(()=>assertPinnedCurrent(file,()=>changed),/Baseline dependency changed/);
 }
});
test('reviewed loudness-range bytes are pinned through schema52 and reject changed, duplicate or unknown source bytes',()=>{
 for(const [file,fragment]of Object.entries(reviewedLoudnessRangeFragments)){
  const source=fs.readFileSync(path.join(repo,currentPath(file)),'utf8');
  assert.equal(source.split(fragment).length-1,1,`${file}: unique reviewed loudness-range bytes`);
  assert.equal(schema52RuntimeMap[file].previousCurrentSha256,schema50RuntimeMap[file].currentSha256,`${file}: unchanged schema50 predecessor`);
  assertPinnedCurrent(file);
  for(const changed of [
   source.replace(fragment,fragment+' '),
   source.replace(fragment,fragment+fragment),
   source.replace(fragment,''),
   source+'\nimport unknown from "./not-a-reviewed-dependency.ts";\n',
  ])assert.throws(()=>assertPinnedCurrent(file,()=>changed),/Baseline dependency changed/);
 }
});

test('reviewed compatible-video bytes are pinned through schema52 and reject changed, duplicate or unknown source bytes',()=>{
 for(const [file,inverses]of Object.entries(reviewedCompatibleVideoInverses)){
  const source=fs.readFileSync(path.join(repo,currentPath(file)),'utf8');
  assertPinnedCurrent(file);
  for(const inverse of inverses){
   assert.equal(source.split(inverse.after).length-1,1,`${file}: unique reviewed compatible-video bytes`);assert.equal(source.split(inverse.before).length-1,0,`${file}: predecessor snippet replaced`);
   for(const changed of [
    source.replace(inverse.after,inverse.after+' '),
    source.replace(inverse.after,inverse.after+inverse.after),
    source.replace(inverse.after,''),
    source.replace(inverse.after,inverse.before),
    source+'\nimport unknown from "./not-a-reviewed-dependency.ts";\n',
   ])assert.throws(()=>assertPinnedCurrent(file,()=>changed),/Baseline dependency changed/);
  }
 }
});
test('frozen validator loader rejects changed historical source before import',async()=>{
 const changed=plain(baseline);changed.sources['packages/business/src/db.mjs'].text+='\n// deliberate drift';
 await assert.rejects(loadFrozenValidators(changed),/Baseline dependency changed: packages\/business\/src\/db\.mjs/u);
 const unpinnedSource=plain(baseline);unpinnedSource.sources['packages/business/src/agent/chat-context.mjs'].text+='\n// deliberate drift';
 await assert.rejects(loadFrozenValidators(unpinnedSource),/Frozen source changed: packages\/business\/src\/agent\/chat-context\.mjs/u);
});
test('frozen validator loader rejects live direct-dependency drift before import',async()=>{
 const target='packages/business/src/workspace-lock.ts';let reads=0;
 await assert.rejects(loadFrozenValidators(baseline,file=>{const value=fs.readFileSync(path.join(repo,currentPath(file)));if(currentPath(file)!==target)return value;reads++;return Buffer.concat([value,Buffer.from('\n// deliberate drift')]);}),/Baseline dependency changed: packages\/business\/src\/workspace-lock\.mjs/u);
 assert.equal(reads,1);
});
test('frozen validator loader refuses unpinned imports instead of broadening its dependency allowlist',async()=>{
 const changed=plain(baseline),file='packages/business/src/agent/chat-context.mjs';
 changed.sources[file].text='import unknown from "./not-a-pinned-module.mjs";\n'+changed.sources[file].text;
 changed.sources[file].sha256=sha(changed.sources[file].text);
 await assert.rejects(loadFrozenValidators(changed),/Unpinned frozen-validator import: .*not-a-pinned-module\.mjs/u);
});

test('frozen c3a0a57 restore policy and effects use the exact old catalog despite current operation additions',async()=>{
 for(const [file,expected]of [
  ['packages/business/src/workspace-restore-policy.mjs','2be61a06ccfaf1ef37837ca3111ebd16c8ef1f872489728770bf6c2470ca4b05'],
  ['packages/contracts/src/operation-effects.mjs','c34dad9256d6a24820679add3497c10ce114b28da9b1c8257a958e8b0c9cec10'],
  ['packages/contracts/src/index.mjs','b9e200c6ae0bc43dc20c8b2febedad81be6442b0e0049dc12ee0c7eee88a2104'],
  ['packages/contracts/src/local-delivery.ts','da3793397e7d9ad222965751a85520405610c9e9cd00f8fd991ed5dbb31030d2'],
  ['packages/contracts/src/timeline-acknowledgement.mjs','e1a35468ce23103007352f1aedb6f89cfc61ec6ca16c464d416e07c295eca35e'],
  ['packages/contracts/src/timeline-export-profile.mjs','3632a6a0166c0fb1219c006100a5c4fe1d005beaf2bafa53039552029494380d'],
 ])assert.equal(sha(baseline.sources[file].text),expected,file);
 const old=await frozenValidators();
 assert.equal(old.contracts.DURABLE_EDIT_OPERATIONS.length,19);
 assert.equal(old.contracts.DURABLE_EDIT_OPERATIONS.includes('timeline.loudness.apply'),false);
 assert.equal(Object.isFrozen(old.contracts.DURABLE_EDIT_OPERATIONS),true);
 assert.equal(old.restorePolicy.RESTORE_DENIED_OPERATIONS.includes('timeline.export.samplePeak'),false);
 assert.equal(Object.hasOwn(old.contracts.schemas,'timeline.export.samplePeak'),false);
 assert.equal(Object.hasOwn(old.contracts.operationEffects,'timeline.export.samplePeak'),false);
 assert.throws(()=>old.contracts.operationEffect('timeline.export.samplePeak'),/Operation effects are not defined/);
 assert.throws(()=>old.contracts.parse('timeline.export.samplePeak',{}),code('UNKNOWN_OPERATION'));
 assert.throws(()=>old.contracts.parse('timeline.render',{projectId:randomUUID(),expectedRevision:1,requestId:randomUUID(),purpose:'export',exportSettings:{profileId:'mp4_h264_float_checked_v2',resolution:'native',rateControl:{mode:'crf',quality:'standard'}}}),code('VALIDATION_ERROR'));
 assert.doesNotThrow(()=>old.contracts.assertOperationEffectCoverage(old.contracts.schemas));
 assert.equal(old.restorePolicy.workspaceRestoreError().constructor,old.contracts.AppError);
});

test('fixed c3a0a57 shot, move and inspection catalogs stay exact and reject every gain authority shape',()=>{
 for(const [name,definitions,hash,policy]of [['shot',EDIT_TOOL_DEFINITIONS,EDIT_TOOL_CATALOG_HASH,editToolPolicy],['move',TIMELINE_EDIT_TOOL_DEFINITIONS,TIMELINE_EDIT_TOOL_CATALOG_HASH,timelineEditToolPolicy],['read',READ_TOOL_DEFINITIONS,READ_TOOL_CATALOG_HASH,readToolPolicy]]){
  assert.equal(JSON.stringify(definitions),baseline.catalogs[name].definitions);assert.equal(hash,baseline.catalogs[name].hash);assert.deepEqual(policy(baseline.projectId),baseline.catalogs[name].policy);
 }
 for(const [parser,name,arguments_]of [[parseEditToolArguments,'mioon_propose_shot_update',{title:null,prompt:null,gain:0.4}],[parseTimelineEditToolArguments,'mioon_propose_timeline_clip_move',{startFrame:90,gain:0.4}],[parseReadToolArguments,'mioon_timeline_inspect',{gain:0.4}]]){
  assert.throws(()=>parser(name,JSON.stringify(arguments_)));assert.throws(()=>parser('mioon_propose_timeline_clip_gain','{"gain":0.4}'),code('AGENT_CHAT_TOOLS_UNSUPPORTED'));
 }
});

test('fixed real v1/v2 records survive startup, read, pagination and recovery with every raw byte and sequence intact',async t=>{
 const f=legacyFixture(t),beforeRows=allRows(f.store.db),beforeSql=sqlState(f.store.db);
 assert.deepEqual(objects(f.store.db),reviewedCurrentObjects(objects(f.store.db)));assert.deepEqual(sequences(f.store.db),baseline.sequence);assert.equal(classifyCurrentWorkspaceSchema(f.store.db).schemaVersion,56);
 for(const p of baseline.proposals){const row=f.store.db.prepare('SELECT definition,approval FROM agent_edit_proposals WHERE id=?').get(p.id);assert.ok(row.definition.startsWith(' \n'));assert.ok(row.approval.startsWith(' \n'));assert.equal(JSON.parse(row.definition).version,p.version);}
 f.reopen();let calls=0;const services=createServices(f.store,new Map()),edits=createAgentEditService({store:f.store,services:{...services,updateShotInProject(){calls++;throw Error('legacy dispatch forbidden');},moveTimelineClipInProject(){calls++;throw Error('legacy dispatch forbidden');},setTimelineClipGainInProject(){calls++;throw Error('gain dispatch forbidden');}}});
 assert.equal(edits.reconcile().reconciled,0);let cursor,ids=[];do{const page=edits.list({projectId:baseline.projectId,view:'all',limit:1,...(cursor?{cursor}:{})});ids.push(...page.proposals.map(p=>p.id));cursor=page.nextCursor;}while(cursor);
 assert.deepEqual(ids,[...baseline.proposals].reverse().map(p=>p.id));
 for(const p of baseline.proposals){const value=edits.get({projectId:baseline.projectId,proposalId:p.id});assert.equal(value.status,'applied');assert.deepEqual(await edits.recover({projectId:baseline.projectId,proposalId:p.id,digest:p.digest}),value);}
 assert.equal(calls,0);assert.deepEqual(allRows(f.store.db),beforeRows);assert.deepEqual(sqlState(f.store.db),beforeSql);
});

test('v3 uses existing SQL only and the frozen old validator rejects or holds new JSON without inference or payload rewrites',async t=>{
 const {f,proposals}=await capturedGainStates(t),old=await frozenValidators();let calls=0;
 const services={updateShotInProject(){calls++;throw Error('no dispatch');},moveTimelineClipInProject(){calls++;throw Error('no dispatch');},setTimelineClipGainInProject(){calls++;throw Error('no dispatch');}};
 const current=allRows(f.store.db);assert.throws(()=>old.createAgentEditService({store:f.store,services}),code('RESTORE_STORE_UNVERIFIED'));assert.deepEqual(allRows(f.store.db),current);
 const historical=historicalStore(t,f.store),oldEdits=old.createAgentEditService({store:historical,services}),before=domain(historical.db),legacy=legacyRows(historical.db),schema=sqlState(historical.db);
 assert.deepEqual(objects(f.store.db),reviewedCurrentObjects(objects(f.store.db)));assert.equal(classifyCurrentWorkspaceSchema(f.store.db).profile,'ordinary');assert.equal(markers(f.store.db).at(-1).version,56);assert.deepEqual(schema.objects,baseline.objects);
 assert.throws(()=>old.parseChatConsent({context:'selected_timeline_clip_gain',destination:'http://127.0.0.1:11434/v1',protocol:'chat_completions',model:'synthetic',projectId:f.project.id,gain:0.4}),code('AGENT_CHAT_VALIDATION'));
 for(const {proposal:p}of proposals){assert.throws(()=>oldEdits.get({projectId:f.project.id,proposalId:p.id}),code('AGENT_EDIT_STORAGE_UNAVAILABLE'));await assert.rejects(oldEdits.approve(f.request(p)),code('AGENT_EDIT_STORAGE_UNAVAILABLE'));await assert.rejects(oldEdits.recover(f.request(p)),code('AGENT_EDIT_STORAGE_UNAVAILABLE'));}
 assert.equal(calls,0);assert.deepEqual(domain(historical.db),before);assert.deepEqual(sqlState(historical.db),schema);
 oldEdits.reconcile();
 for(const {proposal:p,row,status}of proposals){const actual=plain(historical.db.prepare('SELECT * FROM agent_edit_proposals WHERE id=?').get(p.id));assert.equal(actual.definition,row.definition);assert.equal(actual.approval,row.approval);assert.equal(actual.outcome,row.outcome);assert.equal(actual.position,row.position);assert.equal(actual.status,status==='approved'?'unknown':status);delete actual.status;delete actual.updatedAt;const expected={...row};delete expected.status;delete expected.updatedAt;assert.deepEqual(actual,expected);}
 assert.equal(calls,0);assert.deepEqual(domain(historical.db),before);assert.deepEqual(legacyRows(historical.db),legacy);assert.deepEqual(sqlState(historical.db),schema);assert.deepEqual(allRows(f.store.db),current);
});

test('frozen old definition version gate rejects v3 even when a valid old move mode and target precede it',async t=>{
 const f=legacyFixture(t),old=await frozenValidators(),p=baseline.proposals.find(p=>p.version===2),historical=historicalStore(t,f.store),db=historical.db;
 const original=db.prepare('SELECT * FROM agent_edit_proposals WHERE id=?').get(p.id),definition=JSON.parse(original.definition);definition.version=3;
 // Isolated corruption probe: replace the SQL fixture before exercising reads;
 // this intentionally drops only the immutable-definition trigger locally.
 const guards=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='agent_edit_proposals'").all().filter(value=>/definition/.test(value.sql));
 assert.ok(guards.length);for(const guard of guards)db.exec(`DROP TRIGGER "${guard.name}"`);
 const digest=sha(JSON.stringify(definition,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value));
 db.prepare('UPDATE agent_edit_proposals SET definition=?,digest=? WHERE id=?').run(raw(definition),digest,p.id);for(const guard of guards)db.exec(guard.sql);
 const before=allRows(db);let calls=0;const edits=old.createAgentEditService({store:historical,services:{updateShotInProject(){calls++;},moveTimelineClipInProject(){calls++;}}});
 assert.throws(()=>edits.get({projectId:baseline.projectId,proposalId:p.id}),code('AGENT_EDIT_STORAGE_UNAVAILABLE'));await assert.rejects(edits.recover({projectId:baseline.projectId,proposalId:p.id,digest}),code('AGENT_EDIT_STORAGE_UNAVAILABLE'));
 assert.equal(calls,0);assert.deepEqual(allRows(db),before);assert.deepEqual(objects(db),baseline.objects);
});

test('actual offline backup CLI retains mixed legacy and v3 gain bytes; restored-local-v17 schema57 holds inherited authority while fresh manual gain stays local',{timeout:120000},async t=>{
 const {f,proposals}=await capturedGainStates(t),source=f.root,before=allRows(f.store.db),beforeSql=sqlState(f.store.db),legacy=legacyRows(f.store.db);
 const base=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-gain-backup-')),backup=path.join(base,'backup'),destination=path.join(base,'branch');t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 f.store.close();const sourceTree=tree(source);
 const created=await backupCli(t,['create','--source',source,'--destination',backup]);assert.equal(created.databaseSchemaVersion,56);const backupTree=tree(backup);
 const verified=await backupCli(t,['verify','--directory',backup]);assert.deepEqual(verified,created);
 const restored=await backupCli(t,['restore','--directory',backup,'--destination',destination]);assert.equal(restored.databaseSchemaVersion,57);assert.equal(restored.publication,'confirmed');
 assert.deepEqual(tree(source),sourceTree);assert.deepEqual(tree(backup),backupTree);
 let store=openStore(destination);t.after(()=>store.close());let services=createServices(store,new Map());
 assert.deepEqual(classifyCurrentWorkspaceSchema(store.db),{schemaVersion:57,profile:'restored-local-v17'});
 const after=allRows(store.db);for(const [table,rows]of Object.entries(before)){if(table==='schema_version'){assert.deepEqual(after[table].filter(row=>row.version<=56),rows);continue;}if(table==='edit_tasks'){assert.deepEqual(after[table].map(row=>{const result={...row};delete result.executionEpoch;return result;}),rows);continue;}assert.deepEqual(after[table],rows,table);}
 assert.deepEqual(sequences(store.db),beforeSql.sequence);assert.deepEqual(legacyRows(store.db),legacy);assert.equal(markers(store.db).length,39);
 // Existing SQL is unchanged except the two documented restoration edit-task
 // additions and new restore-owned objects; all Agent SQL remains exact.
 for(const object of beforeSql.objects.filter(value=>value.tbl_name.startsWith('agent_')))assert.deepEqual(objects(store.db).find(value=>value.name===object.name),object);
 const captured=allRows(store.db),restoreSql=sqlState(store.db),context={expectedWorkspaceOrigin:restored.workspaceOrigin};
 assert.throws(()=>createAgentEditService({store,services}),code('RESTORE_OPERATION_UNAVAILABLE'));
 for(const route of ['/api/agent/settings','/api/agent/chat/runs','/api/agent/edits','/api/agent/edits/'+proposals[0].proposal.id+'/approve','/api/agent/edits/'+proposals[1].proposal.id+'/recover'])assert.equal(isUnavailableRestoredRoute(route,'POST'),true);
 for(const {definition,status}of proposals){
  if(status==='applied'){const receipt=store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(definition.input.requestId);assert.deepEqual(await services.call('timeline.clip.update',definition.input,context),JSON.parse(receipt.response));}
  else await assert.rejects(services.call('timeline.clip.update',definition.input,context),code('RESTORED_RECORD_HELD'));
  await assert.rejects(services.call('timeline.clip.update',{...definition.input,patch:{gain:0.2}},context),error=>['RESTORED_RECORD_HELD','IDEMPOTENCY_CONFLICT'].includes(error.code));
  await assert.rejects(services.call('timeline.track.add',{projectId:f.project.id,expectedRevision:definition.input.expectedRevision,requestId:definition.input.requestId,kind:'audio'},context),error=>['RESTORED_RECORD_HELD','IDEMPOTENCY_CONFLICT'].includes(error.code));
  await assert.rejects(async()=>services.setTimelineClipGainInProject(f.project.id,definition.input,definition.target),code('RESTORE_OPERATION_UNAVAILABLE'));
 }
 assert.deepEqual(allRows(store.db),captured);assert.deepEqual(sqlState(store.db),restoreSql);
 const timeline=store.get('timelines',f.timeline.id),input={projectId:f.project.id,clipId:f.clip.id,expectedRevision:timeline.revision,requestId:randomUUID(),patch:{gain:0.8}};
 await assert.rejects(services.call('timeline.clip.update',input),code('RESTORE_WORKSPACE_ORIGIN_REQUIRED'));assert.deepEqual(allRows(store.db),captured);
 const historyBefore=store.db.prepare('SELECT count(*) n FROM timeline_history').get().n,receiptsBefore=store.db.prepare('SELECT count(*) n FROM timeline_requests').get().n;
 const changed=await services.call('timeline.clip.update',input,context);assert.equal(changed.clips.find(clip=>clip.id===f.clip.id).gain,0.8);assert.equal(changed.revision,timeline.revision+1);
 assert.equal(store.db.prepare('SELECT count(*) n FROM timeline_history').get().n,historyBefore+1);assert.equal(store.db.prepare('SELECT count(*) n FROM timeline_requests').get().n,receiptsBefore+1);
 for(const table of ['agent_edit_proposals','agent_chat_requests','agent_chat_runs','agent_chat_steps','workspace_restore_holds','workspace_restore_timeline_history','workspace_restore_timeline_cursors'])assert.deepEqual(tableRows(store.db,table),captured[table],table);
 assert.deepEqual(sequences(store.db),beforeSql.sequence);assert.deepEqual(objects(store.db),restoreSql.objects);assert.deepEqual(legacyRows(store.db),legacy);
 const afterManual=allRows(store.db);store.close();store=openStore(destination);services=createServices(store,new Map());assert.deepEqual(allRows(store.db),afterManual);assert.deepEqual(await services.call('timeline.clip.update',input),changed);assert.deepEqual(allRows(store.db),afterManual);
 assert.deepEqual(tree(source),sourceTree);assert.deepEqual(tree(backup),backupTree);
});

test('fresh gain rereads same-revision saved audio identity inside shared dispatch; historical replay tolerates metadata discovery only',async t=>{
 for(const field of ['hasAudio','sha256','mimeType']){
  const f=await agentTimelineGainFixture(t),p=f.proposal(),definition=JSON.parse(f.row(p).definition),before=domain(f.store.db),changes={hasAudio:false,sha256:'b'.repeat(64),mimeType:'video/webm'};
  f.setDispatch((projectId,input,target,services)=>{f.store.put('assets',{...f.asset,[field]:changes[field]});return services.setTimelineClipGainInProject(projectId,input,target);});
  let result;try{result=await f.edits.approve(f.request(p));}catch(error){assert.ok(['TIMELINE_SOURCE_UNAVAILABLE','AGENT_EDIT_STORAGE_UNAVAILABLE','INVALID_TIMELINE_SNAPSHOT'].includes(error.code),error.stack);}assert.notEqual(result?.status,'applied');assert.equal(f.current().clips[0].gain,1);assert.equal(f.store.db.prepare('SELECT 1 FROM timeline_requests WHERE requestId=?').get(definition.input.requestId),undefined);
  for(const table of ['timelines','timeline_history','timeline_history_cursors','timeline_requests'])assert.deepEqual(tableRows(f.store.db,table),before[table]);
 }
 const f=await agentTimelineGainFixture(t),p=f.proposal(),applied=await f.edits.approve(f.request(p)),definition=JSON.parse(f.row(p).definition),receipt=f.store.db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(definition.input.requestId);
 await f.services.call('timeline.track.update',fields(f,{trackId:f.clip.trackId,patch:{muted:true}}));await f.services.call('timeline.clip.update',fields(f,{clipId:f.clip.id,patch:{gain:1.3}}));
 f.store.put('assets',{...f.asset,hasAudio:false,duration:0.25});const before=domain(f.store.db);
 assert.deepEqual(f.edits.get({projectId:f.project.id,proposalId:p.id}).outcome,applied.outcome);assert.deepEqual(await f.services.setTimelineClipGainInProject(f.project.id,definition.input,definition.target),JSON.parse(receipt.response));assert.deepEqual(domain(f.store.db),before);
 assert.throws(()=>f.edits.pinTimelineGainTarget(f.project.id,{timelineId:f.timeline.id,clipId:f.clip.id,expectedRevision:f.current().revision}));
 for(const change of [{sha256:'b'.repeat(64)},{mimeType:'video/webm'}]){f.store.put('assets',{...f.asset,hasAudio:false,...change});const preserved=domain(f.store.db);assert.throws(()=>f.edits.get({projectId:f.project.id,proposalId:p.id}),code('TIMELINE_SOURCE_UNAVAILABLE'));assert.deepEqual(domain(f.store.db),preserved);}
});

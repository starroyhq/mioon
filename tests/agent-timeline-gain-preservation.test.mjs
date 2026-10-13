import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {createAgentEditService} from '../packages/business/src/agent/edit-proposals.mjs';
import {classifyWorkspaceSchema} from '../packages/business/src/workspace-restore-schema.mjs';
import {isUnavailableRestoredRoute} from '../packages/business/src/workspace-restore-policy.mjs';
import {EDIT_TOOL_DEFINITIONS,EDIT_TOOL_CATALOG_HASH,editToolPolicy,parseEditToolArguments} from '../packages/business/src/agent/edit-tool-policy.mjs';
import {TIMELINE_EDIT_TOOL_DEFINITIONS,TIMELINE_EDIT_TOOL_CATALOG_HASH,timelineEditToolPolicy,parseTimelineEditToolArguments} from '../packages/business/src/agent/timeline-edit-tool-policy.mjs';
import {READ_TOOL_DEFINITIONS,READ_TOOL_CATALOG_HASH,readToolPolicy,parseReadToolArguments} from '../packages/business/src/agent/read-tool-policy.mjs';
import {agentTimelineGainFixture} from './helpers/agent-timeline-gain-fixture.mjs';

const repo=fileURLToPath(new URL('..',import.meta.url));
const baseline=JSON.parse(fs.readFileSync(new URL('./fixtures/agent-gain-baseline-c3a0a57.json',import.meta.url),'utf8'));
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
 const root=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-fixed-agent-baseline-'));let store=openStore(root);installBaseline(store);
 t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,get store(){return store;},reopen(){store.close();store=openStore(root);return store;}};
}

// This is a frozen validator harness, not a packaged old binary. Whole old
// modules are retained verbatim in the fixed fixture. Only import specifiers
// are redirected. canonical remains an exact frozen exported snippet; the
// historical contracts barrel, effects catalog and restore policy are whole
// frozen modules. Other direct dependencies must match their baseline hashes.
// Unchanged current business helpers still load their own transitive imports;
// this is deliberately not a fully frozen application dependency graph.
let frozen;
async function frozenValidators(){
 if(frozen)return frozen;
 for(const [file,hash]of Object.entries(baseline.dependencyHashes))assert.equal(sha(baseline.sources[file]?.text??fs.readFileSync(path.join(repo,file))),hash,`Baseline dependency changed: ${file}; explicitly freeze and review it before using this harness.`);
 const data=source=>'data:text/javascript;charset=utf-8,'+encodeURIComponent(source);
 const absolute=file=>pathToFileURL(path.join(repo,file)).href;
 const requireContracts=createRequire(absolute('packages/contracts/package.json'));
 const canonical=data(baseline.substitutions.canonicalSource),cache=new Map();
 const contracts=url('packages/contracts/src/index.mjs');
 function url(file){
  if(cache.has(file))return cache.get(file);
  const saved=baseline.sources[file];assert.ok(saved,`Missing frozen source ${file}`);assert.equal(sha(saved.text),saved.sha256,file);
  const source=saved.text.replace(/(from\s+)(['"])([^'"]+)\2/gu,(_match,prefix,_quote,specifier)=>{
   let destination=specifier;
   if(specifier==='@mioon/contracts')destination=contracts;
   else if(specifier.startsWith('.')){
    const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(file),specifier));
    if(resolved==='packages/business/src/services.mjs')destination=canonical;
    else if(Object.hasOwn(baseline.sources,resolved))destination=url(resolved);
    else{assert.ok(Object.hasOwn(baseline.dependencyHashes,resolved),`Unpinned frozen-validator import: ${file} -> ${resolved}`);destination=absolute(resolved);}
   }
   else if(specifier==='zod'&&file==='packages/contracts/src/index.mjs')destination=pathToFileURL(requireContracts.resolve('zod')).href;
   else assert.ok(['node:crypto','node:net'].includes(specifier),`Unexpected frozen-validator import: ${file} -> ${specifier}`);
   return prefix+JSON.stringify(destination);
  });
  const result=data(source);cache.set(file,result);return result;
 }
 const edit=await import(url('packages/business/src/agent/edit-proposals.mjs')),context=await import(url('packages/business/src/agent/chat-context.mjs'));
 frozen={...edit,...context,contracts:await import(contracts),restorePolicy:await import(url('packages/business/src/workspace-restore-policy.mjs'))};return frozen;
}

function tree(root){return fs.readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{const file=path.join(root,entry.name),info=fs.lstatSync(file);return [{path:file,mode:info.mode,...(entry.isFile()?{sha256:sha(fs.readFileSync(file))}:{})},...(entry.isDirectory()?tree(file):[])];});}
async function backupCli(t,args){
 const child=spawn(process.execPath,[path.join(repo,'apps/cli/src/backup.mjs'),...args],{cwd:repo,env:{PATH:process.env.PATH,HOME:process.env.HOME,MIOON_ENABLE_LIVE_PROVIDER:'0'},stdio:['ignore','pipe','pipe']});
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

test('frozen c3a0a57 restore policy and effects use the exact old catalog despite current operation additions',async()=>{
 for(const [file,expected]of [
  ['packages/business/src/workspace-restore-policy.mjs','2be61a06ccfaf1ef37837ca3111ebd16c8ef1f872489728770bf6c2470ca4b05'],
  ['packages/contracts/src/operation-effects.mjs','c34dad9256d6a24820679add3497c10ce114b28da9b1c8257a958e8b0c9cec10'],
  ['packages/contracts/src/index.mjs','b9e200c6ae0bc43dc20c8b2febedad81be6442b0e0049dc12ee0c7eee88a2104'],
 ])assert.equal(sha(baseline.sources[file].text),expected,file);
 const old=await frozenValidators();
 assert.equal(old.restorePolicy.RESTORE_DENIED_OPERATIONS.includes('timeline.export.samplePeak'),false);
 assert.equal(Object.hasOwn(old.contracts.schemas,'timeline.export.samplePeak'),false);
 assert.equal(Object.hasOwn(old.contracts.operationEffects,'timeline.export.samplePeak'),false);
 assert.throws(()=>old.contracts.operationEffect('timeline.export.samplePeak'),/Operation effects are not defined/);
 assert.throws(()=>old.contracts.parse('timeline.export.samplePeak',{}),code('UNKNOWN_OPERATION'));
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
 assert.deepEqual(objects(f.store.db),baseline.objects);assert.deepEqual(sequences(f.store.db),baseline.sequence);assert.equal(classifyWorkspaceSchema(f.store.db).schemaVersion,24);
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
 const oldEdits=old.createAgentEditService({store:f.store,services}),before=domain(f.store.db),legacy=legacyRows(f.store.db),schema=sqlState(f.store.db);
 assert.deepEqual(objects(f.store.db),baseline.objects);assert.equal(classifyWorkspaceSchema(f.store.db).profile,'ordinary');assert.equal(schema.markers.at(-1).version,24);
 assert.throws(()=>old.parseChatConsent({context:'selected_timeline_clip_gain',destination:'http://127.0.0.1:11434/v1',protocol:'chat_completions',model:'synthetic',projectId:f.project.id,gain:0.4}),code('AGENT_CHAT_VALIDATION'));
 for(const {proposal:p}of proposals){assert.throws(()=>oldEdits.get({projectId:f.project.id,proposalId:p.id}),code('AGENT_EDIT_STORAGE_UNAVAILABLE'));await assert.rejects(oldEdits.approve(f.request(p)),code('AGENT_EDIT_STORAGE_UNAVAILABLE'));await assert.rejects(oldEdits.recover(f.request(p)),code('AGENT_EDIT_STORAGE_UNAVAILABLE'));}
 assert.equal(calls,0);assert.deepEqual(domain(f.store.db),before);assert.deepEqual(sqlState(f.store.db),schema);
 oldEdits.reconcile();
 for(const {proposal:p,row,status}of proposals){const actual=plain(f.row(p));assert.equal(actual.definition,row.definition);assert.equal(actual.approval,row.approval);assert.equal(actual.outcome,row.outcome);assert.equal(actual.position,row.position);assert.equal(actual.status,status==='approved'?'unknown':status);delete actual.status;delete actual.updatedAt;const expected={...row};delete expected.status;delete expected.updatedAt;assert.deepEqual(actual,expected);}
 assert.equal(calls,0);assert.deepEqual(domain(f.store.db),before);assert.deepEqual(legacyRows(f.store.db),legacy);assert.deepEqual(sqlState(f.store.db),schema);
});

test('frozen old definition version gate rejects v3 even when a valid old move mode and target precede it',async t=>{
 const f=legacyFixture(t),old=await frozenValidators(),p=baseline.proposals.find(p=>p.version===2),db=f.store.db;
 const original=db.prepare('SELECT * FROM agent_edit_proposals WHERE id=?').get(p.id),definition=JSON.parse(original.definition);definition.version=3;
 // Isolated corruption probe: replace the SQL fixture before exercising reads;
 // this intentionally drops only the immutable-definition trigger locally.
 const guards=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='agent_edit_proposals'").all().filter(value=>/definition/.test(value.sql));
 assert.ok(guards.length);for(const guard of guards)db.exec(`DROP TRIGGER "${guard.name}"`);
 const digest=sha(JSON.stringify(definition,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value));
 db.prepare('UPDATE agent_edit_proposals SET definition=?,digest=? WHERE id=?').run(raw(definition),digest,p.id);for(const guard of guards)db.exec(guard.sql);
 const before=allRows(db);let calls=0;const edits=old.createAgentEditService({store:f.store,services:{updateShotInProject(){calls++;},moveTimelineClipInProject(){calls++;}}});
 assert.throws(()=>edits.get({projectId:baseline.projectId,proposalId:p.id}),code('AGENT_EDIT_STORAGE_UNAVAILABLE'));await assert.rejects(edits.recover({projectId:baseline.projectId,proposalId:p.id,digest}),code('AGENT_EDIT_STORAGE_UNAVAILABLE'));
 assert.equal(calls,0);assert.deepEqual(allRows(db),before);assert.deepEqual(objects(db),baseline.objects);
});

test('actual offline backup CLI retains mixed legacy and v3 gain bytes; schema25 holds inherited authority while fresh manual gain stays local',{timeout:120000},async t=>{
 const {f,proposals}=await capturedGainStates(t),source=f.root,before=allRows(f.store.db),beforeSql=sqlState(f.store.db),legacy=legacyRows(f.store.db);
 const base=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-gain-backup-')),backup=path.join(base,'backup'),destination=path.join(base,'branch');t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 f.store.close();const sourceTree=tree(source);
 const created=await backupCli(t,['create','--source',source,'--destination',backup]);assert.equal(created.databaseSchemaVersion,24);const backupTree=tree(backup);
 const verified=await backupCli(t,['verify','--directory',backup]);assert.deepEqual(verified,created);
 const restored=await backupCli(t,['restore','--directory',backup,'--destination',destination]);assert.equal(restored.databaseSchemaVersion,25);assert.equal(restored.publication,'confirmed');
 assert.deepEqual(tree(source),sourceTree);assert.deepEqual(tree(backup),backupTree);
 let store=openStore(destination);t.after(()=>store.close());let services=createServices(store,new Map());
 assert.deepEqual(classifyWorkspaceSchema(store.db),{schemaVersion:25,profile:'restored-local-v1'});
 const after=allRows(store.db);for(const [table,rows]of Object.entries(before)){if(table==='schema_version'){assert.deepEqual(after[table].filter(row=>row.version<=24),rows);continue;}if(table==='edit_tasks'){assert.deepEqual(after[table].map(row=>{const result={...row};delete result.executionEpoch;return result;}),rows);continue;}assert.deepEqual(after[table],rows,table);}
 assert.deepEqual(sequences(store.db),beforeSql.sequence);assert.deepEqual(legacyRows(store.db),legacy);assert.equal(markers(store.db).length,25);
 // Existing SQL is unchanged except the two documented schema25 edit-task
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

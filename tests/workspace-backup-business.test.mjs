import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.mjs';
import {canonicalImageInput as canonical,IMAGE_FIXED_OPTIONS} from '../packages/contracts/src/images.mjs';
import {workspaceBackupManifestSchema,workspaceBackupResultSchema} from '../packages/contracts/src/workspace-backup.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const code=expected=>error=>error.code===expected;
function fixture(t){
 const base=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-backup-business-')),source=path.join(base,'source'),destination=path.join(base,'backup');
 fs.mkdirSync(source,{mode:0o700});fs.mkdirSync(path.join(source,'media'),{mode:0o755});
 const db=new DatabaseSync(path.join(source,'workbench.sqlite'));
 db.exec(`CREATE TABLE schema_version(version INTEGER PRIMARY KEY);INSERT INTO schema_version VALUES(24);
 CREATE TABLE assets(id TEXT PRIMARY KEY,data TEXT);CREATE TABLE jobs(id TEXT PRIMARY KEY,data TEXT);CREATE TABLE exports(id TEXT PRIMARY KEY,data TEXT);
 CREATE TABLE image_tasks(id TEXT PRIMARY KEY,projectId TEXT,requestId TEXT,groupId TEXT,inputHash TEXT,input TEXT,snapshot TEXT,stagedReceipt TEXT,state TEXT);
 CREATE TABLE frame_tasks(id TEXT PRIMARY KEY,projectId TEXT,requestId TEXT,inputHash TEXT,input TEXT,snapshot TEXT,stagedReceipt TEXT,state TEXT);
 CREATE TABLE unknown_retained_journal(id TEXT PRIMARY KEY,data BLOB);`);
 let closed=false;
 t.after(()=>{if(!closed)db.close();fs.rmSync(base,{recursive:true,force:true});});
 const write=(relative,bytes,mode=0o600)=>{const file=path.join(source,relative);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,bytes,{mode});return file;};
 const asset=(bytes=Buffer.from('synthetic media'),patch={})=>{
  const id=randomUUID(),relativePath=`media/${id}.png`,value={id,relativePath,sha256:digest(bytes),sizeBytes:bytes.length,...patch};
  db.prepare('INSERT INTO assets VALUES(?,?)').run(id,JSON.stringify(value));write(value.relativePath,bytes);return value;
 };
 const image=(patch={})=>{
  const id=randomUUID(),projectId=randomUUID(),groupId=randomUUID(),requestId=randomUUID(),input={projectId,requestId,name:'Preserved result',providerId:'mock',model:'mock-image-v1',prompt:'PRIVATE_USER_PROMPT including user-entered secrets',options:{...IMAGE_FIXED_OPTIONS}};
  const snapshot={schemaVersion:1,projectId,groupId,taskId:id,name:input.name,providerId:input.providerId,model:input.model,prompt:input.prompt,options:input.options};
  const row={id,projectId,groupId,requestId,input:canonical(input),inputHash:digest(canonical(input)),snapshot:canonical(snapshot),stagedReceipt:null,state:'outcome_unknown',...patch};
  const receipt={schemaVersion:1,taskId:id,projectId,groupId,inputHash:row.inputHash,assetId:randomUUID(),versionId:randomUUID(),sha256:digest('result bytes'),mimeType:'image/png',width:1024,height:1024,byteLength:12,isMock:true};
  const insert=()=>db.prepare('INSERT INTO image_tasks VALUES(?,?,?,?,?,?,?,?,?)').run(row.id,row.projectId,row.requestId,row.groupId,row.inputHash,row.input,row.snapshot,row.stagedReceipt,row.state);
  return {row,receipt,insert};
 };
 const close=()=>{db.close();closed=true;};
 return {base,source,destination,db,write,asset,image,close,backup:()=>createWorkspaceBackup({source,destination})};
}
const manifest=f=>JSON.parse(fs.readFileSync(path.join(f.destination,'manifest.json'),'utf8'));
const issues=result=>result.inventory.issues.map(issue=>issue.code);

test('whole SQLite bytes, unknown journals and canonical assets survive while settings/token/browser data are excluded',async t=>{
 const f=fixture(t),a=f.asset();f.db.prepare('INSERT INTO unknown_retained_journal VALUES(?,?)').run('approval/replay/cache/unknown',Buffer.from('user chat prompt and embedded secret preserved'));
 for(const name of ['access-token','agent-settings/settings.json','image-settings/settings.json','comfy-settings/settings.json','Chromium/Local State'])f.write(name,'EXCLUDED_CREDENTIAL_SENTINEL');
 f.close();const before=fs.readFileSync(path.join(f.source,'workbench.sqlite')),result=await f.backup(),value=manifest(f);
 assert.ok(workspaceBackupManifestSchema.safeParse(value).success);assert.ok(workspaceBackupResultSchema.safeParse(result).success);
 assert.equal(result.integrity,'verified');assert.equal(result.restoration,'not_tested');assert.equal(result.inventory.complete,true);
 assert.deepEqual(fs.readFileSync(path.join(f.destination,'payload/workbench.sqlite')),before);
 assert.deepEqual(fs.readFileSync(path.join(f.source,'workbench.sqlite')),before);
 assert.deepEqual(value.entries.map(entry=>entry.path).sort(),[`payload/${a.relativePath}`,'payload/workbench.sqlite'].sort());
 assert.deepEqual(await verifyWorkspaceBackup({directory:f.destination}),result);assert.deepEqual(fs.readdirSync(f.destination).sort(),['COMPLETE.json','manifest.json','payload']);
 assert.equal(fs.existsSync(path.join(f.source,'server.lock')),false);
 for(const entry of value.entries)assert.equal(fs.statSync(path.join(f.destination,entry.path)).mode&0o777,0o600);
});

test('disk receipt preserves task-bound final PNG before asset registration, plus partial PNG without invented recovery',async t=>{
 const f=fixture(t),complete=f.image(),partial=f.image();complete.insert();partial.insert();
 f.write(`image-staging/${complete.row.id}.json`,JSON.stringify(complete.receipt));f.write(`media/${complete.receipt.assetId}.png`,'result bytes');
 f.write(`image-staging/${partial.row.id}.png`,'partial bytes');f.close();const result=await f.backup(),value=manifest(f);
 assert.ok(value.entries.some(entry=>entry.path===`payload/media/${complete.receipt.assetId}.png`&&entry.role==='receipt_media'));
 assert.ok(value.entries.some(entry=>entry.path===`payload/image-staging/${partial.row.id}.png`));
 assert.ok(issues(result).includes('PARTIAL_RESULT_PRESERVED'));assert.ok(issues(result).includes('MISSING_STAGE_MANIFEST'));assert.ok(issues(result).includes('UNRESOLVED_TASK_RETAINED'));
 assert.equal(result.inventory.complete,false);assert.deepEqual(await verifyWorkspaceBackup({directory:f.destination}),result);
});

test('DB receipt alone retains a final PNG and reports missing durable manifest',async t=>{
 const f=fixture(t),task=f.image();task.row.stagedReceipt=JSON.stringify(task.receipt);task.row.state='persisting';task.insert();
 f.write(`media/${task.receipt.assetId}.png`,'result bytes');f.close();const result=await f.backup();
 assert.ok(manifest(f).entries.some(entry=>entry.path===`payload/media/${task.receipt.assetId}.png`));assert.ok(issues(result).includes('MISSING_STAGE_MANIFEST'));
});

test('valid receipt with no staged or final PNG is explicitly incomplete',async t=>{
 const f=fixture(t),task=f.image();task.row.stagedReceipt=JSON.stringify(task.receipt);task.insert();f.write(`image-staging/${task.row.id}.json`,JSON.stringify(task.receipt));f.close();
 assert.ok(issues(await f.backup()).includes('MISSING_RECEIPT_MEDIA'));
});

test('known unfinished video and export files are evidence; arbitrary files and renderer directories are excluded',async t=>{
 const f=fixture(t),job=randomUUID(),exportId=randomUUID(),attempt=randomUUID();
 f.db.prepare('INSERT INTO jobs VALUES(?,?)').run(job,JSON.stringify({status:'submission_unknown'}));f.db.prepare('INSERT INTO exports VALUES(?,?)').run(exportId,JSON.stringify({status:'running'}));
 const included=[`media/result-${job}.mp4`,`media/result-${job}.mp4.part.mp4`,`media/export-${exportId}-${attempt}.mp4`,`media/export-${exportId}-${attempt}.mp4.part.mp4`];
 included.forEach(name=>f.write(name,'uncommitted bytes'));f.write(`media/${randomUUID()}.png`,'unregistered');f.write('media/renderer-temp/intermediate.mp4','do not descend');f.close();
 const result=await f.backup();assert.equal(result.fileCount,5);assert.ok(issues(result).includes('UNCOMMITTED_RESULT_PRESERVED'));assert.ok(issues(result).includes('UNRECOGNIZED_FILE_EXCLUDED'));
 assert.ok(!issues(result).includes('INVALID_TASK_RECORD'));for(const relative of included)assert.ok(fs.existsSync(path.join(f.destination,'payload',relative)));
});

test('issues distinguish missing and mismatched registered bytes, malformed and oversized metadata',async t=>{
 const f=fixture(t),missing=f.asset(),mismatch=f.asset(Buffer.from('bytes'),{sha256:'0'.repeat(64)});fs.unlinkSync(path.join(f.source,missing.relativePath));
 f.db.prepare('INSERT INTO assets VALUES(?,?)').run(randomUUID(),'x'.repeat(128*1024+1));f.db.prepare('INSERT INTO jobs VALUES(?,?)').run(randomUUID(),'{invalid');
 f.close();const result=await f.backup();
 assert.equal(result.inventory.complete,false);assert.equal(result.inventory.truncated,false);
 for(const code of ['MISSING_REGISTERED_MEDIA','REGISTERED_MEDIA_MISMATCH','RECORD_INSPECTION_LIMIT','INVALID_TASK_RECORD'])assert.ok(issues(result).includes(code),code);
 assert.ok(manifest(f).entries.some(entry=>entry.path===`payload/${mismatch.relativePath}`));
});

test('issue detail is capped without concealing total issues or asserting completeness',async t=>{
 const f=fixture(t);for(let n=0;n<120;n++)f.write(`media/excluded-${n}.txt`,'excluded');f.close();const result=await f.backup();
 assert.equal(result.inventory.complete,false);assert.equal(result.inventory.issues.length,100);assert.equal(result.inventory.truncated,true);assert.equal(result.inventory.totalIssues,120);
});

test('inconsistent image input/snapshot cannot attest a receipt-derived final path',async t=>{
 const f=fixture(t),task=f.image();const snapshot=JSON.parse(task.row.snapshot);snapshot.prompt='mismatched prompt';task.row.snapshot=canonical(snapshot);task.insert();
 f.write(`image-staging/${task.row.id}.json`,JSON.stringify(task.receipt));f.write(`media/${task.receipt.assetId}.png`,'result bytes');f.close();
 const result=await f.backup();assert.ok(issues(result).includes('INVALID_TASK_RECORD'));assert.ok(!manifest(f).entries.some(entry=>entry.role==='receipt_media'));
});

test('frame disk receipt binds exact input, snapshot and final result before asset commit',async t=>{
 const f=fixture(t),id=randomUUID(),projectId=randomUUID(),sourceAssetId=randomUUID(),requestId=randomUUID();
 const input={projectId,sourceAssetId,sourceHash:'a'.repeat(64),sourceFrame:0,requestId},inputHash=digest(canonical(input));
 const snapshot={schemaVersion:1,projectId,taskId:id,source:{assetId:sourceAssetId,sha256:input.sourceHash,mimeType:'video/mp4',sizeBytes:12,relativePath:`media/${sourceAssetId}.mp4`,duration:1,width:4,height:2},requested:{sourceFrame:0,fps:30},profile:{id:'local-png-1024-v1',maxEdge:1024,mimeType:'image/png',upscale:false,selectionRule:'first-pts-at-or-after-v1'}};
 const receipt={schemaVersion:1,projectId,taskId:id,inputHash,sourceAssetId,sourceHash:input.sourceHash,sourceFrame:0,fps:30,profileId:snapshot.profile.id,selectionRule:snapshot.profile.selectionRule,assetId:randomUUID(),sha256:digest('frame bytes'),mimeType:'image/png',width:4,height:2,byteLength:11,probe:{streamIndex:0,timeBaseNumerator:1,timeBaseDenominator:15360,width:4,height:2,rotation:0,sarNumerator:1,sarDenominator:1}};
 f.db.prepare('INSERT INTO frame_tasks VALUES(?,?,?,?,?,?,?,?)').run(id,projectId,requestId,inputHash,canonical(input),canonical(snapshot),null,'interrupted');
 f.write(`frame-staging/${id}.json`,JSON.stringify(receipt));f.write(`media/${receipt.assetId}.png`,'frame bytes');f.close();
 const result=await f.backup();assert.ok(!issues(result).includes('INVALID_TASK_RECORD'));assert.ok(manifest(f).entries.some(entry=>entry.path===`payload/media/${receipt.assetId}.png`));
});

for(const variant of ['payload-corrupt','extra-file','extra-directory','missing-marker','manifest-corrupt','marker-corrupt'])test(`verification refuses ${variant}`,async t=>{
 const f=fixture(t);const a=f.asset();f.close();await f.backup();
 if(variant==='payload-corrupt')fs.appendFileSync(path.join(f.destination,'payload',a.relativePath),'changed');
 if(variant==='extra-file')fs.writeFileSync(path.join(f.destination,'payload/media/unexpected.txt'),'extra',{mode:0o600});
 if(variant==='extra-directory')fs.mkdirSync(path.join(f.destination,'unexpected'),{mode:0o700});
 if(variant==='missing-marker')fs.unlinkSync(path.join(f.destination,'COMPLETE.json'));
 if(variant==='manifest-corrupt')fs.appendFileSync(path.join(f.destination,'manifest.json'),' ');
 if(variant==='marker-corrupt')fs.writeFileSync(path.join(f.destination,'COMPLETE.json'),'{}');
 await assert.rejects(verifyWorkspaceBackup({directory:f.destination}),error=>error.code==='WORKSPACE_BACKUP_CORRUPT'||variant==='missing-marker'&&error.code==='WORKSPACE_BACKUP_INCOMPLETE');
});

test('database inventory enumeration stops at its fixed global row bound',async t=>{
 const f=fixture(t),insert=f.db.prepare('INSERT INTO assets VALUES(?,?)');f.db.exec('BEGIN');for(let n=0;n<20001;n++)insert.run(String(n),'{}');f.db.exec('COMMIT');f.close();
 await assert.rejects(f.backup(),code('WORKSPACE_BACKUP_LIMIT'));assert.equal(fs.existsSync(path.join(f.destination,'COMPLETE.json')),false);
});

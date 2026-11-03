import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync,readdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import type {DatabaseSync,SQLOutputValue} from 'node:sqlite';
import {openAppLibrary} from '../../packages/business/src/app-db/index.ts';
import {createServices} from '../../packages/business/src/services.ts';
import type {ProjectStore} from '../../packages/business/src/project-file/store.ts';
import {testProjectAppLibrary} from '../../packages/business/src/project-service-application.ts';
import {assetMediaPrepareResponseSchema,PROJECT_ASSETS_FOLDER,type AssetImportInput} from '../../packages/contracts/src/asset-media.ts';
import {createProjectAssetReferenceServices} from '../../packages/business/src/project-asset-references.ts';
import {isProjectFileHeld} from '../../packages/business/src/project-file/held-files.ts';
import {isAppLibraryHeld} from '../../packages/business/src/app-db/connection.ts';
import {validAssetLocator} from '../../packages/business/src/asset-reference-record.ts';
import {realpathSync} from 'node:fs';
import {openServerProject} from './project-database.ts';
import {createQaProject,closeQaProject} from './kernel-qa-fixture.mjs';
import {expectedContentMetadata} from './kernel-content-metadata.ts';
import {createProjectHomeServices} from '../../packages/business/src/project-home.ts';
import {calculateWorkspaceScope} from '../../packages/contracts/src/workspace-scope.ts';
import {lastProjectDiskSchema} from '../../packages/contracts/src/last-project.ts';
import {prepareNativeQaAuditLayout,snapshotNativeQaFiles,nativeQaProcessAlive} from './native-qa-audit.mjs';
import {recentProjectSchema} from '../../packages/contracts/src/project-registry.ts';
import {parseWorkspacePreferencesState} from '../../packages/business/src/workspace-preferences.ts';

export type QaRows=Record<string,SQLOutputValue>[];
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
/** Reports serialize actual rows; these plain values never confer Store authority. */
const serialized=(rows:QaRows):QaRows=>JSON.parse(JSON.stringify(rows)) as QaRows;
function projectFields(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid actual QA project');
 const project=value as Record<string,unknown>;
 if(typeof project.id!=='string'||typeof project.name!=='string'||typeof project.revision!=='number')throw Error('Invalid actual QA project');
 return {...project,id:project.id,name:project.name,revision:project.revision};
}
function readDatabase(db:DatabaseSync){
 const rows:Record<string,QaRows>={},schema:QaRows=[];
 for(const database of db.prepare('PRAGMA database_list').all()){
  if(typeof database.name!=='string'||database.name==='temp')continue;
  const name=database.name;
  const objects=db.prepare(`SELECT type,name,tbl_name,sql FROM ${quote(name)}.sqlite_schema ORDER BY type,name LIMIT 1025`).all();
  assert.ok(objects.length<=1024,'bounded actual schema');
  schema.push(...objects.map(row=>({database:name,...row})));
  for(const object of objects){
   if(object.type!=='table')continue;
   assert.equal(typeof object.name,'string');const table=String(object.name);
   const columns=db.prepare(`PRAGMA ${quote(name)}.table_info(${quote(table)})`).all();
   assert.ok(columns.length>0&&columns.length<=64,'bounded actual columns');
   const target=`${quote(name)}.${quote(table)}`;
   const size=db.prepare(`SELECT coalesce(sum(${columns.map(column=>`coalesce(length(CAST(${quote(String(column.name))} AS BLOB)),0)`).join('+')}),0) AS bytes FROM ${target}`).get();
   assert.ok(Number(size?.bytes)<=8*1024*1024,'bounded actual table bytes');
   const values=db.prepare(`SELECT * FROM ${target} ORDER BY rowid LIMIT 1001`).all();
   assert.ok(values.length<=1000,'bounded actual rows');rows[`${name}.${table}`]=serialized(values);
  }
 }
 return {rows,schema:serialized(schema)};
}
export async function prepareNativeQaProject(dataDir:string,name:string){
 const fixture=await createQaProject(dataDir,{name,media:false});
 const project=projectFields(fixture.store.get('projects',fixture.store.projectId));
 return {...fixture,project};
}
export {closeQaProject};
export function openNativeQaProject(dataDir:string,projectId:string){
 const store=openServerProject(dataDir,projectId),services=createServices(store,new Map(),{env:{MIOON_ENABLE_LIVE_PROVIDER:'0'}});
 try{return {store,services,project:projectFields(store.get('projects',projectId))};}catch(error){store.close();throw error;}
}
export function listNativeQaProjects(dataDir:string,owner?:ProjectStore){
 const shared=owner?testProjectAppLibrary(owner):undefined;
 if(owner&&!shared)throw Error('Only the registered actual TEST owner may borrow B1 during preparation');
 const app=shared??openAppLibrary({dataDir});try{assert.equal(app.dataDir,path.resolve(dataDir));return app.registry.list().map(entry=>({id:entry.projectId,name:entry.name}));}finally{if(!shared)app.close();}
}
/** Cold audit only. The actual B1 opener must succeed before reading projects
 * or JSON companions. A live native app rejects here, without any bare SQLite
 * connection, retry bypass or filesystem read of a held database. */
export function captureNativeQa(dataDir:string){
 assert.ok(lstatSync(path.join(dataDir,'app-library.db')).isFile(),'existing real application library');
 const app=openAppLibrary({dataDir});let entries:ReturnType<typeof app.registry.list>,application:ReturnType<typeof readDatabase>;
 try{entries=app.registry.list();application=readDatabase(app.db);}finally{app.close();}
 assert.ok(entries.length>0&&entries.length<=8,'bounded registered synthetic hosts');
 const rows:Record<string,QaRows>={},projectSnapshots:Record<string,ReturnType<typeof readDatabase>>={},locations:Record<string,{projectDir:string;projectFile:string;localDir:string;cacheDir:string;tempDir:string}>={};
 const kernelMetadata:Record<string,Record<string,QaRows>>={},metadataTableNames:string[]=[];
 const schemas:Record<string,QaRows>={application:application.schema},projectSummaries:Record<string,ReturnType<ReturnType<typeof createProjectHomeServices>['handlers']['project.summary.list']>[number]>={};
 for(const entry of [...entries].sort((a,b)=>a.projectId.localeCompare(b.projectId))){
  const store=openServerProject(dataDir,entry.projectId);
  try{
   const captured=readDatabase(store.db);projectSnapshots[entry.projectId]=captured;schemas[entry.projectId]=captured.schema;
   const summary=createProjectHomeServices(store).handlers['project.summary.list']()[0];if(!summary)throw Error('Missing actual project summary');projectSummaries[entry.projectId]=summary;
   locations[entry.projectId]={projectDir:store.projectDir,projectFile:store.projectFile,localDir:store.localDir,cacheDir:store.cacheDir,tempDir:store.tempDir};
   kernelMetadata[entry.projectId]={};
   for(const [qualified,values]of Object.entries(captured.rows)){
    const table=qualified.slice(qualified.indexOf('.')+1);
    if(['project_file','history_state','local_project_link'].includes(table)){
     const key=`${entry.projectId}.${qualified}`;rows[key]=values;kernelMetadata[entry.projectId]![table]=values;metadataTableNames.push(key);
    }else if(table==='schema_version')rows[`${entry.projectId}.${qualified}`]=values;
    else (rows[table]??=[]).push(...values);
   }
  }finally{store.close();}
 }
 for(const [qualified,values]of Object.entries(application.rows)){
  const table=qualified.slice(qualified.indexOf('.')+1);rows[table==='workspace_preferences'?table:`app.${table}`]=values;
 }
 const applicationScope=calculateWorkspaceScope({channel:'production',root:dataDir,directory:lstatSync(dataDir),db:lstatSync(path.join(dataDir,'app-library.db'))});
 return {rows,schemaSha256:hash(schemas),schemas,projectSnapshots,applicationRows:application.rows,applicationScope,locations,kernelMetadata,metadataTableNames,projectSummaries};
}
/** B1 document bytes are observed through their actual owner, never a sidecar
 * reconstructed from preferences or a second connection to a held library. */
export function readNativeQaDocument(dataDir:string,name:string):string|null{
 const app=openAppLibrary({dataDir});
 try{const row=app.db.prepare('SELECT data FROM app_documents WHERE name=?').get(name);if(!row)return null;assert.equal(typeof row.data,'string');return row.data as string;}finally{app.close();}
}
type MetadataEvidence={kernelMetadata:Record<string,Record<string,QaRows>>;metadataTableNames:string[]};
/** Only an explicitly expected host may advance its complete content pair.
 * Validate rotation and matching seen evidence before projecting the two
 * token fields; every other field and every other host remains exact. */
export function checkedNativeMetadata(before:MetadataEvidence,after:MetadataEvidence,changedProjectIds:readonly string[]=[]):ReadonlySet<string>{
 assert.deepEqual(Object.keys(after.kernelMetadata).sort(),Object.keys(before.kernelMetadata).sort());
 assert.deepEqual(after.metadataTableNames,before.metadataTableNames);
 for(const [projectId,prior]of Object.entries(before.kernelMetadata)){
  const current=after.kernelMetadata[projectId]!;
  if(current.project_file?.[0]?.contentSequence===prior.project_file?.[0]?.contentSequence)assert.deepEqual(current,prior);
  else{
   assert.ok(changedProjectIds.includes(projectId),'only the explicitly mutated host advances');
   const expected=expectedContentMetadata(prior,current);
   assert.equal(prior.history_state?.length,1,'one prior actual seen metadata row');
   assert.equal(current.history_state?.length,1,'one actual seen metadata row');
   const oldToken=prior.project_file?.[0]?.contentToken,token=current.project_file?.[0]?.contentToken;
   assert.ok(typeof oldToken==='string');assert.match(oldToken,/^[a-f0-9]{32}$/u,'the prior content token is canonical');
   assert.ok(typeof token==='string');assert.match(token,/^[a-f0-9]{32}$/u,'a changed content token is canonical');
   assert.notEqual(token,oldToken,'a content commit rotates its token');
   assert.equal(prior.history_state![0]!.seenContentSequence,prior.project_file![0]!.contentSequence,'prior seen sequence matches the portable file');
   assert.equal(prior.history_state![0]!.seenContentToken,oldToken,'prior seen token matches the portable file');
   assert.equal(current.history_state![0]!.seenContentSequence,current.project_file![0]!.contentSequence,'seen sequence matches the changed portable file');
   assert.equal(current.history_state![0]!.seenContentToken,token,'seen token matches the changed portable file');
   expected.project_file![0]!.contentToken=token;
   expected.history_state![0]!.seenContentToken=token;
   assert.deepEqual(current,expected);
  }
 }
 return new Set(after.metadataTableNames);
}
type AppEvidence={applicationScope:string;applicationRows:Record<string,QaRows>;projectSummaries:ReturnType<typeof captureNativeQa>['projectSummaries']};
/** Expected app-level effects of opening a QA project. Other documents and
 * other projects' registration/identity/preferences remain byte-exact. */
export function checkedNativeApplication(before:AppEvidence,after:AppEvidence,openedProjectIds:readonly string[],preferenceProjectIds:readonly string[]=[]):ReadonlySet<string>{
 assert.equal(after.applicationScope,before.applicationScope,'actual native application root/database identity remains exact');
 const priorDocs=before.applicationRows['main.app_documents']??[],docs=after.applicationRows['main.app_documents']??[];
 assert.deepEqual(docs.filter(row=>row.name!=='last-project-v1.json'),priorDocs.filter(row=>row.name!=='last-project-v1.json'));
 const prior=priorDocs.find(row=>row.name==='last-project-v1.json'),current=docs.find(row=>row.name==='last-project-v1.json');
 if(JSON.stringify(prior)!==JSON.stringify(current)){
  assert.ok(current&&typeof current.data==='string');const next=lastProjectDiskSchema.parse(JSON.parse(current.data));assert.ok(openedProjectIds.includes(next.projectId));assert.equal(next.workspaceScope,after.applicationScope,'the native locator belongs to this actual B1/root identity');
  if(prior){assert.equal(typeof prior.data,'string');const old=lastProjectDiskSchema.parse(JSON.parse(String(prior.data)));assert.notEqual(next.projectId,old.projectId,'remembering the same project must not write again');assert.equal(next.workspaceScope,old.workspaceScope);assert.equal(next.revision,old.revision+1);assert.ok(Date.parse(next.updatedAt)>=Date.parse(old.updatedAt));}
  else assert.equal(next.revision,1);
 }
 const oldRegistry=before.applicationRows['main.recent_projects']??[],registry=after.applicationRows['main.recent_projects']??[];
 assert.equal(registry.length,oldRegistry.length);
 for(const row of registry){
  const old=oldRegistry.find(value=>value.projectId===row.projectId);assert.ok(old);
  if(JSON.stringify(old)===JSON.stringify(row))continue;
  const parsed=recentProjectSchema.parse(JSON.parse(String(row.data))),previous=recentProjectSchema.parse(JSON.parse(String(old.data)));
  assert.ok(openedProjectIds.includes(parsed.projectId));const openedAt=parsed.lastOpenedAt;assert.ok(typeof openedAt==='string');assert.ok(previous.lastOpenedAt===null||Date.parse(openedAt)>=Date.parse(previous.lastOpenedAt));
  const summary=after.projectSummaries[parsed.projectId];assert.ok(summary);
  const {id:_id,name:_name,lastOpenedAt:_opened,...rest}=summary;
  assert.deepEqual(parsed,{...previous,lastOpenedAt:parsed.lastOpenedAt,summary:{...rest,cover:rest.cover?{assetId:rest.cover.assetId,mimeType:rest.cover.mimeType}:null}});
  assert.deepEqual({...row,data:old.data},old,'only the validated registration data changes');
 }
 const preferences=after.applicationRows['main.workspace_preferences']??[],oldPreferences=before.applicationRows['main.workspace_preferences']??[];
 assert.deepEqual(preferences.filter(row=>!preferenceProjectIds.includes(String(row.projectId))),oldPreferences.filter(row=>!preferenceProjectIds.includes(String(row.projectId))));
 for(const old of oldPreferences.filter(value=>preferenceProjectIds.includes(String(value.projectId))))assert.ok(preferences.some(row=>row.projectId===old.projectId),'existing native preferences are never removed');
 for(const row of preferences.filter(value=>preferenceProjectIds.includes(String(value.projectId)))){
  assert.ok(Number.isSafeInteger(row.revision)&&Number(row.revision)>0);assert.equal(typeof row.state,'string');parseWorkspacePreferencesState(JSON.parse(String(row.state)));
  const old=oldPreferences.find(value=>value.projectId===row.projectId);if(old&&JSON.stringify(old)!==JSON.stringify(row))assert.ok(Number(row.revision)>Number(old.revision),'a changed preference advances its real revision');
 }
 return new Set(['app.app_documents','app.recent_projects',...(preferenceProjectIds.length?['workspace_preferences']:[])]);
}

/** Live report processes collect only bounded physical evidence. Their trusted
 * layout was captured while cold; no SQLite connection is created here. */
export const prepareNativeQaLiveLayout=prepareNativeQaAuditLayout;
export function captureNativeQaLive(layout:Awaited<ReturnType<typeof prepareNativeQaAuditLayout>>,ownerPids:number[]){
 assert.ok(ownerPids.length===2&&ownerPids.every(pid=>pid!==process.pid&&nativeQaProcessAlive(pid)),'both exact native owners must be alive');
 return snapshotNativeQaFiles(layout,{ownerPids});
}

type QaProject=Pick<Awaited<ReturnType<typeof prepareNativeQaProject>>,'store'|'services'>;
export interface NativeQaAssetFile {file:string;projectDir:string;projectRelativeFile:string;sha256:string;bytes:number;referenceRevision:number}
function qaAsset(store:ProjectStore,assetId:string){
 const row=store.get('assets',assetId);assert.ok(row&&typeof row==='object'&&!Array.isArray(row));const asset=row as Record<string,unknown>;
 assert.equal(asset.id,assetId);assert.equal(asset.projectId,store.projectId);assert.ok(validAssetLocator(store.db,asset),'QA must use a canonical current asset reference');
 assert.ok(typeof asset.referenceRevision==='number'&&Number.isSafeInteger(asset.referenceRevision)&&asset.referenceRevision>0);
 return asset;
}
/** Explicit real import + prepare CAS. This never replaces services.call or
 * promotes a sampled fingerprint to a whole-file hash. */
export async function importNativeQaAsset(fixture:QaProject,input:AssetImportInput){
 const imported=await fixture.services.call('asset.import',input);assert.ok(imported&&typeof imported==='object'&&'id'in imported&&typeof imported.id==='string');
 const old=qaAsset(fixture.store,imported.id);
 const response=assetMediaPrepareResponseSchema.parse(await fixture.services.call('asset.media.prepare',{projectId:fixture.store.projectId,assets:[{assetId:imported.id,referenceRevision:old.referenceRevision}],purpose:'timeline'}));
 assert.equal(response.assets.length,1);const asset=response.assets[0]!;assert.equal(asset.id,imported.id);assert.equal(asset.projectId,fixture.store.projectId);
 const sha256=asset.sha256;assert.ok(typeof sha256==='string'&&/^[a-f0-9]{64}$/u.test(sha256),'a real full hash is required');
 const current=qaAsset(fixture.store,asset.id);assert.equal(current.sha256,sha256);assert.equal(current.referenceRevision,asset.referenceRevision);
 return {...asset,sha256};
}
/** Resolve and hash through the actual TEST owner's real B1 grants and L1
 * fences. Returned evidence is a report value, never Store authority. */
export async function nativeQaAssetFile(store:ProjectStore,assetId:string):Promise<NativeQaAssetFile>{
 const library=testProjectAppLibrary(store);assert.ok(library,'an exact TEST owner and real B1 are required');
 const asset=qaAsset(store,assetId),sha256=asset.sha256,revision=asset.referenceRevision;
 assert.ok(typeof sha256==='string'&&/^[a-f0-9]{64}$/u.test(sha256));assert.ok(typeof revision==='number');
 assert.ok(typeof asset.sizeBytes==='number'&&Number.isSafeInteger(asset.sizeBytes)&&asset.sizeBytes<512*1024*1024,'bounded actual media');
 const proof=await createProjectAssetReferenceServices(store,{outsidePaths:library.outsidePaths}).prepareFullHash(assetId,{expectedReferenceRevision:revision,maxBytes:512*1024*1024});
 assert.equal(proof.sha256,sha256);assert.equal(proof.reference.sizeBytes,asset.sizeBytes);assert.equal(proof.referenceRevision,revision);
 return{file:proof.file,projectDir:store.projectDir,projectRelativeFile:path.relative(realpathSync(store.projectDir),proof.file).split(path.sep).join('/'),sha256:proof.sha256,bytes:proof.reference.sizeBytes,referenceRevision:revision};
}
/** Cold audit: reject an existing B1 owner before project access; then normal
 * registered kernel open + its exact real application owner, never a bare DB. */
export async function coldNativeQaAssetFile(dataDir:string,projectId:string,assetId:string):Promise<NativeQaAssetFile>{
 assert.ok(lstatSync(path.join(dataDir,'app-library.db')).isFile());const admission=openAppLibrary({dataDir});admission.close();
 const store=openServerProject(dataDir,projectId);try{return await nativeQaAssetFile(store,assetId);}finally{store.close();}
}

/** Full cold filesystem oracle, including S1's canonical imported-material
 * directory and the generated-output directory. No held DB is opened. */
export function coldNativeQaMediaSnapshot(dataDir:string,projectId:string){
 const storage=captureNativeQa(dataDir),location=storage.locations[projectId];assert.ok(location);
 const files:{name:string;bytes:number;sha256:string}[]=[];
 for(const folder of ['media',PROJECT_ASSETS_FOLDER]){
  const directory=path.join(location.projectDir,folder);let names:string[];
  try{const info=lstatSync(directory);assert.ok(info.isDirectory()&&!info.isSymbolicLink());names=readdirSync(directory).sort();}catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT')continue;throw error;}
  assert.ok(names.length<=64,'bounded actual media inventory');
  for(const name of names){
   assert.match(name,/^[a-zA-Z0-9._-]+$/);const file=path.join(directory,name),before=lstatSync(file,{bigint:true}),id={dev:String(before.dev),ino:String(before.ino)};
   assert.ok(before.isFile()&&!before.isSymbolicLink()&&before.size<32n*1024n*1024n);assert.ok(!isProjectFileHeld(id)&&!isAppLibraryHeld(id),'no held SQLite identity may be read');
   const bytes=readFileSync(file),after=lstatSync(file,{bigint:true});for(const key of ['dev','ino','size','mtimeNs','ctimeNs']as const)assert.equal(after[key],before[key]);
   assert.equal(BigInt(bytes.length),before.size);files.push({name:folder==='media'?name:folder+'/'+name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
 }
 return files;
}

import {readWorkspaceBackupSchemaVersion} from './workspace-backup-schema-versions.ts';
import {OPACITY_CANDIDATE_BACKUP_PROFILE} from './opacity-candidate-backup-profile.ts';
import {OPACITY_RIPPLE_CANDIDATE_BACKUP_PROFILE} from './opacity-ripple-candidate-backup-profile.ts';
// All SQL here targets a private disposable copy, never the source workspace or
// completed payload. Unknown tables/rows are retained byte-for-byte in SQLite.
import path from 'node:path';
import {lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {imageSchemas,imageSnapshotSchema,imageReceiptSchema,canonicalImageInput,IMAGE_LIMITS,IMAGE_STATES} from '../../contracts/src/images.ts';
import {frameSchemas,frameSnapshotSchema,frameReceiptSchema,FRAME_LIMITS,FRAME_STATES} from '../../contracts/src/frame-extraction.ts';
import {isWorkspaceBackupPayloadPath} from '../../contracts/src/workspace-backup.ts';
import {readPrivateFile,validateManagedDirectory} from '@mioon/contracts/private-storage';
import {validateComfyReceiptOwnership} from './comfy/ownership.ts';
import {BACKUP_IO_LIMITS,fail,inspectFile,scanDirectory,checkCancelled} from './workspace-backup-storage.ts';
import type {Stats} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';

export interface BackupIssue {code: string;path?: string}
export interface BackupInventoryResult {complete: boolean;totalIssues: number;issues: BackupIssue[];truncated: boolean}
export interface IssueCollector {add(code: string,relative?: string): void;result(): BackupInventoryResult}
export interface InventoryPlanEntry {relative: string;role: string;identity: Stats;sha256: string|undefined;bytes: number|undefined}
export interface BackupDatabaseProfile {readSchemaVersion(db: DatabaseSync): number}
interface DatabaseEntry {path: string;role: string;bytes: number;sha256: string}
interface BuildInventoryOptions {db: DatabaseSync;source: string;signal?: AbortSignal;check: ()=>void;issues: IssueCollector;databaseEntry: DatabaseEntry}
export interface BuildInventoryResult {plan: InventoryPlanEntry[];databaseSchemaVersion: number;totalBytes: number}
interface AddOptions {allowMissing?: boolean;sha256?: string|undefined;bytes?: number|undefined}
interface GenerationInput {name: string;prompt: string;providerId: string;model: string;options: unknown;purpose?: string;inputImage?: unknown}
interface StageReceipt {
 taskId?: string;projectId?: string;inputHash?: string;groupId?: string;isMock?: boolean;schemaVersion?: number;providerId?: string;assetId?: string;
 sourceAssetId?: string;sourceHash?: string;sourceFrame?: number;fps?: number;probe?: {width?: number;height?: number};
 sha256?: string;byteLength?: number;
}

const uuidSource='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const uuid=(value: unknown): value is string=>typeof value==='string'&&new RegExp(`^${uuidSource}$`,'i').test(value);
const hash=(value: unknown): boolean=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const digest=(value: Buffer|Uint8Array|string): string=>createHash('sha256').update(value).digest('hex');
const MAX_ROWS=20000,MAX_TABLES=256;
const text=(name: string,max: number): string=>`CASE WHEN typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${max} THEN ${name} ELSE NULL END AS ${name}`;
const limited=(columns: Record<string,number>): string=>`CASE WHEN ${Object.entries(columns).map(([name,max])=>`length(CAST(${name} AS BLOB))>${max}`).join(' OR ')} THEN 1 ELSE 0 END AS limited`;
const decode=(value: unknown)=>{try{return typeof value==='string'?JSON.parse(value):null;}catch{return null;}};
export function createIssueCollector(): IssueCollector{
 let totalIssues=0;const issues: BackupIssue[]=[];
 return {add(code,relative){totalIssues++;if(issues.length<BACKUP_IO_LIMITS.issues){const candidate=relative?.startsWith('payload/')?relative:`payload/${relative}`;issues.push({code,...(typeof candidate==='string'&&/^payload\/(?:media|image-staging|frame-staging|agent-imports)\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(candidate)?{path:candidate}:{})});}},
  result:()=>({complete:totalIssues===0,totalIssues,issues:[...issues],truncated:totalIssues>issues.length})};
}
export function inspectDatabase(db: DatabaseSync,fixedProfile?: BackupDatabaseProfile): {tables: Map<string,string|null>;version: number}{
 if(fixedProfile!==undefined&&fixedProfile!==OPACITY_CANDIDATE_BACKUP_PROFILE&&fixedProfile!==OPACITY_RIPPLE_CANDIDATE_BACKUP_PROFILE)fail('DATABASE_INVALID');
 db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;');
 const checked=db.prepare('PRAGMA quick_check(1)').get();
 if(!checked||Object.values(checked)[0]!=='ok')fail('DATABASE_INVALID');
 const tables=new Map<string,string|null>();
 for(const row of db.prepare("SELECT CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END AS name,substr(sql,1,32) AS prefix FROM sqlite_schema WHERE type='table' LIMIT 257").iterate()){
  if(tables.size>=MAX_TABLES||!row.name)fail('LIMIT');
  tables.set(row.name as string,row.prefix as string|null);
 }
 if(!tables.has('schema_version')||!tables.has('assets'))fail('DATABASE_INVALID');
 const ordinary=(name: string): void=>{if(tables.has(name)&&/^CREATE\s+VIRTUAL\s+TABLE/i.test(tables.get(name)||''))fail('DATABASE_INVALID');};
 for(const table of ['schema_version','assets','jobs','exports','image_tasks','frame_tasks','image_reviews','image_remote_runs'])ordinary(table);
 const version=fixedProfile?fixedProfile.readSchemaVersion(db):readWorkspaceBackupSchemaVersion(db);
 return {tables,version};
}

export async function buildWorkspaceInventory({db,source,signal,check,issues,databaseEntry}: BuildInventoryOptions,fixedProfile?: BackupDatabaseProfile): Promise<BuildInventoryResult>{
 const {tables,version}=inspectDatabase(db,fixedProfile),plan=new Map<string, InventoryPlanEntry>(),jobs=new Set<string>(),exports=new Set<string>(),budget={count:0};let rows=0,totalBytes=databaseEntry.bytes;
 const consume=(): void=>{checkCancelled(signal);check();if(++rows>MAX_ROWS)fail('LIMIT');};
 const add=(relative: string,role: string,{allowMissing=true,sha256,bytes}: AddOptions={}): InventoryPlanEntry|null=>{
  if(!isWorkspaceBackupPayloadPath(`payload/${relative}`))fail('DATABASE_INVALID');
  if(plan.has(relative)){
   const previous=plan.get(relative)!;
   if((sha256&&previous.sha256&&sha256!==previous.sha256)||(bytes!==undefined&&previous.bytes!==undefined&&bytes!==previous.bytes))issues.add(role==='asset'&&previous.role==='asset'?'REGISTERED_MEDIA_MISMATCH':'INCONSISTENT_STAGE_RECEIPT',relative);
   return previous;
  }
  const identity=inspectFile(path.join(source,relative),source,{allowMissing,private:relative.includes('-staging/')});
  if(!identity)return null;
  if(plan.size+2>BACKUP_IO_LIMITS.fileCount||totalBytes+identity.size>BACKUP_IO_LIMITS.totalBytes)fail('LIMIT');
  totalBytes+=identity.size;
  const value: InventoryPlanEntry={relative,role,identity,sha256,bytes};plan.set(relative,value);return value;
 };
 // Bound each JSON record before crossing the SQLite/JS boundary. An oversized
 // row remains intact in the whole database and produces an inspection issue.
 for(const row of db.prepare(`SELECT ${text('id',36)},${text('data',128*1024)},${limited({id:36,data:128*1024})} FROM assets`).iterate()){
  consume();
  if(row.limited){issues.add('RECORD_INSPECTION_LIMIT');continue;}
  const asset=decode(row.data),relative=asset?.relativePath;
  if(!uuid(row.id)||!asset||asset.id!==row.id||typeof relative!=='string'||!relative.startsWith('media/')||!isWorkspaceBackupPayloadPath(`payload/${relative}`)||relative.endsWith('.part.mp4')){issues.add('INVALID_ASSET_RECORD');continue;}
  const direct=new RegExp(`^media/(${uuidSource})\\.[a-z0-9]+$`,'i').exec(relative);
  if(direct&&direct[1]!==row.id){issues.add('INVALID_ASSET_RECORD',relative);continue;}
  const validHash=hash(asset.sha256),validSize=Number.isSafeInteger(asset.sizeBytes)&&asset.sizeBytes>=0;
  if(!validHash||!validSize)issues.add('INVALID_ASSET_RECORD',relative);
  if(!add(relative,'asset',{sha256:validHash?asset.sha256:undefined,bytes:validSize?asset.sizeBytes:undefined}))issues.add('MISSING_REGISTERED_MEDIA',relative);
 }
 if(version===52&&tables.has('agent_task_imports_v2'))for(const row of db.prepare("SELECT id,relativePath,sha256 FROM agent_task_imports_v2 LIMIT 20001").iterate()){
  consume();if(!uuid(row.id)||row.relativePath!==`agent-imports/${String(row.id)}.bin`||!hash(row.sha256)){issues.add('INVALID_TASK_RECORD');continue;}
  if(!add(String(row.relativePath),'agent_import',{sha256:String(row.sha256)}))issues.add('MISSING_REGISTERED_MEDIA',String(row.relativePath));
 }
 if(version===52&&tables.has('agent_task_runs_v2'))for(const row of db.prepare("SELECT status FROM agent_task_runs_v2 LIMIT 20001").iterate()){consume();if(!['completed','failed','stopped','reverted'].includes(String(row.status)))issues.add('UNRESOLVED_TASK_RETAINED');}
 const taskFamilies: [string, Set<string>][]=[['jobs',jobs],['exports',exports]];
 for(const [table,ids] of taskFamilies)if(tables.has(table)){
  for(const row of db.prepare(`SELECT ${text('id',36)},CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB))<=131072 AND json_valid(data) THEN CASE WHEN length(CAST(json_extract(data,'$.status') AS BLOB))<=64 THEN json_extract(data,'$.status') END END AS state,${limited({id:36,data:131072})} FROM ${table}`).iterate()){
   consume();if(row.limited)issues.add('RECORD_INSPECTION_LIMIT');
   if(!uuid(row.id)){issues.add('INVALID_TASK_RECORD');continue;}ids.add(row.id);
   if(typeof row.state!=='string'||!(table==='jobs'?['queued','submitting','submission_unknown','running','downloading','succeeded','failed','cancelled']:['queued','running','succeeded','failed','cancelled']).includes(row.state as string))issues.add('INVALID_TASK_RECORD');
   else if(!['succeeded','failed','cancelled'].includes(row.state as string))issues.add('UNRESOLVED_TASK_RETAINED');
  }
 }
 for(const family of ['image','frame']){
  const table=`${family}_tasks`;if(!tables.has(table))continue;
  const limits=family==='image'?IMAGE_LIMITS:FRAME_LIMITS;
  const columns={id:36,projectId:36,requestId:800,...(family==='image'?{groupId:36}:{}),inputHash:64,input:limits.inputBytes,snapshot:limits.snapshotBytes,stagedReceipt:limits.receiptBytes,state:64};
  const query=`SELECT ${Object.entries(columns).map(([name,max])=>text(name,max)).join(',')},${limited(columns)} FROM ${table}`;
  for(const row of db.prepare(query).iterate()){
   consume();if(row.limited)issues.add('RECORD_INSPECTION_LIMIT');
   if(!uuid(row.id)){issues.add('INVALID_TASK_RECORD');continue;}
   const relative=`${family}-staging/${row.id}`,stage=add(`${relative}.png`,`${family}_stage`),manifest=add(`${relative}.json`,`${family}_stage`);
   if(row.state&&!['succeeded','failed','cancelled_before_dispatch','cancelled_before_start'].includes(row.state as string))issues.add('UNRESOLVED_TASK_RETAINED');
   const snapshot=decode(row.snapshot),input=decode(row.input),saved=decode(row.stagedReceipt);
   const snapshotValid=(family==='image'?imageSnapshotSchema:frameSnapshotSchema).safeParse(snapshot).success;
   const inputValid=(family==='image'?imageSchemas['image.generate']:frameSchemas['frame.extract']).safeParse(input).success;
   const generation=(value: GenerationInput)=>({name:value.name,prompt:value.prompt,providerId:value.providerId,model:value.model,options:value.options,...(value.purpose==='edit'?{purpose:value.purpose,inputImage:value.inputImage}:{})});
   const exactBinding=inputValid&&snapshotValid&&(family==='image'?canonicalImageInput(generation(input))===canonicalImageInput(generation(snapshot))&&(input.groupId===undefined||input.groupId===row.groupId):snapshot.source.assetId===input.sourceAssetId&&snapshot.source.sha256===input.sourceHash&&snapshot.requested.sourceFrame===input.sourceFrame);
   const taskValid=exactBinding&&uuid(row.projectId)&&hash(row.inputHash)&&snapshotValid&&snapshot.taskId===row.id&&snapshot.projectId===row.projectId&&
    (family!=='image'||uuid(row.groupId)&&snapshot.groupId===row.groupId)&&input&&canonicalImageInput(input)===row.input&&digest(row.input as string)===row.inputHash&&input.projectId===row.projectId&&input.requestId===row.requestId&&(family==='image'?IMAGE_STATES:FRAME_STATES).includes(row.state as never);
   if(!taskValid&&!row.limited)issues.add('INVALID_TASK_RECORD');
   const validReceipt=(receipt: unknown): boolean=>{
    const value=receipt as StageReceipt;
    if(!taskValid||!(family==='image'?imageReceiptSchema:frameReceiptSchema).safeParse(value).success||value.taskId!==row.id||value.projectId!==row.projectId||value.inputHash!==row.inputHash)return false;
    if(family==='image'){
     if(value.groupId!==row.groupId||value.isMock!==(snapshot.providerId==='mock')||(snapshot.providerId==='comfy-local'?(value.schemaVersion!==2||value.providerId!=='comfy-local'):(value.schemaVersion!==1)))return false;
     if(snapshot.providerId==='comfy-local'){try{validateComfyReceiptOwnership(db,{...row,snapshot} as never,input as never,value as never);}catch{return false;}}
    }else{
     if(value.sourceAssetId!==snapshot.source.assetId||value.sourceHash!==snapshot.source.sha256||value.sourceFrame!==snapshot.requested.sourceFrame||value.fps!==snapshot.requested.fps||value.probe?.width!==snapshot.source.width||value.probe?.height!==snapshot.source.height)return false;
    }
    return true;
   };
   let disk: unknown=null;
   if(manifest){
    if(manifest.identity.size>limits.receiptBytes)issues.add('RECORD_INSPECTION_LIMIT',`${relative}.json`);
    else{const raw=readPrivateFile(path.join(source,`${relative}.json`),{root:source,maxBytes:limits.receiptBytes,encoding:'utf8'});disk=decode(raw);if(!validReceipt(disk)&&!row.limited)issues.add('INVALID_STAGE_MANIFEST',`${relative}.json`);}
   }
   if(row.stagedReceipt&&!validReceipt(saved)&&!row.limited)issues.add('INVALID_STAGE_MANIFEST',`${relative}.json`);
   if(validReceipt(disk)&&validReceipt(saved)&&canonicalImageInput(disk)!==canonicalImageInput(saved))issues.add('INCONSISTENT_STAGE_RECEIPT',`${relative}.json`);
   if(!manifest&&(stage||row.stagedReceipt))issues.add('MISSING_STAGE_MANIFEST',`${relative}.json`);
   if(stage&&!manifest)issues.add('PARTIAL_RESULT_PRESERVED',`${relative}.png`);
   const receipts=[...new Map([disk,saved].filter(validReceipt).map(receipt=>[canonicalImageInput(receipt),receipt] as [unknown, unknown])).values()];
   if(stage&&receipts.length){const receipt=receipts[0] as StageReceipt;stage.sha256=receipt.sha256;stage.bytes=receipt.byteLength;}
   // Independently inspect both valid receipts. Inconsistent checkpoints remain
   // evidence, never a manufactured recovery authorization.
   for(const rawReceipt of receipts){
    const receipt=rawReceipt as StageReceipt;
    const final=add(`media/${receipt.assetId as string}.png`,'receipt_media',{sha256:receipt.sha256,bytes:receipt.byteLength});
    if(final?.role==='receipt_media')issues.add('UNCOMMITTED_RESULT_PRESERVED',final.relative);
    if(!final&&!stage)issues.add('MISSING_RECEIPT_MEDIA',`media/${receipt.assetId}.png`);
   }
  }
 }
 // Only these three shallow managed directories are scanned. No settings,
 // access token, browser profile, renderer directory or arbitrary tree is read.
 for(const family of ['media','image-staging','frame-staging',...(version===52?['agent-imports']:[])]){
  const directory=path.join(source,family);
  await scanDirectory(directory,source,{signal,check,budget,private:family!=='media',visit:async name=>{
   const relative=`${family}/${name}`,file=path.join(directory,name),info=lstatSync(file);
   if(info.isDirectory()){
    validateManagedDirectory(file,{root:source});issues.add('UNRECOGNIZED_FILE_EXCLUDED',relative);return;
   }
   inspectFile(file,source,{private:family!=='media',maxBytes:Number.MAX_SAFE_INTEGER}); // Even excluded leaves must not be links/special files.
   if(plan.has(relative))return;
   let role: string|undefined;
   if(family==='media'){
    const video=new RegExp(`^result-(${uuidSource})\\.mp4(?:\\.part\\.mp4)?$`,'i').exec(name);
    const exported=new RegExp(`^export-(${uuidSource})-(${uuidSource})\\.mp4(?:\\.part\\.mp4)?$`,'i').exec(name);
    if(video&&jobs.has(video[1]))role='uncommitted_video';
    if(exported&&exports.has(exported[1]))role='uncommitted_export';
   }
   if(role){add(relative,role);issues.add('UNCOMMITTED_RESULT_PRESERVED',relative);}
   else issues.add('UNRECOGNIZED_FILE_EXCLUDED',relative);
  }});
 }
 return {plan:[...plan.values()].sort((a,b)=>a.relative<b.relative?-1:a.relative>b.relative?1:0),databaseSchemaVersion:version,totalBytes};
}

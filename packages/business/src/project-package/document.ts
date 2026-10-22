import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {statSync,createReadStream,renameSync,copyFileSync,unlinkSync,readFileSync,constants} from 'node:fs';
import type {WorkspaceStore} from '../db.ts';
import {createOwnedMediaGraphReader} from '../inspection.ts';
import {createTimelineRecoveryBoundary} from '../timeline-recovery.ts';
import {lutInputHash} from '../lut-resource-validation.ts';
import {PROJECT_PACKAGE_FORMAT,PROJECT_PACKAGE_FORMAT_VERSION,projectPackageMediaPath} from '../../../contracts/src/project-package.ts';
import type {ProjectPackageManifest,ProjectPackageOptions,ProjectPackageCounts,ProjectPackageMediaExtension} from '../../../contracts/src/project-package.ts';
import {projectPackageError} from './container.ts';
import type {ProjectPackageMediaSource} from './container.ts';

type Row=Record<string,any>;
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const OWNED_PROVENANCE=new Set(['generated','synthetic-mock']);
const EXTENSIONS:Record<string,ProjectPackageMediaExtension>={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','video/mp4':'mp4','video/webm':'webm','audio/wav':'wav','audio/mpeg':'mp3','audio/mp4':'m4a'};
const sha256=(value:Uint8Array):string=>createHash('sha256').update(value).digest('hex');
const now=():string=>new Date().toISOString();
const parse=(value:unknown):Row=>typeof value==='string'?JSON.parse(value):value as Row;
const omit=(value:Row,...keys:string[]):Row=>{const copy={...value};for(const key of keys)delete copy[key];return copy;};
const userImportProvenance={kind:'user-import',versionId:null,shotId:null,jobId:null};

/** Format 1 project document. Records keep their saved business fields, minus
 * the owning project, receipts, history and caches; ids are package-local and
 * are always replaced on import. */
export interface ProjectDocument {
 formatVersion:1;
 project:{id:string;name:string;description:string};
 timeline:Row|null;
 assets:(Row&{media:string})[];
 annotations:Row[];dispositions:Row[];ranges:Row[];
 shots:Row[];nodes:Row[];edges:Row[];
 generations:{job:Row;version:Row}[];
 subjects:Row[];subjectVersions:Row[];subjectBindings:Row[];
 luts:(Row&{media:string})[];
}
export interface CollectedProject {
 document:ProjectDocument;
 media:{path:string;bytes:number;sha256:string;source:ProjectPackageMediaSource}[];
 counts:ProjectPackageCounts;
 missing:{assetId:string;name:string;reason:'missing'|'changed'}[];
 warnings:{runningTasks:number};
 totalBytes:number;
}

function relational(db:WorkspaceStore['db'],table:string,projectId:string):Row[]{return db.prepare(`SELECT * FROM ${table} WHERE projectId=? ORDER BY rowid`).all(projectId) as Row[];}

/** Reads one project's saved state in a single transaction. Media are only
 * stat-checked here; their bytes are re-hashed while the package is written. */
export function collectProject(store:WorkspaceStore,projectId:string,options:ProjectPackageOptions):CollectedProject{
 return store.tx(()=>{
  const projectRow=parse(store.get('projects',projectId));
  if(!projectRow)throw projectPackageError('PROJECT_PACKAGE_NOT_FOUND');
  const list=(table:string):Row[]=>store.list(table,projectId).map(parse);
  const assets=list('assets'),shots=list('shots'),nodes=list('nodes'),edges=list('edges'),jobs=list('jobs'),versions=list('versions'),timeline=list('timelines')[0]??null;
  const subjects=relational(store.db,'subjects',projectId),subjectVersions=relational(store.db,'subject_versions',projectId).map(row=>({...row,data:parse(row.data)}) as Row),subjectBindings=relational(store.db,'subject_bindings',projectId);
  const luts=relational(store.db,'project_lut_resources',projectId);
  const jobById=new Map(jobs.map(job=>[job.id,job]));
  const generations=versions.filter(version=>jobById.has(version.jobId)).map(version=>({job:jobById.get(version.jobId)!,version}));
  const versionAssets=new Set(generations.map(item=>item.version.assetId));
  // Assets without a carried owner (image or frame results, orphaned outputs)
  // become plain imports so the target ownership rules still hold.
  const relabel=(asset:Row):Row=>OWNED_PROVENANCE.has(asset.provenance)&&versionAssets.has(asset.id)?asset:{...asset,provenance:'user-import'};
  const linked=JSON.stringify([shots,nodes,edges,generations,subjectVersions,timeline]);
  const candidates=assets.filter(asset=>asset.provenance!=='export'||linked.includes(asset.id));
  const kept=options.media==='used'?candidates.filter(asset=>linked.includes(asset.id)):candidates;
  const keptIds=new Set(kept.map(asset=>asset.id));
  const media=new Map<string,CollectedProject['media'][number]>(),missing:CollectedProject['missing']=[];
  const documentAssets=kept.map(raw=>{
   const asset=relabel(raw),extension=EXTENSIONS[asset.mimeType];
   if(!extension||typeof asset.sha256!=='string'||typeof asset.relativePath!=='string')throw projectPackageError('PROJECT_PACKAGE_INVALID_CONTENT',{assetId:asset.id});
   const file=path.join(store.root,asset.relativePath),entry=projectPackageMediaPath(asset.sha256,extension);
   let size:number|null=null;try{const stat=statSync(file);size=stat.isFile()?stat.size:null;}catch{size=null;}
   if(size===null)missing.push({assetId:asset.id,name:asset.name,reason:'missing'});
   else if(size!==asset.sizeBytes)missing.push({assetId:asset.id,name:asset.name,reason:'changed'});
   else if(!media.has(entry))media.set(entry,{path:entry,bytes:size,sha256:asset.sha256,source:{path:entry,read:signal=>createReadStream(file,{highWaterMark:1024*1024,signal})}});
   return {...omit(asset,'projectId','relativePath','url'),relativePathHint:asset.relativePath,media:entry};
  });
  const documentLuts=luts.map(row=>{
   const content=Buffer.from(row.content as Uint8Array),entry=projectPackageMediaPath(sha256(content),'cube');
   if(!media.has(entry))media.set(entry,{path:entry,bytes:content.length,sha256:sha256(content),source:{path:entry,async *read(){yield content;}}});
   return {...omit(row,'projectId','content'),metadata:parse(row.metadata),media:entry};
  });
  const meta=(table:string):Row[]=>relational(store.db,table,projectId).filter(row=>keptIds.has(row.assetId)).map(row=>omit(row,'projectId'));
  const annotations=meta('asset_annotations').map(row=>({...row,tags:parse(row.tags)}));
  const subjectAssetsKind=new Map(kept.map(asset=>[asset.id,relabel(asset).provenance]));
  const document:ProjectDocument={
   formatVersion:PROJECT_PACKAGE_FORMAT_VERSION,
   project:{id:projectRow.id,name:projectRow.name,description:projectRow.description??''},
   timeline:timeline?omit(timeline,'projectId'):null,
   assets:documentAssets,annotations,dispositions:meta('asset_dispositions'),ranges:meta('asset_ranges'),
   shots:shots.map(row=>omit(row,'projectId')),nodes:nodes.map(row=>omit(row,'projectId')),edges:edges.map(row=>omit(row,'projectId')),
   generations:generations.map(({job,version})=>({job:omit(job,'projectId'),version:omit(version,'projectId')})),
   subjects:subjects.map(row=>omit(row,'projectId')),
   subjectVersions:subjectVersions.map(row=>{
    const data=omit(row.data,'projectId');
    if(subjectAssetsKind.get(row.assetId)==='user-import')data.provenance=userImportProvenance;
    return omit({...row,data},'projectId');
   }),
   subjectBindings:subjectBindings.map(row=>omit(row,'projectId')),
   luts:documentLuts,
  };
  const running=(store.db.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE projectId=? AND json_extract(data,'$.status') NOT IN ('succeeded','failed','cancelled')`).get(projectId) as {count:number}).count;
  const clips=Array.isArray(timeline?.clips)?timeline!.clips.length:0,cues=Array.isArray(timeline?.subtitles?.cues)?timeline!.subtitles.cues.length:0;
  const counts:ProjectPackageCounts={shots:shots.length,assets:kept.length,versions:generations.length,clips,subtitles:cues,subjects:subjects.length,luts:luts.length};
  const entries=[...media.values()];
  return {document,media:entries,counts,missing,warnings:{runningTasks:running},totalBytes:entries.reduce((sum,entry)=>sum+entry.bytes,0)};
 });
}

export function packageDocumentBytes(document:ProjectDocument):Buffer{return Buffer.from(JSON.stringify(document));}
export function buildManifest({collected,document,appVersion,options,name}:{collected:Pick<CollectedProject,'media'|'counts'>;document:Buffer;appVersion:string;options:ProjectPackageOptions;name:string}):ProjectPackageManifest{
 return {format:PROJECT_PACKAGE_FORMAT,formatVersion:PROJECT_PACKAGE_FORMAT_VERSION,appVersion,createdAt:now(),project:{name},counts:collected.counts,options,
  files:[{path:'project.json',bytes:document.length,sha256:sha256(document)},...collected.media.map(entry=>({path:entry.path,bytes:entry.bytes,sha256:entry.sha256}))]};
}

/** Places media and creates the project in one transaction with fresh ids.
 * `files` maps package media paths to readable files; `move` lets an import
 * consume its private staging copies, while a duplicate always copies. */
export interface ProjectPackageReceipt {scope:'project-import'|'project-duplicate';requestId:string;requestHash:string}
/** Returns the project an earlier identical request created, if it still exists. */
export function findProjectPackageReceipt(store:WorkspaceStore,receipt:ProjectPackageReceipt):{projectId:string}|null{
 const row=store.db.prepare('SELECT requestHash,resourceId FROM idempotency WHERE scope=? AND requestId=?').get(receipt.scope,receipt.requestId) as {requestHash:string;resourceId:string}|undefined;
 if(!row)return null;
 if(row.requestHash!==receipt.requestHash)throw Object.assign(new Error('The request id was already used for different content.'),{code:'IDEMPOTENCY_CONFLICT',status:409});
 return store.get('projects',row.resourceId)?{projectId:row.resourceId}:null;
}
export function createProjectFromDocument(store:WorkspaceStore,{document,files,name,move,receipt}:{document:ProjectDocument;files:ReadonlyMap<string,string>;name:string;move:boolean;receipt?:ProjectPackageReceipt}):{projectId:string;jobIds:string[]}{
 const ids=new Map<string,string>(),fresh=(id:string):string=>{const key=id.toLowerCase();let value=ids.get(key);if(!value){value=randomUUID();ids.set(key,value);}return value;};
 // Every UUID-shaped string is an id or embeds one (paths, URLs), so a single
 // textual pass rewrites all references consistently and leaves no old ids.
 const doc=JSON.parse(JSON.stringify(document).replace(UUID,fresh)) as ProjectDocument;
 const projectId=doc.project.id,createdAt=now(),placed:string[]=[];
 const assetPath=(asset:Row):string=>{
  const pattern=/^media\/(result-[0-9a-f-]{36}\.mp4|[0-9a-f-]{36}\.[a-z0-9]{2,5})$/u;
  const original=typeof asset.originalPath==='string'?asset.originalPath:'';
  return pattern.test(original)?original:`media/${asset.id}.${EXTENSIONS[asset.mimeType]}`;
 };
 const place=(source:string,relativePath:string):void=>{
  const target=path.join(store.root,relativePath);
  if(move)renameSync(source,target);else copyFileSync(source,target,constants.COPYFILE_EXCL);
  placed.push(target);
 };
 const sourceFor=(media:string):string=>{const file=files.get(media);if(!file)throw projectPackageError('PROJECT_PACKAGE_INVALID_CONTENT',{media});return file;};
 try{
  const firstUse=new Map<string,string>();
  const assetRows=doc.assets.map(asset=>{
   const relativePath=generatedPath(doc,asset)??assetPath({...asset,originalPath:asset.relativePathHint});
   const source=sourceFor(asset.media),reuse=firstUse.get(asset.media);
   if(reuse){copyFileSync(reuse,path.join(store.root,relativePath),constants.COPYFILE_EXCL);placed.push(path.join(store.root,relativePath));}
   else{place(source,relativePath);firstUse.set(asset.media,path.join(store.root,relativePath));}
   return {...omit(asset,'media','relativePathHint'),projectId,relativePath,url:`/media/${asset.id}`} as Row;
  });
  store.tx(()=>{
   const db=store.db;
   store.put('projects',{id:projectId,name,description:doc.project.description,revision:1,createdAt,updatedAt:createdAt});
   for(const row of assetRows)store.put('assets',row);
   for(const lut of doc.luts){
    const content=readFileSync(sourceFor(lut.media));
    if(sha256(content)!==lut.sha256)throw projectPackageError('PROJECT_PACKAGE_INVALID_CONTENT',{lut:lut.id});
    db.prepare('INSERT INTO project_lut_resources(id,projectId,name,sha256,sizeBytes,profile,metadata,content,createdAt) VALUES(?,?,?,?,?,?,?,?,?)')
     .run(lut.id,projectId,lut.name,lut.sha256,lut.sizeBytes,lut.profile,JSON.stringify(lut.metadata),content,lut.createdAt);
    // Every resource carries an import receipt, as `lut.import` writes; backup
    // restore classifies resources through it.
    const requestId=randomUUID();
    db.prepare('INSERT INTO lut_import_requests(requestId,projectId,inputHash,resourceId) VALUES(?,?,?,?)').run(requestId,projectId,lutInputHash({projectId,requestId,name:lut.name},lut.sha256,content.length),lut.id);
   }
   for(const row of doc.shots)store.put('shots',{...row,projectId});
   for(const row of doc.nodes)store.put('nodes',{...row,projectId});
   for(const row of doc.edges)store.put('edges',{...row,projectId});
   for(const {job,version} of doc.generations){
    const snapshot=stripBinding(job.snapshot);
    store.put('jobs',{...job,projectId,requestId:randomUUID(),snapshot,providerJobId:null,cancelScope:null,retryOfJobId:null,error:null,status:'succeeded',phase:'complete',progress:100,versionId:version.id});
    store.put('versions',{...version,projectId,snapshot:stripBinding(version.snapshot),url:`/media/${version.assetId}`});
   }
   if(doc.timeline)store.put('timelines',{...doc.timeline,projectId});
   for(const row of doc.subjects)db.prepare('INSERT INTO subjects(id,projectId,kind,name,revision,headVersionId,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)').run(row.id,projectId,row.kind,row.name,row.revision,row.headVersionId,row.createdAt,row.updatedAt);
   for(const row of doc.subjectVersions)db.prepare('INSERT INTO subject_versions(id,projectId,subjectId,number,assetId,data) VALUES(?,?,?,?,?,?)').run(row.id,projectId,row.subjectId,row.number,row.assetId,JSON.stringify({...row.data,projectId}));
   for(const row of doc.subjectBindings)db.prepare('INSERT INTO subject_bindings(id,projectId,shotId,subjectId,role,revision,subjectVersionId,reviewedHeadVersionId,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)').run(row.id,projectId,row.shotId,row.subjectId,row.role,row.revision,row.subjectVersionId,row.reviewedHeadVersionId,row.createdAt,row.updatedAt);
   for(const row of doc.annotations)db.prepare('INSERT INTO asset_annotations(assetId,projectId,revision,tags,note) VALUES(?,?,?,?,?)').run(row.assetId,projectId,row.revision,JSON.stringify(row.tags),row.note);
   for(const row of doc.dispositions)db.prepare('INSERT INTO asset_dispositions(assetId,projectId,revision,disposition) VALUES(?,?,?,?)').run(row.assetId,projectId,row.revision,row.disposition);
   for(const row of doc.ranges)db.prepare('INSERT INTO asset_ranges(assetId,projectId,revision,inFrame,outFrame) VALUES(?,?,?,?,?)').run(row.assetId,projectId,row.revision,row.inFrame,row.outFrame);
   // The same ownership gates that guard generation, rendering and deletion.
   const reader=createOwnedMediaGraphReader(db,projectId);
   for(const row of assetRows)reader.asset(row.id);
   for(const {version} of doc.generations)reader.version(version.id);
   if(doc.timeline)createTimelineRecoveryBoundary(db,{projectId}).validate(store.get('timelines',doc.timeline.id) as never);
   for(const row of doc.subjectVersions)reader.subjectVersion(row.id);
   if(receipt)db.prepare('INSERT INTO idempotency(scope,requestId,requestHash,resourceId) VALUES(?,?,?,?)').run(receipt.scope,receipt.requestId,receipt.requestHash,projectId);
   const broken=db.prepare('PRAGMA foreign_key_check').all();
   if(broken.length)throw projectPackageError('PROJECT_PACKAGE_INVALID_CONTENT',{foreignKeys:broken.length});
  });
  return {projectId,jobIds:doc.generations.map(item=>item.job.id)};
 }catch(error){
  for(const file of placed.reverse()){try{unlinkSync(file);}catch{}}
  throw error instanceof Error&&'code' in error&&String((error as {code:unknown}).code).startsWith('PROJECT_PACKAGE_')?error:projectPackageError('PROJECT_PACKAGE_INVALID_CONTENT',{reason:error instanceof Error?error.message.slice(0,200):'unknown'});
 }
}
// Generated media keep the worker's naming so deletion cleanup recognizes them.
function generatedPath(doc:ProjectDocument,asset:Row):string|null{
 const owner=doc.generations.find(item=>item.version.assetId===asset.id);
 return owner&&OWNED_PROVENANCE.has(asset.provenance)?`media/result-${owner.job.id}.mp4`:null;
}
// A video connection binding names a connection of the source workspace.
function stripBinding(snapshot:unknown):unknown{
 if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))return snapshot;
 const {executionBinding:_unused,...rest}=snapshot as Row;return rest;
}

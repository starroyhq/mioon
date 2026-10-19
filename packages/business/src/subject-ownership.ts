import type {DatabaseSync} from 'node:sqlite';
import {AppError,isSubjectVersionResponse,isSubjectReference,SUBJECT_KINDS} from '@mioon/contracts';

interface SubjectOwnerRow {id: string;projectId: string;kind: string;name: string;revision: number;headVersionId: string;createdAt: string;updatedAt: string}
interface SubjectVersionRow {id: string;projectId: string;subjectId: string;number: number;assetId: string;data: string}
interface SubjectManagedAsset {id: string;projectId: string;relativePath?: string;mimeType: string;sha256?: string;width: number;height: number;provenance: string}
interface SubjectProvenance {kind: string;versionId: string|null;shotId: string|null;jobId: string|null;imageSource?: unknown;frameSource?: unknown}
interface SubjectAssetIdentity {assetId: string;sha256: string|undefined;mimeType: string;width: number;height: number;provenance: SubjectProvenance}
interface SubjectVersionRecord {id: string;projectId: string;subjectId: string;number: number;assetId: string;sha256: string;mimeType: string;width: number;height: number;provenance: SubjectProvenance}
interface SubjectReferenceRecord {subjectVersionId: string;subjectName: string;subjectKind: string;subjectVersion: SubjectVersionRecord}
interface SubjectOwnershipOptions {
 resolveAsset: (id: string)=>{asset: SubjectManagedAsset;legacySource?: {id?: string;shotId?: string;jobId?: string}|null;imageSource?: unknown;frameSource?: unknown};
 consume?: (value: string)=>void;
 fail?: ()=>never;
 notFound?: ()=>never;
}

const invalid: ()=>never=()=>{throw new AppError('INVALID_SUBJECT_RECORD','主体或关联状态不一致，请先检查项目',409);};
const missing: ()=>never=()=>{throw new AppError('NOT_FOUND','找不到记录',404);};
const uuid=(value: unknown): value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const equal=(a: unknown,b: unknown): boolean=>JSON.stringify(a)===JSON.stringify(b);
const bounded=(names: string): string=>names.split(',').map(name=>['revision','number'].includes(name)?`CASE WHEN typeof(${name})='integer' AND ${name} BETWEEN 1 AND 9007199254740991 THEN ${name} END AS ${name}`:`CASE WHEN typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${name==='name'?480:name==='data'?4096:64} THEN ${name} END AS ${name}`).join(',');
export const SUBJECT_OWNER_COLUMNS=bounded('id,projectId,kind,name,revision,headVersionId,createdAt,updatedAt');
export const SUBJECT_VERSION_COLUMNS=bounded('id,projectId,subjectId,number,assetId,data');

// Dependency leaf: callers supply their existing owned-media resolver and read
// budget. Never create another graph here or reset the ancestry/budget boundary.
// Primary-key reads bound materialization; reverse media ownership remains the
// caller's responsibility, including typed image/frame and legacy provenance.
export function createSubjectOwnershipReader(db: DatabaseSync,projectId: string,{resolveAsset,consume=()=>{},fail=invalid,notFound=missing}: SubjectOwnershipOptions){
 const owners=new Map<string, SubjectOwnerRow>(),versions=new Map<string, SubjectVersionRecord>(),pending=new Set<string>();
 function owner(id: string): SubjectOwnerRow{
  if(owners.has(id))return owners.get(id)!;
  if(!uuid(id))fail();
  const row=db.prepare(`SELECT ${SUBJECT_OWNER_COLUMNS} FROM subjects WHERE id=? AND projectId=? LIMIT 1`).get(id,projectId) as SubjectOwnerRow|undefined;
  if(!row)return notFound();consume(JSON.stringify(row));
  if(row.id!==id||row.projectId!==projectId||!uuid(row.headVersionId)||!Number.isSafeInteger(row.revision)||row.revision<1||!(SUBJECT_KINDS as readonly string[]).includes(row.kind)||typeof row.name!=='string'||row.name.length<1||row.name.length>120||!row.name.trim()||[row.createdAt,row.updatedAt].some(value=>typeof value!=='string'||value.length<1||value.length>40))fail();
  owners.set(id,row);return row;
 }
 function asset(id: string): SubjectAssetIdentity{
  if(!uuid(id))fail();
  const {asset:value,legacySource:source=null,imageSource,frameSource}=resolveAsset(id);
  if(value.id!==id||value.projectId!==projectId)fail();
  const relative=value.relativePath;
  if(typeof relative!=='string'||relative.length>4096||!relative.startsWith('media/')||relative.includes('\\')||relative.includes('\0')||relative.split('/').some(part=>!part||part==='.'||part==='..'))fail();
  if(!['image/png','image/jpeg','image/webp'].includes(value.mimeType))throw new AppError('SUBJECT_ASSET_UNSUPPORTED','主体版本需要托管 PNG、JPEG 或 WebP 图片',400);
  if(!/^[a-f0-9]{64}$/.test(value.sha256??'')||![value.width,value.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=100000)||!['user-import','generated','synthetic-mock','export','extracted-frame'].includes(value.provenance))fail();
  return {assetId:value.id,sha256:value.sha256,mimeType:value.mimeType,width:value.width,height:value.height,provenance:{kind:value.provenance,versionId:source?.id??null,shotId:source?.shotId??null,jobId:source?.jobId??null,...(imageSource?{imageSource}:{}),...(frameSource?{frameSource}:{})}};
 }
 function version(id: string,subjectId?: string): SubjectVersionRecord{
  if(versions.has(id)){const saved=versions.get(id)!;if(subjectId&&saved.subjectId!==subjectId)notFound();return saved;}
  if(!uuid(id)||pending.has(id))fail();
  const row=db.prepare(`SELECT ${SUBJECT_VERSION_COLUMNS} FROM subject_versions WHERE id=? AND projectId=? LIMIT 1`).get(id,projectId) as SubjectVersionRow|undefined;
  if(!row)return notFound();consume(JSON.stringify(row));
  if(subjectId&&row.subjectId!==subjectId)notFound();
  const subject=owner(row.subjectId);let parsed: unknown=undefined;
  try{parsed=JSON.parse(row.data);}catch{fail();}
  const value=parsed as SubjectVersionRecord;
  if(!isSubjectVersionResponse(value)||value.id!==row.id||value.projectId!==row.projectId||value.subjectId!==row.subjectId||value.number!==row.number||value.assetId!==row.assetId||value.number>subject.revision)fail();
  pending.add(id);
  try{
   const frozen=asset(value.assetId);
   if(!equal(frozen,{assetId:value.assetId,sha256:value.sha256,mimeType:value.mimeType,width:value.width,height:value.height,provenance:value.provenance}))fail();
   versions.set(id,value);return value;
  }finally{pending.delete(id);}
 }
 function reference(id: string): SubjectReferenceRecord{
  const subjectVersion=version(id),subject=owner(subjectVersion.subjectId);
  const result: SubjectReferenceRecord={subjectVersionId:id,subjectName:subject.name,subjectKind:subject.kind,subjectVersion};
  if(!isSubjectReference(result))throw new AppError('UNSUPPORTED_SUBJECT_KIND','本次视频生成只支持角色、产品或场景主体；不支持风格主体',400);
  return result;
 }
 function validateReference(value: unknown): SubjectReferenceRecord{
  const subjectReference=value as SubjectReferenceRecord;
  if(!isSubjectReference(value)||subjectReference.subjectVersion.projectId!==projectId)fail();
  const retained=reference(subjectReference.subjectVersionId);
  if(!equal(value,retained))fail();
  return retained;
 }
 return {owner,version,asset,reference,validateReference};
}

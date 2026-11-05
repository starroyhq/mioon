import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,realpathSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import path from 'node:path';
import {AppError} from '../../contracts/src/app-error.ts';
import {assetMediaPublicSchemas} from '../../contracts/src/asset-media.ts';
import {NATIVE_ASSET_MEDIA_LIMITS,nativeRelinkCandidateInputSchema,nativeRelinkCandidateSchema,nativeRelinkPreviewInputSchema,nativeRelinkPreviewSchema,nativeRelinkApplyInputSchema,nativeRelinkApplyResultSchema,nativeRelinkDiscardInputSchema} from '../../contracts/src/asset-media-native.ts';
import type {NativeAssetMediaPort,NativeAssetMediaRequestOptions,NativeRelinkCandidate,NativeRelinkPreview,NativeRelinkApplyResult,NativeRelinkRow} from '../../contracts/src/asset-media-native.ts';
import {mediaReferenceSchema,isNormalizedAbsolutePath} from '../../contracts/src/media-reference.ts';
import {validatePrivateDirectory,readPrivateFile} from '../../contracts/src/private-storage.ts';
import type {OutsidePathConfirmationStore} from './app-db/stores.ts';
import {isAppLibraryHeld} from './app-db/connection.ts';
import {isProjectFileHeld} from './project-file/held-files.ts';
import {isProjectStore} from './project-file/store.ts';
import type {ProjectStore} from './project-file/store.ts';
import {prepareAccess,inspectTarget} from './media-reference/access.ts';
import {isFileInDirectory} from './media-reference/paths.ts';
import {createAssetMediaServices} from './asset-media-services.ts';
import {createNativeRelinkRetention} from './native-relink-retention.ts';
import type {NativeRelinkRetention} from './native-relink-retention.ts';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function unavailable():never{throw new AppError('ASSET_MEDIA_NATIVE_UNAVAILABLE','素材选择已失效，请重新选择',409);}
function conflict():never{throw new AppError('REVISION_CONFLICT','素材引用已变化，请重新读取',409);}
const identity=(info:BigIntStats)=>[String(info.dev),String(info.ino)];
const stamp=(info:BigIntStats)=>[...identity(info),String(info.size),String(info.mtimeNs),String(info.ctimeNs)];
interface Candidate {
 readonly owner:string;readonly value:NativeRelinkCandidate;readonly file:string;readonly fileStamp:string;
 readonly directory:string;readonly directoryIdentity:string;readonly assetDigest:string;readonly expires:number;
}
interface Preview{readonly candidate:Candidate;readonly value:NativeRelinkPreview;readonly temporaryConsent:boolean;accepted?:boolean}
const retainedStorage=new WeakMap<ProjectStore,NativeRelinkRetention>();
const RECEIPT_MAX_BYTES=NATIVE_ASSET_MEDIA_LIMITS.responseBytes+8*1024;

/** A private runtime capability, not an HTTP/RPC operation catalog. Selection
 * and preview grant only this operation a temporary read of one exact folder.
 * Persistent permission is considered only after explicit final apply. */
export function createNativeAssetMediaServices(store:ProjectStore,{outsidePaths,signal,beforeEffect,now=Date.now}:{outsidePaths:OutsidePathConfirmationStore;signal?:AbortSignal;beforeEffect?:()=>void;now?:()=>number}):NativeAssetMediaPort{
 const candidates=new Map<string,Candidate>(),previews=new Map<string,Preview>(),retired=new Map<string,number>(),locks=new Map<string,Promise<NativeRelinkApplyResult>>();
 let retention=retainedStorage.get(store);
 if(!retention){retention=createNativeRelinkRetention(path.join(store.tempDir,'asset-media','native-relink'));retainedStorage.set(store,retention);}
 const evidence=retention,tokenDirectory=evidence.directory;
 const base=()=>{signal?.throwIfAborted();beforeEffect?.();if(!isProjectStore(store))unavailable();};
 const optionsFor=(owner:string,options:NativeAssetMediaRequestOptions={})=>{
  const requestSignal=signal&&options.signal?AbortSignal.any([signal,options.signal]):options.signal??signal;
  const fence=()=>{requestSignal?.throwIfAborted();base();options.beforeEffect?.();if(retired.has(owner))unavailable();};
  return {signal:requestSignal,beforeEffect:fence};
 };
 const readAsset=(assetId:string,revision:number)=>{
  const row=store.db.prepare("SELECT CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 16384 THEN data END AS data FROM assets WHERE id=? AND projectId=?").get(assetId,store.projectId);
  const value:unknown=row&&typeof row.data==='string'?JSON.parse(row.data):null;
  if(!object(value)||value.id!==assetId||value.projectId!==store.projectId||value.referenceRevision!==revision||!mediaReferenceSchema.safeParse(value.reference).success)conflict();
  return value;
 };
 const checkCandidate=(candidate:Candidate,revision=true)=>{
  if(candidate.expires<=now()||retired.has(candidate.owner))unavailable();
  if(revision&&digest(readAsset(candidate.value.assetId,candidate.value.expectedReferenceRevision))!==candidate.assetDigest)conflict();
  try{
   if(realpathSync(candidate.file)!==candidate.file||realpathSync(candidate.directory)!==candidate.directory)conflict();
   const file=lstatSync(candidate.file,{bigint:true}),directory=lstatSync(candidate.directory,{bigint:true});
   if(!file.isFile()||!directory.isDirectory()||digest(stamp(file))!==candidate.fileStamp||digest(identity(directory))!==candidate.directoryIdentity)conflict();
  }catch(error){if(error instanceof AppError)throw error;conflict();}
 };
 const erasePreview=(token:string)=>{
  const accepted=previews.get(token)?.accepted===true;previews.delete(token);
  // Once final apply has an intent, its preview remains receipt evidence.
  // Retiring a document revokes its in-memory capability, not accepted work.
  if(!accepted)evidence.remove(`${token}.json`);
 };
 const eraseCandidate=(token:string)=>{const candidate=candidates.get(token);candidates.delete(token);for(const [key,preview]of previews)if(preview.candidate===candidate)erasePreview(key);};
 const prune=()=>{
  for(const [token,candidate]of candidates)if(candidate.expires<=now())eraseCandidate(token);
  for(const [owner,until]of retired)if(until<=now())retired.delete(owner);
 };
 const scope=(projectId:string,owner:string)=>{base();if(projectId!==store.projectId||retired.has(owner))unavailable();};
 const media=(owner:string,options:NativeAssetMediaRequestOptions,temporary?:Candidate)=>{
  const checked=optionsFor(owner,options);
  const permissions:OutsidePathConfirmationStore={...outsidePaths,list:projectId=>{
   const actual=outsidePaths.list(projectId);
   if(!temporary||projectId!==store.projectId||actual.some(entry=>entry.directory===temporary.directory))return actual;
   checkCandidate(temporary);
   return [...actual,{projectId,directory:temporary.directory,confirmedAt:new Date(now()).toISOString()}];
  }};
  return createAssetMediaServices(store,{outsidePaths:permissions,...checked,nativeRelinkOwner:owner,nativeRelinkStorage:evidence});
 };
 const bounded=<T>(value:T):T=>{if(Buffer.byteLength(JSON.stringify(value))>NATIVE_ASSET_MEDIA_LIMITS.responseBytes-512)throw new AppError('INSPECTION_BUDGET_EXCEEDED','素材预览超出本次检查预算',409);return value;};
 const confirmed=(candidate:Pick<Candidate,'directory'>)=>outsidePaths.list(store.projectId).some(entry=>entry.directory===candidate.directory)?[candidate.directory]:[];
 const failure=(error:unknown,candidate:Pick<Candidate,'directory'>):NativeRelinkApplyResult=>{
  const safe=error instanceof AppError&&/^[A-Z][A-Z0-9_]{1,99}$/u.test(error.code)?{code:error.code,status:error.status??409}:{code:'ASSET_MEDIA_NATIVE_UNAVAILABLE',status:409};
  return nativeRelinkApplyResultSchema.parse({status:'failed',error:safe,confirmedDirectories:confirmed(candidate)});
 };
 return {
  async candidate(raw,options={}){
   const input=nativeRelinkCandidateInputSchema.parse(raw);base();prune();scope(input.projectId,input.ownerToken);const checked=optionsFor(input.ownerToken,options);checked.beforeEffect();
   if(candidates.size>=NATIVE_ASSET_MEDIA_LIMITS.tickets||retired.size>=NATIVE_ASSET_MEDIA_LIMITS.tickets)unavailable();
   const asset=readAsset(input.assetId,input.expectedReferenceRevision),assetDigest=digest(asset);
   const access=await prepareAccess({projectDir:store.projectDir,projectFile:store.projectFile,mayReadOutside:()=>false,isHeld:id=>isProjectFileHeld(id)||isAppLibraryHeld(id)});checked.beforeEffect();
   const target=await inspectTarget(access,input.sourcePath);checked.beforeEffect();
   if(target.kind!=='media')throw new AppError(target.kind==='missing'?'MEDIA_MISSING':'MEDIA_NOT_MEDIA','候选素材无法读取',409);
   const directory=path.dirname(target.file),parent=lstatSync(directory,{bigint:true});checked.beforeEffect();
   if(!parent.isDirectory()||digest(readAsset(input.assetId,input.expectedReferenceRevision))!==assetDigest)conflict();
   const value=nativeRelinkCandidateSchema.parse({projectId:store.projectId,assetId:input.assetId,expectedReferenceRevision:input.expectedReferenceRevision,candidateToken:randomUUID(),displayPath:target.file,outside:target.outside,confirmationRequired:target.outside&&!outsidePaths.list(store.projectId).some(entry=>isFileInDirectory(entry.directory,target.file))});
   const candidate:Candidate={owner:input.ownerToken,value,file:target.file,fileStamp:digest(stamp(target.stats)),directory,directoryIdentity:digest(identity(parent)),assetDigest,expires:now()+NATIVE_ASSET_MEDIA_LIMITS.ticketMs};
   checkCandidate(candidate);checked.beforeEffect();candidates.set(value.candidateToken,candidate);return value;
  },
  async preview(raw,options={}){
   const input=nativeRelinkPreviewInputSchema.parse(raw);base();prune();scope(input.projectId,input.ownerToken);const candidate=candidates.get(input.candidateToken);
   if(!candidate||candidate.owner!==input.ownerToken)unavailable();const checked=optionsFor(input.ownerToken,options);checked.beforeEffect();checkCandidate(candidate);
   if(previews.size>=NATIVE_ASSET_MEDIA_LIMITS.tickets)unavailable();
   const needsConsent=candidate.value.outside&&!outsidePaths.list(store.projectId).some(entry=>entry.directory===candidate.directory);
   if(needsConsent&&!input.allowOutside)throw new AppError('MEDIA_OUTSIDE_NOT_CONFIRMED','需要明确同意本次读取外部素材',409);
   let token:string|undefined;
   try{
    const result=await media(input.ownerToken,{...checked,beforeEffect:()=>{checked.beforeEffect();checkCandidate(candidate);}},needsConsent?candidate:undefined).nativeRelinkPreview({projectId:store.projectId,assetId:candidate.value.assetId,sourcePath:candidate.file,expectedReferenceRevision:candidate.value.expectedReferenceRevision});
    if(!object(result)||typeof result.previewToken!=='string'||!Array.isArray(result.rows))unavailable();token=result.previewToken;
    checked.beforeEffect();checkCandidate(candidate);
    const rows=result.rows as NativeRelinkRow[],value=bounded(nativeRelinkPreviewSchema.parse({projectId:store.projectId,assetId:candidate.value.assetId,expectedReferenceRevision:candidate.value.expectedReferenceRevision,previewToken:token,displayPath:candidate.file,outside:candidate.value.outside,rows,foundBy:rows.some(row=>row.outcome==='auto')?{name:path.basename(candidate.file),count:rows.filter(row=>row.outcome==='auto').length}:null}));
    checked.beforeEffect();previews.set(token,{candidate,value,temporaryConsent:input.allowOutside});return value;
   }catch(error){if(token)evidence.remove(`${token}.json`);throw error;}
  },
  async apply(raw,options={}){
   const input=nativeRelinkApplyInputSchema.parse(raw);base();prune();scope(input.projectId,input.ownerToken);
   for(;;){const prior=locks.get(input.requestId);if(!prior)break;await prior;}
   if(locks.size>=NATIVE_ASSET_MEDIA_LIMITS.tickets)unavailable();
   const run=(async()=>{
    const checked=optionsFor(input.ownerToken,options),key=digest(input),name=`native-relink-request-${digest(input.requestId)}.json`,file=path.join(tokenDirectory,name);
    let dispatched=false;
    checked.beforeEffect();
    const retained=validatePrivateDirectory(tokenDirectory,{allowMissing:true})?readPrivateFile(file,{root:tokenDirectory,allowMissing:true,encoding:'utf8',maxBytes:RECEIPT_MAX_BYTES}):null;checked.beforeEffect();
    let retainedDirectory:string|undefined;
    if(retained!==null){
     const old:unknown=JSON.parse(String(retained));
     if(!object(old)||old.version!==1||old.digest!==key||old.ownerToken!==input.ownerToken||old.projectId!==input.projectId||old.previewToken!==input.previewToken||old.requestId!==input.requestId||typeof old.directory!=='string'||!isNormalizedAbsolutePath(old.directory)||!['intent','completed'].includes(String(old.phase))||Object.keys(old).some(key=>!['version','digest','phase','projectId','ownerToken','previewToken','requestId','directory','result'].includes(key)))throw new AppError('IDEMPOTENCY_CONFLICT','请求ID已用于不同素材操作',409);
     if(old.phase==='completed')return bounded(nativeRelinkApplyResultSchema.parse(old.result));
     if(Object.hasOwn(old,'result'))unavailable();retainedDirectory=old.directory;
    }
    const preview=previews.get(input.previewToken);
    let candidate:Pick<Candidate,'directory'>;
    if(retainedDirectory!==undefined)candidate={directory:retainedDirectory};
    else{if(!preview||preview.candidate.owner!==input.ownerToken)unavailable();candidate=preview.candidate;}
    const binding={version:1,digest:key,projectId:input.projectId,ownerToken:input.ownerToken,previewToken:input.previewToken,requestId:input.requestId,directory:candidate.directory};
    try{
     const legacyInput={projectId:store.projectId,previewToken:input.previewToken,requestId:input.requestId};
     if(retained===null){
      if(!preview)unavailable();const selected=preview.candidate;checkCandidate(selected);
      // Full S1 reference/revision/content verification precedes ANY grant.
      await media(input.ownerToken,{...checked,beforeEffect:()=>{checked.beforeEffect();checkCandidate(selected);}},selected.value.outside&&preview.temporaryConsent?selected:undefined).validateNativeRelinkApply(legacyInput);
      checked.beforeEffect();checkCandidate(selected);
      const intent=JSON.stringify({...binding,phase:'intent'}),acceptedInput=assetMediaPublicSchemas['asset.media.relink.apply'].parse(legacyInput);
      // Both new intent files must fit before final permission is persisted.
      // Their initial writes are synchronous, before S1's next hash await.
      evidence.admit([{name,bytes:intent},{name:`request-${digest(['asset.media.relink.apply',input.requestId])}.json`,bytes:JSON.stringify({digest:digest(acceptedInput),phase:'intent'})}]);
      evidence.write(name,intent);preview.accepted=true;checked.beforeEffect();checkCandidate(selected);
      if(selected.value.outside&&preview.temporaryConsent&&!confirmed(candidate).length){outsidePaths.confirm({projectId:store.projectId,directory:candidate.directory,confirmedAt:new Date(now()).toISOString()});checked.beforeEffect();}
     }else{
      // Accepted evidence outlives temporary picker TTL. A same-ID query is
      // read-only and must still work when retention cannot admit a new file.
      dispatched=true;
      const proof=media(input.ownerToken,checked).nativeRelinkReceipt(legacyInput);checked.beforeEffect();
      if(proof!==null){if(!object(proof)||!Array.isArray(proof.assets))unavailable();return bounded(nativeRelinkApplyResultSchema.parse({status:'applied',assets:proof.assets,confirmedDirectories:confirmed(candidate)}));}
     }
     // Replays never regrant. If the user revoked after an uncertain apply,
     // S1 either proves its committed receipt or refuses the unavailable file.
     dispatched=true;
     const result=await media(input.ownerToken,checked).call('asset.media.relink.apply',legacyInput);checked.beforeEffect();
     if(!object(result)||!Array.isArray(result.assets))unavailable();
     const value=bounded(nativeRelinkApplyResultSchema.parse({status:'applied',assets:result.assets,confirmedDirectories:confirmed(candidate)}));
     evidence.write(name,JSON.stringify({...binding,phase:'completed',result:value}));checked.beforeEffect();return value;
    }catch(error){
     if(dispatched){
      try{
       // A completed receipt proves the result even if its final ACK fence
       // failed. Read it only while this document still owns the operation.
       base();options.beforeEffect?.();if(retired.has(input.ownerToken))unavailable();
       const completed=readPrivateFile(file,{root:tokenDirectory,allowMissing:true,encoding:'utf8',maxBytes:RECEIPT_MAX_BYTES});
       if(completed!==null){const saved:unknown=JSON.parse(String(completed));if(object(saved)&&saved.version===1&&saved.digest===key&&saved.phase==='completed')return bounded(nativeRelinkApplyResultSchema.parse(saved.result));}
       const receipt=store.db.prepare('SELECT requestHash FROM idempotency WHERE scope=? AND requestId=?').get('asset.media.relink.apply',input.requestId);
       const acceptedInput=assetMediaPublicSchemas['asset.media.relink.apply'].parse({projectId:store.projectId,previewToken:input.previewToken,requestId:input.requestId});
       if(receipt?.requestHash===digest(acceptedInput))return failure(new AppError('ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN','应用结果需要按原请求核对',409),candidate);
      }catch{return failure(new AppError('ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN','应用结果需要按原请求核对',409),candidate);}
     }
     return failure(error,candidate);
    }
   })();
   locks.set(input.requestId,run);try{return await run;}finally{if(locks.get(input.requestId)===run)locks.delete(input.requestId);}
  },
  async discard(raw,options={}){
   const input=nativeRelinkDiscardInputSchema.parse(raw);base();options.signal?.throwIfAborted();options.beforeEffect?.();if(input.projectId!==store.projectId)unavailable();
   if(!input.candidateToken&&!input.previewToken){
    prune();if(!retired.has(input.ownerToken)&&retired.size>=NATIVE_ASSET_MEDIA_LIMITS.tickets)unavailable();
    retired.set(input.ownerToken,now()+NATIVE_ASSET_MEDIA_LIMITS.ticketMs);
    for(const [token,candidate]of candidates)if(candidate.owner===input.ownerToken)eraseCandidate(token);
   }else{
    const candidate=input.candidateToken?candidates.get(input.candidateToken):undefined,preview=input.previewToken?previews.get(input.previewToken):undefined;
    if(candidate?.owner===input.ownerToken)eraseCandidate(input.candidateToken!);
    if(preview?.candidate.owner===input.ownerToken)eraseCandidate(preview.candidate.value.candidateToken);
   }
  },
 };
}

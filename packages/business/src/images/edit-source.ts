import {createHash} from 'node:crypto';
import {AppError} from '@mioon/contracts';
import {readPrivateFile} from '@mioon/contracts/private-storage';
import {canonicalImageInput as canonical, IMAGE_EDIT_LIMITS, imageEditSourceSchema} from '../../../contracts/src/images.ts';
import {createOwnedMediaGraphReader} from '../inspection.ts';
import {validateManagedSource} from '../managed-media.ts';
import {validatePng} from './png.ts';

const fail=()=>{throw new AppError('IMAGE_SOURCE_INVALID','The managed PNG source could not be verified.',409);};
// Resource admission only, shared by resolver/review/service wrappers using the
// same DB handle. This is not durable acceptance or cross-process authority.
export const IMAGE_EDIT_VERIFICATION_LIMITS=Object.freeze({perDatabase:4,perProject:2});
const verifications=new WeakMap();
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export const imageEditFields=snapshot=>snapshot?.purpose==='edit'?{purpose:'edit',inputImage:snapshot.inputImage,sourceImage:snapshot.sourceImage}:{};
// A closed descriptor, never a path, URL, arbitrary provenance object or bytes.
export function describeImageEditSource(asset,imageSource,frameSource){
 let origin;
 if(imageSource&&!frameSource&&['generated','synthetic-mock'].includes(asset.provenance))origin={kind:asset.provenance,imageSource};
 else if(frameSource&&!imageSource&&asset.provenance==='extracted-frame')origin={kind:'extracted-frame',frameSource};
 else if(!imageSource&&!frameSource&&asset.provenance==='user-import')origin={kind:'user-import'};
 else fail();
 const result={assetId:asset.id,sha256:asset.sha256,mimeType:asset.mimeType,byteLength:asset.sizeBytes,width:asset.width,height:asset.height,name:asset.name,origin};
 if(!imageEditSourceSchema.safeParse(result).success)fail();return result;
}

/** Fixed-purpose backend helper. It accepts only a project-scoped edit request,
 * fully validates reverse ownership and retains bytes exclusively in memory. */
export function createImageEditSourceResolver(store,{signal}={}){
 function owned(input,expected){
  if(input?.purpose!=='edit'||!input.inputImage)fail();
  try{
   const graph=createOwnedMediaGraphReader(store.db,input.projectId),asset=graph.asset(input.inputImage.assetId);
   // Legacy generated image/video owners cannot masquerade as an import.
   if(graph.legacySource(asset.id))fail();
   const descriptor=describeImageEditSource(asset,graph.imageSource(asset.id),graph.frameSource(asset.id));
   if(descriptor.assetId!==input.inputImage.assetId||descriptor.sha256!==input.inputImage.sha256||expected&&canonical(descriptor)!==canonical(expected))fail();
   return {asset,descriptor};
  }catch{fail();}
 }
 function bytesFor(asset,descriptor){
  try{
   const source=validateManagedSource(store.root,asset,{maxBytes:IMAGE_EDIT_LIMITS.sourceBytes});
   const bytes=readPrivateFile(source.file,{root:store.root,private:false,maxBytes:IMAGE_EDIT_LIMITS.sourceBytes});
   if(bytes.length!==descriptor.byteLength||digest(bytes)!==descriptor.sha256)fail();
   return bytes;
  }catch{fail();}
 }
 function assertOwned(input,expected){return owned(input,expected).descriptor;}
 function assertCurrent(input,verified){
  const current=owned(input,verified.descriptor),bytes=bytesFor(current.asset,current.descriptor);
  if(!Buffer.isBuffer(verified.bytes)||verified.bytes.length!==bytes.length||digest(verified.bytes)!==current.descriptor.sha256||!bytes.equals(verified.bytes))fail();
  return true;
 }
 async function verify(input,expected){
  if(store.db.isTransaction)throw new TypeError('PNG source verification must run outside SQLite transactions');
  let admission=verifications.get(store.db);if(!admission){admission={count:0,projects:new Map()};verifications.set(store.db,admission);}
  const projectId=input.projectId,count=admission.projects.get(projectId)??0;
  if(admission.count>=IMAGE_EDIT_VERIFICATION_LIMITS.perDatabase||count>=IMAGE_EDIT_VERIFICATION_LIMITS.perProject)throw new AppError('IMAGE_QUEUE_FULL','Too many PNG sources are being verified. Retain this request and try again explicitly.',409);
  admission.count++;admission.projects.set(projectId,count+1);
  try{
   const current=owned(input,expected),bytes=bytesFor(current.asset,current.descriptor);
   try{await validatePng(bytes,{width:current.descriptor.width,height:current.descriptor.height,opaque:true,signal});}catch{fail();}
   const verified={descriptor:structuredClone(current.descriptor),bytes};
   assertCurrent(input,verified);return verified;
  }finally{admission.count--;const remaining=admission.projects.get(projectId)-1;if(remaining)admission.projects.set(projectId,remaining);else admission.projects.delete(projectId);}

 }
 return Object.freeze({verify,assertOwned,assertCurrent});
}

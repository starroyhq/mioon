import {z} from 'zod';
import {projectIdSchema} from './project-file.ts';
import {assetMediaDtoSchema} from './asset-media.ts';
import {isNormalizedAbsolutePath,MEDIA_PATH_MAX_LENGTH} from './media-reference.ts';

export const NATIVE_ASSET_MEDIA_CHANNEL='mioon:asset-media-native:v1';
export const NATIVE_ASSET_MEDIA_LIMITS=Object.freeze({requestBytes:16*1024,responseBytes:256*1024,rows:100,tickets:256,ticketMs:10*60*1000,retainedEntries:1024,retainedBytes:32*1024*1024});
const id=projectIdSchema,revision=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const displayPath=z.string().min(1).max(MEDIA_PATH_MAX_LENGTH).refine(isNormalizedAbsolutePath);
const requestId=z.string().min(8).max(200);
const scope={projectId:id,ownerToken:id};
const asset={projectId:id,assetId:id,expectedReferenceRevision:revision};
export const nativeRelinkCandidateInputSchema=z.object({...scope,assetId:id,expectedReferenceRevision:revision,sourcePath:displayPath}).strict();
export const nativeRelinkCandidateSchema=z.object({...asset,candidateToken:id,displayPath,outside:z.boolean(),confirmationRequired:z.boolean()}).strict().refine(value=>!value.confirmationRequired||value.outside);
export const nativeRelinkPreviewInputSchema=z.object({...scope,candidateToken:id,allowOutside:z.boolean()}).strict();
export const nativeRelinkRowSchema=z.object({assetId:id,name:z.string().min(1).max(200),from:z.string().min(1).max(MEDIA_PATH_MAX_LENGTH),to:displayPath.nullable(),outcome:z.enum(['picked','auto','changed','missing']),referenceRevision:revision}).strict();
export const nativeRelinkPreviewSchema=z.object({...asset,previewToken:id,displayPath,outside:z.boolean(),rows:z.array(nativeRelinkRowSchema).min(1).max(NATIVE_ASSET_MEDIA_LIMITS.rows),foundBy:z.object({name:z.string().min(1).max(200),count:z.number().int().nonnegative().max(NATIVE_ASSET_MEDIA_LIMITS.rows)}).strict().nullable()}).strict().superRefine((value,context)=>{
 const chosen=value.rows.find(row=>row.assetId===value.assetId),automatic=value.rows.filter(row=>row.outcome==='auto').length;
 if(!chosen||chosen.referenceRevision!==value.expectedReferenceRevision||new Set(value.rows.map(row=>row.assetId)).size!==value.rows.length||
  value.rows.some(row=>row.outcome==='picked'&&(row.assetId!==value.assetId||row.to!==value.displayPath)||row.outcome==='auto'&&(row.assetId===value.assetId||row.to===null)||row.outcome==='missing'&&row.to!==null)||
  (automatic>0?value.foundBy?.count!==automatic:value.foundBy!==null)||new TextEncoder().encode(JSON.stringify(value)).byteLength>NATIVE_ASSET_MEDIA_LIMITS.responseBytes-512)context.addIssue({code:'custom',message:'Relink rows must retain their exact candidate, revision and bounded display projection.'});
});
export const nativeRelinkApplyInputSchema=z.object({...scope,previewToken:id,requestId}).strict();
const confirmedDirectories=z.array(displayPath).max(NATIVE_ASSET_MEDIA_LIMITS.rows);
export const nativeAssetMediaErrorSchema=z.object({code:z.string().regex(/^[A-Z][A-Z0-9_]{1,99}$/u),status:z.number().int().min(400).max(599)}).strict();
export const nativeRelinkApplyResultSchema=z.discriminatedUnion('status',[
 z.object({status:z.literal('applied'),assets:z.array(assetMediaDtoSchema).min(1).max(NATIVE_ASSET_MEDIA_LIMITS.rows),confirmedDirectories}).strict(),
 z.object({status:z.literal('failed'),error:nativeAssetMediaErrorSchema,confirmedDirectories}).strict(),
]);
export const nativeRelinkDiscardInputSchema=z.object({...scope,candidateToken:id.optional(),previewToken:id.optional()}).strict();
/** Renderer inputs cannot mint a path, consent, owner token or project scope. */
export const nativeAssetMediaRequestSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('choose'),...asset}).strict(),
 z.object({action:z.literal('apply'),projectId:id,previewToken:id,requestId}).strict(),
 z.object({action:z.literal('discard'),projectId:id,previewToken:id}).strict(),
]);
export type NativeRelinkCandidateInput=z.infer<typeof nativeRelinkCandidateInputSchema>;
export type NativeRelinkCandidate=z.infer<typeof nativeRelinkCandidateSchema>;
export type NativeRelinkPreviewInput=z.infer<typeof nativeRelinkPreviewInputSchema>;
export type NativeRelinkPreview=z.infer<typeof nativeRelinkPreviewSchema>;
export type NativeRelinkRow=z.infer<typeof nativeRelinkRowSchema>;
export type NativeRelinkApplyInput=z.infer<typeof nativeRelinkApplyInputSchema>;
export type NativeRelinkApplyResult=z.infer<typeof nativeRelinkApplyResultSchema>;
export type NativeRelinkDiscardInput=z.infer<typeof nativeRelinkDiscardInputSchema>;
export type NativeAssetMediaRequest=z.infer<typeof nativeAssetMediaRequestSchema>;
export interface NativeAssetMediaRequestOptions{readonly signal?:AbortSignal;readonly beforeEffect?:()=>void}
export interface NativeAssetMediaPort{
 candidate(input:NativeRelinkCandidateInput,options?:NativeAssetMediaRequestOptions):Promise<NativeRelinkCandidate>;
 preview(input:NativeRelinkPreviewInput,options?:NativeAssetMediaRequestOptions):Promise<NativeRelinkPreview>;
 apply(input:NativeRelinkApplyInput,options?:NativeAssetMediaRequestOptions):Promise<NativeRelinkApplyResult>;
 discard(input:NativeRelinkDiscardInput,options?:NativeAssetMediaRequestOptions):Promise<void>;
}

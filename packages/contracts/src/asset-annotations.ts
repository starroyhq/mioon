import {z} from 'zod';

export const ASSET_ANNOTATION_LIMITS=Object.freeze({batch:100,tags:20,tagCodePoints:40,tagBytes:160,noteCodePoints:4000,noteBytes:16384,commandBytes:24576});
const bytes=(value:string)=>new TextEncoder().encode(value).length;
const wellFormed=(value:string)=>!/[\uD800-\uDFFF]/u.test(value);
const plainTag=(value:string)=>wellFormed(value)&&![...value].some(c=>/[\p{Cc}]/u.test(c))&&value===value.trim().normalize('NFC');
const tag=z.string().min(1).refine(value=>[...value].length<=40&&bytes(value)<=160&&plainTag(value),'Tags must be trimmed NFC plain text, at most 40 code points and 160 UTF-8 bytes.');
const tags=z.array(tag).max(20).refine(value=>new Set(value).size===value.length,'Tags must be unique (case-sensitive).');
const note=z.string().refine(value=>wellFormed(value)&&[...value].length<=4000&&bytes(value)<=16384&&!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(value),'Notes must be bounded plain text; only tab and newline controls are allowed.');
const id=z.string().uuid(), revision=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const item=z.object({id,assetId:id,projectId:id,revision,tags,note}).strict().refine(value=>value.id===value.assetId&&(value.revision!==0||value.tags.length===0&&value.note===''));
export const assetAnnotationSchemas=Object.freeze({
 'asset.annotation.list':z.object({projectId:id,assetIds:z.array(id).min(1).max(100).refine(value=>new Set(value).size===value.length)}).strict(),
 'asset.annotation.set':z.object({projectId:id,assetId:id,expectedRevision:revision,requestId:z.string().min(8).max(200),tags,note}).strict().refine(value=>bytes(JSON.stringify(value))<=24576,'Annotation command exceeds 24 KiB.'),
});
export type AssetAnnotation=z.infer<typeof item>;
export type AssetAnnotationSetInput=z.infer<typeof assetAnnotationSchemas['asset.annotation.set']>;
export function isAssetAnnotationResponse(value:unknown):value is AssetAnnotation{return item.safeParse(value).success;}
export function isAssetAnnotationListResponse(value:unknown,input?:unknown):value is {projectId:string;items:AssetAnnotation[]}{
 const parsed=z.object({projectId:id,items:z.array(item).min(1).max(100)}).strict().safeParse(value);
 if(!parsed.success)return false;
 const result=parsed.data;
 if(new Set(result.items.map(item=>item.assetId)).size!==result.items.length||result.items.some(item=>item.projectId!==result.projectId))return false;
 if(input===undefined)return true;
 const request=assetAnnotationSchemas['asset.annotation.list'].safeParse(input);
 return request.success&&request.data.projectId===result.projectId&&request.data.assetIds.length===result.items.length&&request.data.assetIds.every((id,index)=>id===result.items[index]?.assetId);
}

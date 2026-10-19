import {z} from 'zod';

export const ASSET_DISPOSITIONS = Object.freeze(['neutral','favorite','rejected']);
export const ASSET_DISPOSITION_BATCH_LIMIT = 100;
const id = z.string().uuid();
const revision = z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER);
const assetIds = z.array(id).min(1).max(ASSET_DISPOSITION_BATCH_LIMIT)
  .refine(ids=>new Set(ids).size===ids.length,{message:'Asset IDs must be unique.'});
export const assetDispositionSchemas = Object.freeze({
  'asset.disposition.list':z.object({projectId:id,assetIds:assetIds.describe('Explicit ordered batch of 1–100 unique existing asset IDs. All assets must belong to the project; missing or foreign assets fail the entire batch. No rows are created.')}).strict(),
  'asset.disposition.set':z.object({
    projectId:id,assetId:id,
    expectedRevision:revision.describe('Independent disposition revision. A successful list confirms revision 0 and neutral when no disposition has been saved.'),
    requestId:z.string().min(8).max(200).describe('Required stable replay key (8–200 characters). Exact retries return the immutable original response, even after later edits or restart. Changed operation, project or input conflicts.'),
    disposition:z.enum(ASSET_DISPOSITIONS).describe('Shared metadata only. Neutral resets the label while retaining its revision history; rejected never deletes or hides an asset from the backend.'),
  }).strict(),
});

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value,keys) => object(value) && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
const validId = value => typeof value==='string' && id.safeParse(value).success;
export function isAssetDispositionResponse(value) {
  return exactKeys(value,['id','assetId','projectId','revision','disposition']) &&
    validId(value.assetId) && value.id===value.assetId && validId(value.projectId) &&
    Number.isSafeInteger(value.revision) && value.revision>=0 && ASSET_DISPOSITIONS.includes(value.disposition) &&
    (value.revision!==0 || value.disposition==='neutral');
}

// Bind successful batch reads to the exact request, including order. Callers
// must not treat an omitted item or a failed read as a confirmed neutral value.
export function isAssetDispositionListResponse(value,input) {
  if (!exactKeys(value,['projectId','items']) || !validId(value.projectId) || !Array.isArray(value.items) ||
      value.items.length<1 || value.items.length>ASSET_DISPOSITION_BATCH_LIMIT ||
      !value.items.every(item=>isAssetDispositionResponse(item) && item.projectId===value.projectId) ||
      new Set(value.items.map(item=>item.assetId)).size!==value.items.length) return false;
  return !input || (assetDispositionSchemas['asset.disposition.list'].safeParse(input).success &&
    value.projectId===input.projectId && value.items.length===input.assetIds.length &&
    value.items.every((item,index)=>item.assetId===input.assetIds[index]));
}

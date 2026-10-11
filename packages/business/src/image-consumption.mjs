import {AppError} from '@mioon/contracts';
import {createOwnedMediaGraphReader} from './inspection.mjs';

// Preserve legacy-only asset semantics while extending every typed image-consumption
// seam. Detection deliberately ignores provenance and project: a foreign image/frame
// reverse owner must not disappear behind an imported/legacy label.
export function validateImageConsumption(db,asset,projectId){
 const imageTable=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_versions'").get());
 const frameTable=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='frame_tasks'").get());
 if(!imageTable&&db.prepare('SELECT 1 FROM schema_version WHERE version=16').get()||!frameTable&&db.prepare('SELECT 1 FROM schema_version WHERE version=20').get())throw invalid();
 const imageOwned=imageTable&&db.prepare('SELECT 1 FROM image_versions WHERE assetId=? LIMIT 1').get(asset.id);
 const frameOwned=frameTable&&db.prepare("SELECT 1 FROM frame_tasks WHERE assetId=? OR CASE WHEN json_valid(stagedReceipt) THEN json_extract(stagedReceipt,'$.assetId') END=? LIMIT 1").get(asset.id,asset.id);
 if(!imageOwned&&!frameOwned&&asset.provenance!=='extracted-frame')return asset;
 try{createOwnedMediaGraphReader(db,projectId).asset(asset.id);}
 catch{throw invalid();}
 return asset;
}
const invalid=()=>new AppError('IMAGE_SOURCE_INVALID','此图像来源无法安全核验，请检查当前项目的原始图像记录。',409);

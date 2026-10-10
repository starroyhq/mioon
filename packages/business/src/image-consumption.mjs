import {AppError} from '@mioon/contracts';
import {createOwnedMediaGraphReader} from './inspection.mjs';

// Preserve legacy-only asset semantics while extending every image-consumption
// seam. Detection deliberately ignores provenance and project: a foreign image
// reverse owner must not disappear behind an imported/legacy label.
export function validateImageConsumption(db,asset,projectId){
 const table=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_versions'").get();
 if(!table){if(db.prepare('SELECT 1 FROM schema_version WHERE version=16').get())throw invalid();return asset;}
 if(!db.prepare('SELECT 1 FROM image_versions WHERE assetId=? LIMIT 1').get(asset.id))return asset;
 try{createOwnedMediaGraphReader(db,projectId).asset(asset.id);}
 catch{throw invalid();}
 return asset;
}
const invalid=()=>new AppError('IMAGE_SOURCE_INVALID','此图像来源无法安全核验，请检查当前项目的原始图像记录。',409);

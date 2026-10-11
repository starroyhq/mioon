import {deepFreeze} from './generation-input-profiles.mjs';
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&!Object.getOwnPropertySymbols(value).length&&Object.values(Object.getOwnPropertyDescriptors(value)).every(d=>!d.get&&!d.set&&d.enumerable);
const dense=value=>{
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>8)return false;
 const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
 return keys.length===value.length+1&&keys.every(key=>key==='length'||typeof key==='string'&&/^(0|[1-9]\d*)$/.test(key)&&Number(key)<value.length&&!descriptors[key].get&&!descriptors[key].set&&descriptors[key].enumerable);
};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
/**
 * A new shot selection only: its historical referenceAssetIds remain first-frame
 * inputs. Never call this on a frozen job, whose manifest is already complete.
 * This does not look up ownership, read bytes, or discard unresolved identities.
 */
export function getShotGenerationReferenceSelection(shot){
 const issues=[],add=(code,path,message)=>issues.push({code,path,message});
 const finish=references=>deepFreeze({ok:issues.length===0,references,issues});
 if(!record(shot)){add('INVALID_INPUT',[],'镜头输入必须为普通数据对象');return finish([]);}
 const ids=shot.referenceAssetIds===undefined?[]:shot.referenceAssetIds;
 if(!dense(ids)||ids.some(id=>typeof id!=='string'||!id.trim()||id.length>200)){add('INVALID_REFERENCES',['referenceAssetIds'],'参考素材 ID 必须为完整且有界的数组');return finish([]);}
 const references=ids.map(assetId=>({role:'first_frame',assetId}));
 if(!Object.hasOwn(shot,'lastFrameAssetId')||shot.lastFrameAssetId===null)return finish(references);
 if(!uuid(shot.lastFrameAssetId)){add('INVALID_LAST_FRAME',['lastFrameAssetId'],'尾帧素材必须为有效的素材 ID 或 null');return finish(references);}
 if(ids.length!==1)add('UNSUPPORTED_ROLE_COMBINATION',['lastFrameAssetId'],'尾帧必须与一张首帧一起使用');
 if(ids.includes(shot.lastFrameAssetId))add('DUPLICATE_REFERENCE',['lastFrameAssetId'],'首尾帧必须选择不同素材，这是当前应用限制');
 return finish([...references,{role:'last_frame',assetId:shot.lastFrameAssetId}]);
}

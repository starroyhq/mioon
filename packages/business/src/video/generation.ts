import {AppError} from '../../../contracts/src/app-error.ts';
import {parseVideoBinding,videoConnectionEndpoint,validateVideoSnapshot,videoBindingCapabilities,videoInputProfile} from '../../../contracts/src/video-providers.ts';
import type {VideoExecutionBinding,VideoConnectionDescriptor} from '../../../contracts/src/video-providers.ts';
import type {VideoSettingsService} from './settings.ts';
import type {GenerationSource,GenerationAsset,PreparedGenerationInputs} from '../generation-inputs.ts';
import {generationReferenceSelection} from '../generation-inputs.ts';
import {wanVideoInputSchema} from '../../../contracts/src/wan-video.ts';

export function listVideoConnections(settings:VideoSettingsService|undefined,asOf:string):VideoConnectionDescriptor[]{
 return (settings?.list()??[]).map(view=>{
  const c=view.configuration;
  return {connectionId:c.id,configurationRevision:view.revision,providerId:c.providerId,name:c.name,region:c.region,enabled:c.enabled,archived:c.archived,configured:view.secret.configured,
   models:c.models.map(model=>{
    const binding:VideoExecutionBinding={version:1,connectionId:c.id,configurationRevision:view.revision,providerId:c.providerId,region:c.region,workspaceId:c.workspaceId,endpoint:videoConnectionEndpoint(c),credentialRef:view.credentialRef??'00000000-0000-4000-8000-000000000000',model,outputHosts:c.outputHosts};
    return {entry:model,capabilities:videoBindingCapabilities(binding,{configured:view.secret.configured,enabled:c.enabled&&!c.archived&&model.enabled&&!model.archived,asOf})};
   })};
 });
}
export function readVideoBinding(snapshot:unknown):VideoExecutionBinding|null{
 if(snapshot!==null&&typeof snapshot==='object'&&Object.hasOwn(snapshot,'executionBinding'))return parseVideoBinding((snapshot as {executionBinding:unknown}).executionBinding);
 return null;
}
/** The remote-task namespace is frozen independently of a display name or current default connection. */
export function sameVideoExecutionDomain(left:unknown,right:unknown):boolean{
 const a=readVideoBinding(left),b=readVideoBinding(right);
 return a&&b?a.providerId===b.providerId&&a.endpoint===b.endpoint&&a.connectionId===b.connectionId&&a.credentialRef===b.credentialRef:!a&&!b;
}
export function prepareConfiguredVideoInputs({source,binding,projectId,readAsset,frozen=false,asOf}:{source:GenerationSource;binding:VideoExecutionBinding;projectId:string;readAsset:(id:string)=>GenerationAsset;frozen?:boolean;asOf:string}):PreparedGenerationInputs{
 const fail=(code:string,message:string):never=>{throw new AppError(code,message,400);};
 // Wan 3.0 and Seedance 2.5 share the explicit input; messages name the provider in use.
 const label=binding.providerId==='ark'?'Seedance':'Wan';
 const explicit=source.videoInput===undefined?null:wanVideoInputSchema.safeParse(source.videoInput);
 if(explicit&&!explicit.success)fail('INVALID_REFERENCE_MANIFEST',`${label} 图片输入清单无效。`);
 const videoInput=explicit?.success?explicit.data:null;
 const {ids,references}=videoInput?{ids:videoInput.images.map(image=>image.assetId),references:videoInput.images}:generationReferenceSelection(source,{frozen}),profile=videoInputProfile(binding);
 if(videoInput&&source.subjectReference!==undefined)fail('UNSUPPORTED_INPUT_ROLE',`${label} 图片输入不能与主体参考混用。`);
 if(frozen&&videoInput&&(JSON.stringify(source.referenceAssetIds)!==JSON.stringify(ids)||!Array.isArray(source.referenceConnections)||source.referenceConnections.length||source.lastFrameAssetId!=null||videoInput.prompt!==undefined&&source.prompt!==videoInput.prompt))fail('INVALID_REFERENCE_MANIFEST',`${label} 冻结输入的重复字段不一致，不能自动修复。`);
 if(frozen&&(source.inputProfileId!==profile.profileId||source.inputProfileVersion!==profile.profileVersion||source.providerRegion!==binding.region))fail('VIDEO_BINDING_INVALID','任务输入配置与冻结连接不一致。');
 const saved=source.referenceAssets;
 if(frozen&&(!Array.isArray(saved)||saved.length!==ids.length))fail('INVALID_REFERENCE_MANIFEST','冻结素材清单不完整。');
 const bindings=source.referenceBindings;
 if(frozen&&(!Array.isArray(bindings)||bindings.length!==ids.length))fail('INVALID_REFERENCE_MANIFEST','冻结素材角色不完整。');
 const assets=ids.map((id,index)=>{
  const asset=readAsset(id);if(asset.id!==id||asset.projectId!==projectId)fail('INVALID_REFERENCE_OWNERSHIP','参考素材必须属于当前项目。');
  const previous=frozen?(saved as Record<string,unknown>[])[index]:null,bound=frozen?(bindings as Record<string,unknown>[])[index]:null;
  if(frozen&&(!previous||!bound||previous.id!==id||bound.assetId!==id||bound.sha256!==asset.sha256||bound.role!==previous.role||videoInput&&bound.role!==videoInput.images[index]?.role||Object.keys(bound).some(key=>!['role','assetId','sha256'].includes(key))||['mimeType','sha256','relativePath','width','height','sizeBytes'].some(key=>previous[key]!==asset[key])))fail('REFERENCE_CHANGED','参考素材与冻结任务不一致。');
  return {...asset,role:frozen?String(bound!.role):references?.[index]?.role??'first_frame'};
 });
 const referenceBindings=assets.map(asset=>({role:asset.role,assetId:asset.id,sha256:asset.sha256}));
 const connections=source.referenceConnections??[];
 if(videoInput&&(!Array.isArray(connections)||connections.length))fail('REFERENCE_STATE_CONFLICT',`本次 ${label} 图片输入不能合并镜头参考连线。`);
 if(!Array.isArray(connections)||connections.length>1||connections.some(connection=>!connection||typeof connection!=='object'||connection.role!=='first_frame'||connection.sourceAssetId!==ids[0]||referenceBindings[0]?.role!=='first_frame'))fail('REFERENCE_STATE_CONFLICT','参考连线与冻结图片不一致。');
 const explicitFields=videoInput?{videoInput,prompt:videoInput.prompt??source.prompt,referenceConnections:[],lastFrameAssetId:null}:{};
 const candidate={...source,...explicitFields,providerId:binding.providerId,model:binding.model.modelId,referenceAssetIds:ids,referenceAssets:assets,referenceBindings};
 validateVideoSnapshot(binding,candidate,{asOf});
 return {assets,plan:null,fields:{...explicitFields,executionBinding:binding,inputProfileVersion:profile.profileVersion,inputProfileId:profile.profileId,providerRegion:binding.region,referenceBindings}};
}

import {z} from 'zod';
const id=z.string().uuid(), key=z.string().min(8).max(200), position=z.object({x:z.number().finite(),y:z.number().finite()}).strict();
const params=z.object({scenario:z.enum(['success','failure','delay','timeout','unknown','reject','download_fail_once','rejected_before_accept','accepted_then_response_lost','poll_timeout_then_recover','terminal_failure']).optional(),delayMs:z.number().int().min(0).max(120000).optional(),seed:z.number().int().optional()}).strict();
const shotFields={title:z.string().min(1).max(150),prompt:z.string().max(5000),referenceAssetIds:z.array(id).max(8),aspectRatio:z.enum(['9:16','16:9','1:1','3:4','4:3','21:9']),duration:z.number().int().min(1).max(20),parameters:params,position};
const frame=z.number().int().min(0).max(18000), durationFrames=z.number().int().min(1).max(18000);
const sourceFrame=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-18000);
const even=(minimum,maximum)=>z.number().int().min(minimum).max(maximum).multipleOf(2);
const rect=z.object({x:even(0,718),y:even(0,1278),width:even(2,720),height:even(2,1280)}).strict().refine(r=>r.x+r.width<=720&&r.y+r.height<=1280,{message:'Rectangle must stay inside the 720×1280 output'});
const timelineMutation={projectId:id,expectedRevision:z.number().int().positive(),requestId:key};
const clipFields={trackId:id,name:z.string().min(1).max(200),startFrame:frame,durationFrames,sourceInFrame:sourceFrame,rect,gain:z.number().finite().min(0).max(2)};
export const schemas={
'project.create':z.object({name:z.string().min(1).max(150),description:z.string().max(2000).optional()}).strict(),
'project.list':z.object({}).strict(),
'project.get':z.object({projectId:id}).strict(),
'asset.import':z.object({projectId:id,name:z.string().min(1).max(200),mimeType:z.enum(['image/png','image/jpeg','image/webp','video/mp4','video/webm','audio/wav','audio/mpeg','audio/mp4']),dataBase64:z.string().max(40*1024*1024)}).strict(),
'asset.list':z.object({projectId:id}).strict(),
'shot.create':z.object({projectId:id,...Object.fromEntries(Object.entries(shotFields).map(([k,v])=>[k,k==='title'?v:v.optional()]))}).strict(),
'shot.update':z.object({shotId:id,expectedRevision:z.number().int().positive(),patch:z.object(Object.fromEntries(Object.entries(shotFields).map(([k,v])=>[k,v.optional()]))).strict().refine(v=>Object.keys(v).length>0)}).strict(),
'shot.reorder':z.object({projectId:id,expectedRevision:z.number().int().positive(),shotIds:z.array(id)}).strict(),
'node.create':z.object({projectId:id,type:z.enum(['text','image','video','audio']),label:z.string().max(150).optional(),text:z.string().max(5000).optional(),assetId:id.optional(),position}).strict(),
'node.update':z.object({nodeId:id,expectedRevision:z.number().int().positive(),patch:z.object({label:z.string().max(150).optional(),text:z.string().max(5000).optional(),position:position.optional()}).strict()}).strict(),
'edge.create':z.object({projectId:id,source:id,target:id}).strict(),
'edge.delete':z.object({edgeId:id}).strict(),
'reference.attach':z.object({projectId:id,sourceNodeId:id,targetShotId:id,expectedSourceRevision:z.number().int().positive(),expectedShotRevision:z.number().int().positive(),requestId:key,role:z.literal('first_frame')}).strict(),
'reference.detach':z.object({projectId:id,edgeId:id,expectedShotRevision:z.number().int().positive(),requestId:key}).strict(),
'provider.list':z.object({}).strict(),
'generation.submit':z.object({shotId:id,expectedRevision:z.number().int().positive(),requestId:key,providerId:z.enum(['mock','runway','ark','veo','minimax','vidu']),model:z.string().max(100).optional(),parameters:params.optional()}).strict(),
'job.get':z.object({jobId:id}).strict(),
'job.list':z.object({projectId:id}).strict(),
'job.retry':z.object({jobId:id,requestId:key}).strict(),
'job.cancel':z.object({jobId:id}).strict(),
'job.reconcile':z.object({jobId:id,providerJobId:z.string().max(200).optional()}).strict(),
'version.list':z.object({shotId:id}).strict(),
'version.select':z.object({shotId:id,versionId:id,expectedRevision:z.number().int().positive()}).strict(),
'export.create':z.object({projectId:id,requestId:key}).strict(),
'export.get':z.object({exportId:id}).strict(),
'timeline.get':z.object({projectId:id}).strict(),
'timeline.history.get':z.object({projectId:id}).strict(),
'timeline.undo':z.object(timelineMutation).strict(),
'timeline.redo':z.object(timelineMutation).strict(),
'timeline.track.add':z.object({...timelineMutation,kind:z.enum(['video','audio']),name:z.string().min(1).max(150).optional()}).strict(),
'timeline.track.update':z.object({...timelineMutation,trackId:id,patch:z.object({name:z.string().min(1).max(150).optional(),hidden:z.boolean().optional(),muted:z.boolean().optional()}).strict().refine(p=>Object.keys(p).length>0)}).strict(),
'timeline.clip.add':z.object({...timelineMutation,assetId:id,...clipFields,name:clipFields.name.optional(),sourceInFrame:sourceFrame.optional(),rect:rect.optional(),gain:clipFields.gain.optional()}).strict(),
'timeline.clip.update':z.object({...timelineMutation,clipId:id,patch:z.object(Object.fromEntries(Object.entries(clipFields).map(([k,v])=>[k,v.optional()]))).strict().refine(p=>Object.keys(p).length>0)}).strict(),
'timeline.clip.remove':z.object({...timelineMutation,clipId:id}).strict(),
'timeline.clip.split':z.object({...timelineMutation,clipId:id,atFrame:frame}).strict(),
'timeline.seed':z.object(timelineMutation).strict(),
'timeline.render':z.object({...timelineMutation,purpose:z.enum(['preview','export'])}).strict()
};
export const descriptions={
'project.create':'创建持久化视频项目','project.list':'列出项目','project.get':'读取完整项目、画布和任务','asset.import':'导入授权的本地图片或视频字节（base64，最大30MiB）','asset.list':'读取项目素材','shot.create':'创建稳定ID镜头','shot.update':'按版本更新镜头，旧版本返回冲突','shot.reorder':'按项目版本原子调整镜头顺序','node.create':'创建文本、图片或视频画布节点','node.update':'按版本更新节点','edge.create':'连接同一项目节点','edge.delete':'移除连线','provider.list':'查询供应商能力与配置状态','generation.submit':'用稳定requestId提交生成（默认仅模拟）','job.get':'读取任务和可恢复错误','job.list':'读取项目任务','job.retry':'显式重试已明确失败任务，必须用新requestId','job.cancel':'停止本地等待，不声称已取消供应商任务','job.reconcile':'重新查询或对账已有任务，不重新提交','version.list':'列出不可变生成版本','version.select':'按镜头版本选择结果','export.create':'冻结已选版本并按镜头顺序导出真实9:16 MP4','export.get':'查询导出进度和文件'};
Object.assign(descriptions,{
 'edge.create':'创建同项目的视觉连线；不参与生成，也不传递提示词或素材',
 'edge.delete':'仅移除视觉连线；首帧参考连线须使用 reference_detach',
 'reference.attach':'原子连接同项目的托管图片节点与镜头作为首帧；须校验两端版本且镜头无手选参考图，使用稳定requestId',
 'reference.detach':'按镜头版本原子断开首帧参考连线并清除其专属参考选择；保留原素材、节点及历史任务快照，使用稳定requestId',
 'asset.import':'导入授权的本地图片、视频或音频字节（base64，最大30MiB）',
 'node.create':'创建文本、图片、视频或音频画布节点',
 'timeline.get':'读取持久化30fps多轨时间线；旧项目首次读取时仅创建空轨道',
 'timeline.history.get':'只读查询时间线编辑历史与撤销/重做位置；不创建时间线，不包含媒体或生成任务',
 'timeline.undo':'按时间线版本撤销一次轨道或片段编辑；保留稳定ID并递增版本，不撤销生成、花费或导出',
 'timeline.redo':'按时间线版本重做一次已撤销的轨道或片段编辑；使用稳定requestId恢复原请求结果',
 'timeline.track.add':'按时间线版本新增视频或音频轨道，最多12轨',
 'timeline.track.update':'按时间线版本更新轨道名称、画面隐藏或静音',
 'timeline.clip.add':'在指定轨道与帧位置添加固定素材片段；同轨不可重叠',
 'timeline.clip.update':'按时间线版本移动、裁切或调整片段，保留固定素材引用',
 'timeline.clip.remove':'按时间线版本移除指定片段',
 'timeline.clip.split':'在所选片段内部的整数时间线帧原子分割；左段保留ID，右段固定新ID；保留素材和源范围，不移动其他片段，可一次撤销，使用稳定requestId',
 'timeline.seed':'仅向空时间线按镜头顺序复制当前所选版本，之后独立编辑',
 'timeline.render':'冻结完整多轨时间线和素材哈希，排队生成真实预览或导出；通过export_get查询'
});
export class AppError extends Error {constructor(code,message,status=400,details={}){super(message);this.code=code;this.status=status;this.details=details;}}
export function parse(op,input){if(!schemas[op])throw new AppError('UNKNOWN_OPERATION','未知操作',404);const r=schemas[op].safeParse(input);if(!r.success)throw new AppError('VALIDATION_ERROR','输入字段无效',400,{issues:r.error.issues.map(x=>({path:x.path,message:x.message}))});return r.data;}
export function publicValue(v){if(Array.isArray(v))return v.map(publicValue);if(v&&typeof v==='object'){const result=Object.fromEntries(Object.entries(v).filter(([k])=>!['path','relativePath','requestHash'].includes(k)).map(([k,x])=>[k,publicValue(x)]));if(v.shotId&&v.providerId&&v.status&&v.requestId)result.allowedActions=v.status==='failed'?['retry']:v.status==='submission_unknown'?['reconcile','cancel']:v.status==='cancelled'?['reconcile']:v.status==='succeeded'?[]:['cancel'];return result;}return v;}

// Pure provider capability checks shared by HTTP/CLI/MCP validation and the renderer.
// Reference bytes and paid authorization remain backend-only checks.
export function findModelCapabilities(capabilities, model) {
 const id=model||(typeof capabilities?.models?.[0]==='string'?capabilities.models[0]:capabilities?.models?.[0]?.id);
 return capabilities?.modelCapabilities?.find(item=>item.id===id)||
  (capabilities?.models?.some(item=>(typeof item==='string'?item:item.id)===id)?{...capabilities,id,referenceImages:{min:capabilities.inputModes?.includes('text')?0:1,max:capabilities.maxReferenceImages??1}}:null);
}
export function getGenerationIssue(snapshot, capabilities) {
 const model=findModelCapabilities(capabilities,snapshot.model);
 const issue=(code,message)=>({code,message});
 if(!model)return issue('UNSUPPORTED_MODEL','此供应商不支持所选模型');
 if(!model.aspectRatios?.includes(snapshot.aspectRatio)||!model.durations?.includes(snapshot.duration))return issue('UNSUPPORTED_PARAMETERS','此模型不支持所选画幅或时长');
 const refs=snapshot.referenceAssets||[],count=snapshot.referenceAssetIds?.length??refs.length;
 const mode=count?'image':'text';
 if(!model.inputModes?.includes(mode))return issue('UNSUPPORTED_INPUT',mode==='text'?'此模型需要一张首帧参考图':'此模型不支持参考图输入');
 const constraints=model.referenceImages||{min:mode==='text'?0:1,max:1};
 if(count<constraints.min||count>constraints.max)return issue('UNSUPPORTED_INPUT',`此模型支持 ${constraints.min}–${constraints.max} 张参考图片`);
 if(refs.some(asset=>!asset.mimeType?.startsWith('image/')))return issue('UNSUPPORTED_INPUT','首帧参考素材必须为图片');
 if(constraints.mimeTypes&&refs.some(asset=>!constraints.mimeTypes.includes(asset.mimeType)))return issue('UNSUPPORTED_INPUT','此模型不支持所选参考图片格式');
 if(constraints.minDimension&&refs.some(asset=>asset.width<constraints.minDimension||asset.height<constraints.minDimension))return issue('UNSUPPORTED_INPUT',`参考图宽高均须至少 ${constraints.minDimension} 像素`);
 if(constraints.maxDimension&&refs.some(asset=>asset.width>constraints.maxDimension||asset.height>constraints.maxDimension))return issue('UNSUPPORTED_INPUT',`参考图宽高均须不超过 ${constraints.maxDimension} 像素`);
 if(constraints.matchAspectRatio&&refs.length){const [w,h]=snapshot.aspectRatio.split(':').map(Number);if(refs.some(asset=>asset.width*h!==asset.height*w))return issue('UNSUPPORTED_INPUT','此模型首帧参考图须与所选画幅比例一致');}
 if(model.promptRequired&&(!snapshot.prompt?.trim()||snapshot.prompt.length>(model.maxPromptLength||5000)))return issue('INVALID_PROMPT',`请填写 1–${model.maxPromptLength||5000} 字符的画面描述`);
 const parameters=snapshot.parameters||{};
 if(model.parameters&&Object.keys(parameters).some(key=>!model.parameters.includes(key)))return issue('UNSUPPORTED_PARAMETER','此模型不支持所选高级参数');
 if(parameters.seed!==undefined&&model.seed&&(!Number.isInteger(parameters.seed)||parameters.seed<model.seed.min||parameters.seed>model.seed.max))return issue('INVALID_SEED',`随机种子须为 ${model.seed.min}–${model.seed.max} 之间的整数`);
 return null;
}

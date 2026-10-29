import {PREVIS_HANDS,PREVIS_LIMITS,PREVIS_POSES,PREVIS_PROP_KINDS,PREVIS_SCENE_SCHEMA_VERSION,previsFrame,previsFramedElements,previsLookAt,previsSchemas,roundPrevisNumber} from '@mioon/contracts';
import type {PrevisCamera,PrevisNodeRecord,PrevisScene} from '@mioon/contracts';
import type {AgentTaskJson} from '../../../contracts/src/agent-tasks-v2.ts';
import type {WorkspaceStore} from '../db.ts';
import type {AgentTaskParameterFeedback} from './task-tool-errors-v2.ts';

// C8 v2: Mio reads and edits camera previs scenes. Mio sees a scene in the
// shape it writes back, without the schema version and the exported image
// IDs: the host keeps exports per keyframe ID, so Mio can neither add nor move
// them. Writing stays the shared previs.scene.set under scene revision CAS.
// Nothing here renders; framing is the editor's frustum estimate.
type Value=Record<string,unknown>;
const object=(value:unknown):value is Value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export const AGENT_TASK_PREVIS_INSPECT_TOOL='mioon_previs_inspect';
export const AGENT_TASK_PREVIS_INSPECT_OPERATION='previs.inspect';
const placeholder='00000000-0000-4000-8000-000000000000';

// ---- Model-facing tool definitions ----
// Plain array items instead of tuple schemas, and textual name rules instead
// of a surrogate-range pattern, so every provider accepts them. The shared Zod
// schema still validates every call exactly.
const measure=(minimum:number,maximum:number,description?:string)=>({type:'number',minimum,maximum,...(description?{description}:{})});
const point=(description:string)=>({type:'array',items:measure(-100,100),minItems:3,maxItems:3,description});
const name={type:'string',maxLength:PREVIS_LIMITS.nameLength,description:'可为空，界面显示默认名；不超过20字，不含换行和控制字符'};
const id=(prefix:'f'|'p'|'k',description:string)=>({type:'string',pattern:`^${prefix}[1-9][0-9]{0,3}$`,description});
const camera=(description:string)=>({type:'object',description,properties:{
 position:point('机位 [x,y,z]，米；y 是镜头离地高度，人眼约 1.6'),
 yaw:measure(-180,180,'水平朝向，度：0 看向 -Z，90 看向 -X，-90 看向 +X，180 看向 +Z'),
 pitch:measure(-90,90,'俯仰，度：正值向上看'),
 lookAt:point('可选，代替 yaw 和 pitch：机位看向的点 [x,y,z]，宿主据此算出 yaw 和 pitch'),
 focalLength:measure(10,300,'焦距 mm，按 36 mm 长边：24 全景，35 中景，50 中近景，85 近景'),
},required:['position','focalLength'],additionalProperties:false});
const figure={type:'object',properties:{
 id:id('f','人偶 ID，如 f1；新人偶用场景里没有的编号'),name,visible:{type:'boolean'},
 position:point('站位 [x,y,z]，米，脚底所在的点；站在地面上时 y=0'),
 rotation:measure(-180,180,'朝向，度：0 面向 +Z，90 面向 +X，-90 面向 -X，180 面向 -Z'),
 pose:{type:'string',enum:[...PREVIS_POSES],description:'stand 站立，walk 行走，sit 坐，hold 持物，look-back 回头'},
 held:{anyOf:[{type:'object',properties:{propId:id('p','拿着的道具 ID'),hand:{type:'string',enum:[...PREVIS_HANDS]}},required:['propId','hand'],additionalProperties:false},{type:'null'}],
  description:'手里的道具，只能是伞、手机、包或杯；没有时为 null'},
},required:['id','name','visible','position','rotation','pose','held'],additionalProperties:false};
const prop={type:'object',properties:{
 id:id('p','道具 ID，如 p1；新道具用场景里没有的编号'),
 kind:{type:'string',enum:[...PREVIS_PROP_KINDS],description:'box 箱体，cylinder 圆柱，sphere 球，panel 平板（墙、门、招牌），umbrella 伞，phone 手机，bag 包，cup 杯'},
 name,visible:{type:'boolean'},
 position:point('底面中心 [x,y,z]，米；放在地面上时 y=0。被人偶拿着时跟着手走，不看这个位置'),
 rotation:measure(-180,180,'朝向，度，和人偶相同：0 面向 +Z'),
 size:{type:'array',items:measure(0.01,20),minItems:3,maxItems:3,description:'[宽, 高, 深]，米；圆柱和球用宽作直径'},
},required:['id','kind','name','visible','position','rotation','size'],additionalProperties:false};
const light={type:'object',description:'主光',properties:{visible:{type:'boolean'},
 azimuth:measure(-180,180,'光从哪边照来，度，和人偶朝向同一套角度：0 从 +Z 照来，90 从 +X'),
 elevation:measure(-90,90,'光的仰角，度'),intensity:measure(0,4,'强度，默认 1')},
 required:['visible','azimuth','elevation','intensity'],additionalProperties:false};
const keyframe={type:'object',properties:{id:id('k','关键帧 ID，如 k1；新关键帧用场景里没有的编号'),name,camera:camera('这个关键帧的机位')},
 required:['id','name','camera'],additionalProperties:false};
export const AGENT_TASK_PREVIS_SCENE_PARAMETERS=Object.freeze({type:'object',properties:{
 nodeId:{type:'string',format:'uuid'},
 expectedSceneRevision:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER,description:'mioon_previs_inspect 读到的 sceneRevision'},
 scene:{type:'object',properties:{
  figures:{type:'array',items:figure,maxItems:PREVIS_LIMITS.figures},
  props:{type:'array',items:prop,maxItems:PREVIS_LIMITS.props},
  light,camera:camera('当前机位'),
  keyframes:{type:'array',items:keyframe,maxItems:PREVIS_LIMITS.keyframes,description:'关键帧，按顺序编号为 K1、K2…'},
  activeKeyframeId:{anyOf:[id('k','关键帧 ID'),{type:'null'}],description:'可省略：编辑器里选中的关键帧'},
 },required:['figures','props','light','camera','keyframes'],additionalProperties:false},
},required:['nodeId','expectedSceneRevision','scene'],additionalProperties:false});
export const AGENT_TASK_PREVIS_INSPECT_PARAMETERS=Object.freeze({type:'object',properties:{nodeId:{type:'string',format:'uuid'}},required:['nodeId'],additionalProperties:false});
export const AGENT_TASK_PREVIS_DESCRIPTIONS=Object.freeze({
 'previs.inspect':'读取当前项目的一个机位预演节点：场景（人偶、道具、主光、当前机位和关键帧）、场景修订号、项目画幅，以及当前机位和每个关键帧在画幅里能拍到哪些人偶和道具（按视锥估算，不渲染）。scene 可以修改后整体交给 mioon_previs_scene_set。只读。',
 'previs.create':'在画布上新建一个机位预演节点，带默认场景：一个站立人偶、主光和视平线机位。只在本机保存，不渲染、不调用模型、不付费。新建的节点不能撤销，也不能删除；已有预演节点时直接修改它。position 是画布坐标。建好后用 mioon_previs_scene_set 写入场景。',
 'previs.scene.set':'整体保存一个机位预演节点的场景：人偶、道具、主光、当前机位和关键帧；节点名称和位置不变。expectedSceneRevision 填 mioon_previs_inspect 读到的 sceneRevision，场景已被改过时返回冲突，重新读取后再改。只在本机保存，不渲染、不调用模型、不付费，可以撤销。单位是米、度、毫米；+Y 向上，地面 y=0。关键帧导出过的图片由宿主按关键帧 ID 保留：改已有关键帧的机位不会更新这些图片，换机位时加一个新 ID 的关键帧。数字多于三位小数时四舍五入。返回和 mioon_previs_inspect 相同的读取结果，可以直接检查取景。',
});

// ---- Mio's scene in, the saved scene out ----
const round=(value:unknown):unknown=>typeof value==='number'&&Number.isFinite(value)?roundPrevisNumber(value):
 Array.isArray(value)?value.map(round):object(value)?Object.fromEntries(Object.entries(value).map(([field,item])=>[field,round(item)])):value;
const triple=(value:unknown):value is [number,number,number]=>Array.isArray(value)&&value.length===3&&value.every(item=>typeof item==='number'&&Number.isFinite(item));
/** A camera given a point to look at gets the yaw and pitch that look there. */
function aimed(value:unknown):unknown{
 if(!object(value)||!Object.hasOwn(value,'lookAt'))return value;
 const {lookAt,...rest}=value;
 if(!triple(lookAt)||!triple(rest.position))return value;
 const look=previsLookAt(rest.position,lookAt);
 return {...rest,yaw:roundPrevisNumber(look.yaw),pitch:roundPrevisNumber(look.pitch)};
}
/** Mio's scene in the contract shape before the current node is read: three
 * decimals, the schema version, cameras aimed by `lookAt`, and empty exports
 * that previsSceneForNode replaces. An unknown selected keyframe is cleared. */
export function previsSceneCandidate(value:unknown):unknown{
 if(!object(value))return value;
 const scene=round(value) as Value;
 const keyframes=Array.isArray(scene.keyframes)?scene.keyframes.map(item=>object(item)?{...item,camera:aimed(item.camera),exports:[]}:item):scene.keyframes;
 const ids=new Set(Array.isArray(keyframes)?keyframes.flatMap(item=>object(item)&&typeof item.id==='string'?[item.id]:[]):[]);
 return {...scene,schemaVersion:PREVIS_SCENE_SCHEMA_VERSION,camera:aimed(scene.camera),keyframes,
  activeKeyframeId:typeof scene.activeKeyframeId==='string'&&ids.has(scene.activeKeyframeId)?scene.activeKeyframeId:null};
}
/** The scene to save: each keyframe keeps the images exported from its ID,
 * and the selected keyframe stays unless Mio chose another one or none. */
export function previsSceneForNode(candidate:PrevisScene,current:PrevisScene,requested:unknown):PrevisScene{
 const exports=new Map(current.keyframes.map(item=>[item.id,item.exports]));
 const keyframes=candidate.keyframes.map(item=>({...item,exports:[...(exports.get(item.id)??[])]}));
 const ids=new Set(keyframes.map(item=>item.id));
 const activeKeyframeId=typeof requested==='string'&&ids.has(requested)?requested:requested===null?null:
  current.activeKeyframeId!==null&&ids.has(current.activeKeyframeId)?current.activeKeyframeId:null;
 return {...candidate,keyframes,activeKeyframeId};
}
/** The value Mio asked for as the selected keyframe; undefined when omitted. */
export const previsRequestedKeyframe=(input:unknown):unknown=>object(input)&&object(input.scene)&&Object.hasOwn(input.scene,'activeKeyframeId')?input.scene.activeKeyframeId:undefined;

// ---- What Mio reads back ----
function timelineFormat(store:WorkspaceStore,projectId:string):Value|null{
 const row=store.db.prepare('SELECT data FROM timelines WHERE projectId=?').get(projectId);
 if(typeof row?.data!=='string')return null;
 try{const value:unknown=JSON.parse(row.data);return object(value)&&value.projectId===projectId?value:null;}catch{return null;}
}
/** A previs node as Mio reads it, also returned after Mio creates or saves one. */
export function previsTaskView(store:WorkspaceStore,projectId:string,node:PrevisNodeRecord):AgentTaskJson{
 const frame=previsFrame(timelineFormat(store,projectId)),scene=node.scene;
 const shots=store.list('shots',projectId).flatMap(value=>object(value)&&typeof value.id==='string'?[{id:value.id,orderIndex:typeof value.orderIndex==='number'?value.orderIndex:0,
  first:Array.isArray(value.referenceAssetIds)&&typeof value.referenceAssetIds[0]==='string'?value.referenceAssetIds[0].toLowerCase():null,
  last:typeof value.lastFrameAssetId==='string'?value.lastFrameAssetId.toLowerCase():null}]:[]).sort((a,b)=>a.orderIndex-b.orderIndex);
 const framed=(view:PrevisCamera)=>previsFramedElements(scene,view,frame.aspect);
 return {nodeId:node.id,label:node.label,revision:node.revision,sceneRevision:node.sceneRevision,frame:{width:frame.width,height:frame.height,ratio:frame.ratio},
  scene:{figures:scene.figures,props:scene.props,light:scene.light,camera:scene.camera,keyframes:scene.keyframes.map(item=>({id:item.id,name:item.name,camera:item.camera})),activeKeyframeId:scene.activeKeyframeId},
  framing:{camera:framed(scene.camera),keyframes:scene.keyframes.map((item,index)=>{
   const images=new Set(item.exports.map(asset=>asset.toLowerCase()));
   return {id:item.id,label:`K${index+1}`,...framed(item.camera),exportedImages:item.exports.length,
    shotFrames:shots.flatMap(shot=>[...(shot.first&&images.has(shot.first)?[{shotId:shot.id,frame:'first'}]:[]),...(shot.last&&images.has(shot.last)?[{shotId:shot.id,frame:'last'}]:[])])};
  })}} as unknown as AgentTaskJson;
}

// ---- Feedback for a refused scene ----
type Reason=AgentTaskParameterFeedback['issues'][number]['reason'];
const rules:Readonly<Record<string,string>>={
 'Element IDs must be distinct':'人偶、道具和关键帧的 ID 各自不能重复',
 'A prop is held by one figure at most':'一个道具只能被一个人偶拿着',
 'Only an umbrella, phone, bag or cup can be held':'人偶只能拿伞、手机、包或杯',
 'The scene exceeds 16 KiB':'场景超过 16 KiB，请减少元素或缩短名称',
 'Names cannot contain control characters':'名称不能含换行或控制字符',
};
/** Which scene fields broke the contract, by schema path; Mio's values and
 * unknown field names are never echoed. Advisory only: prepare validates. */
export function agentTaskPrevisSceneFeedback(input:unknown,current?:PrevisScene):AgentTaskParameterFeedback|null{
 if(!object(input))return null;
 const issues:AgentTaskParameterFeedback['issues']=[],notes:string[]=[];
 const add=(path:readonly PropertyKey[],reason:Reason):void=>{
  const field=path.slice(0,6).map(String).join('.')||'input';
  if(issues.length<16&&!issues.some(issue=>issue.field===field&&issue.reason===reason))issues.push({field,reason});
 };
 const scene=object(input.scene)?input.scene:null;
 const cameras:Array<[PropertyKey[],unknown]>=[[['scene','camera'],scene?.camera],
  ...(Array.isArray(scene?.keyframes)?scene.keyframes.map((value,position):[PropertyKey[],unknown]=>[['scene','keyframes',position,'camera'],object(value)?value.camera:undefined]):[])];
 for(const [path,item] of cameras)if(object(item)&&Object.hasOwn(item,'lookAt')&&!triple(item.lookAt))add([...path,'lookAt'],'invalid_value');
 const candidate=previsSceneCandidate(input.scene);
 const check=(value:unknown):void=>{
  const parsed=previsSchemas['previs.scene.set'].safeParse({...input,scene:value,projectId:placeholder,requestId:placeholder});
  if(parsed.success)return;
  for(const issue of parsed.error.issues){
   if(issue.code==='custom'){add(issue.path,'invalid_value');const note=rules[issue.message];if(note&&!notes.includes(note))notes.push(note);}
   else if(issue.code==='unrecognized_keys')add(issue.path,'unknown_field');
   else if(issue.code==='invalid_string'&&issue.path.at(-1)==='name'){add(issue.path,'invalid_value');if(!notes.includes(rules['Names cannot contain control characters']!))notes.push(rules['Names cannot contain control characters']!);}
   else add(issue.path,issue.code==='invalid_type'?(issue.received==='undefined'?'required':'invalid_type'):'invalid_value');
  }
 };
 check(candidate);
 if(!issues.length&&current&&object(candidate)){
  const parsed=previsSchemas['previs.scene.set'].shape.scene.safeParse(candidate);
  if(parsed.success)check(previsSceneForNode(parsed.data,current,previsRequestedKeyframe(input)));
 }
 if(!issues.length)return null;
 const reasons:Record<Reason,string>={required:'缺少必填字段',invalid_type:'字段类型不符',invalid_value:'字段值无效或超出范围',unknown_field:'未声明的字段',unsupported_parameter:'不支持此参数'};
 return {message:`预演场景未通过本地校验：${issues.map(issue=>`${issue.field}（${reasons[issue.reason]}）`).join('；')}。${notes.join('；')}${notes.length?'。':''}单位和范围见工具参数说明；机位用 yaw 和 pitch，或用 lookAt 指定看向的点。场景还没有保存，请修正后重新提交。`,issues};
}

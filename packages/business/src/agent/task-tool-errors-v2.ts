import {schemas} from '@mioon/contracts';
import {parseVideoBinding,videoInputProfile} from '../../../contracts/src/video-providers.ts';
import type {VideoExecutionBinding} from '../../../contracts/src/video-providers.ts';

type ParameterIssueReason='required'|'invalid_type'|'invalid_value'|'unknown_field'|'unsupported_parameter';
export interface AgentTaskParameterFeedback {
  message:string;
  issues:Array<{field:string;reason:ParameterIssueReason}>;
  supported?:{
    parameters:string[];
    aspectRatios:string[];
    durationsSeconds:number[];
    durationResolutionMap:Array<{duration:number[];resolution:string[]}>;
  };
}
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const placeholder='00000000-0000-4000-8000-000000000000';
const rootFields=['shotId','expectedRevision','providerId','model','connectionId','configurationRevision','modelEntryId','parameters','videoInput','subjectVersionId'] as const;
const parameterFields=['scenario','delayMs','seed','resolution','generateAudio','durationSeconds','aspectRatio','promptExtend','watermark'] as const;
const wanFields=['durationSeconds','aspectRatio','promptExtend','watermark'] as const;
const fieldPaths=new Set<string>([
  ...rootFields,...parameterFields.map(field=>`parameters.${field}`),
  'videoInput.version','videoInput.mode','videoInput.images','videoInput.prompt',
]);
function safeField(path:readonly (string|number)[]):string {
  const joined=path.join('.');
  if(fieldPaths.has(joined))return joined;
  if(path[0]==='videoInput'&&path[1]==='images'&&Number.isInteger(path[2])&&Number(path[2])>=0&&Number(path[2])<10&&
    (path.length===3||path.length===4&&['role','assetId'].includes(String(path[3]))))return joined;
  return path[0]==='parameters'?'parameters':path[0]==='videoInput'?'videoInput':'input';
}
/** Recompute capabilities from the exact selected, validated local binding.
 * Discovery messages/inputProfiles and credential data never become feedback. */
function selectedBinding(input:Record<string,unknown>,capabilities:unknown):VideoExecutionBinding|null {
  if(!object(capabilities)||!object(capabilities.videoConnection)||!object(capabilities.videoModel))return null;
  try{
    const binding=parseVideoBinding({...capabilities.videoConnection,model:capabilities.videoModel,credentialRef:placeholder});
    return input.connectionId===binding.connectionId&&input.configurationRevision===binding.configurationRevision&&input.modelEntryId===binding.model.id&&input.providerId===binding.providerId&&
      (input.model===undefined||input.model===binding.model.modelId)?binding:null;
  }catch{return null;}
}
/** Advisory feedback only: schemas, ownership, approvals and dispatch remain
 * authoritative. Never reflect thrown errors, provider bodies or input values. */
export function agentTaskParameterFeedback({operation,input,capabilities}:{operation:string;input:unknown;capabilities?:unknown}):AgentTaskParameterFeedback|null {
  if(!['generation.submit','mioon_generation_submit'].includes(operation)||!object(input))return null;
  const issues:AgentTaskParameterFeedback['issues']=[];
  const add=(field:string,reason:ParameterIssueReason):void=>{if(issues.length<16&&!issues.some(issue=>issue.field===field&&issue.reason===reason))issues.push({field,reason});};
  // The host owns replay identity. Supply a fixed local placeholder only for
  // validation; never suggest that the model choose or reuse a request ID.
  const parsed=schemas['generation.submit'].safeParse({...input,requestId:placeholder});
  if(!parsed.success)for(const issue of parsed.error.issues){
    if(issue.code==='unrecognized_keys'){
      for(const key of issue.keys){
        const path=[...issue.path,key],field=safeField(path);
        add(field,'unknown_field');
      }
    }else add(safeField(issue.path),issue.code==='invalid_type'?(issue.received==='undefined'?'required':'invalid_type'):'invalid_value');
  }
  const parameters=object(input.parameters)?input.parameters:null;
  const nonWan=typeof input.providerId==='string'&&['mock','runway','ark','veo','minimax','vidu','kling','compatible'].includes(input.providerId);
  if(nonWan&&parameters)for(const field of wanFields)if(Object.hasOwn(parameters,field))add(`parameters.${field}`,'unsupported_parameter');
  const binding=selectedBinding(input,capabilities),profile=binding?videoInputProfile(binding):null;
  if(profile&&parameters)for(const field of parameterFields){
    if(!Object.hasOwn(parameters,field))continue;
    const rule=profile.parameters[field];
    if(!rule){add(`parameters.${field}`,'unsupported_parameter');continue;}
    const value=parameters[field];
    if(rule.type==='integer'){
      if(typeof value!=='number'||!Number.isSafeInteger(value))add(`parameters.${field}`,'invalid_type');
      else if(value<rule.min||value>rule.max)add(`parameters.${field}`,'invalid_value');
    }else{
      const booleanField=['generateAudio','promptExtend','watermark'].includes(field);
      if(booleanField?typeof value!=='boolean':typeof value!=='string')add(`parameters.${field}`,'invalid_type');
      else if(!rule.values.includes(typeof value==='boolean'?String(value):value as string))add(`parameters.${field}`,'invalid_value');
    }
  }
  if(!issues.length)return null;
  const supported=profile&&binding?{
    parameters:parameterFields.filter(field=>Object.hasOwn(profile.parameters,field)),
    aspectRatios:[...profile.aspectRatios],durationsSeconds:[...profile.durationsSeconds],
    durationResolutionMap:binding.model.durationResolutionMap.map(pair=>({duration:[...pair.duration],resolution:pair.resolution.filter(value=>profile.parameters.resolution?.type==='enum'&&profile.parameters.resolution.values.includes(value))})).filter(pair=>pair.resolution.length>0),
  }:undefined;
  const descriptions:Record<ParameterIssueReason,string>={required:'缺少必填字段',invalid_type:'字段类型不符',invalid_value:'字段值或组合无效',unknown_field:'未声明的字段',unsupported_parameter:'所选模型不支持此参数'};
  const messages=[`本次生成参数未通过本地校验：${issues.map(issue=>`${issue.field}（${descriptions[issue.reason]}）`).join('；')}。`];
  if(nonWan&&issues.some(issue=>wanFields.some(field=>issue.field===`parameters.${field}`)))messages.push('durationSeconds、aspectRatio、promptExtend、watermark 是 Wan 专属生成参数，请从本次 parameters 中移除。');
  if(nonWan)messages.push('画幅、时长和提示词取自已保存镜头；需修改时先读取镜头当前版本，再使用 shot.update 的 patch.aspectRatio、patch.duration、patch.prompt，随后以新镜头版本提交。');
  if(supported)messages.push(`所选精确模型支持 parameters：${supported.parameters.join('、')||'无'}；镜头画幅：${supported.aspectRatios.join('、')}；镜头时长（秒）：${supported.durationsSeconds.join('、')}；时长与分辨率组合：${supported.durationResolutionMap.map(pair=>`${pair.duration.join('/')} 秒 → ${pair.resolution.join('/')}`).join('；')||'当前连接没有可用组合，请重新读取连接配置'}。`);
  messages.push('此反馈不授权付费，也不代表任务已提交；请修正参数并遵循正常确认流程。');
  return {message:messages.join(' '),issues,...(supported?{supported}:{})};
}

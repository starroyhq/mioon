import {randomUUID} from 'node:crypto';
import {providerError} from '../providers/live-common.ts';

export type ConfiguredVideoFamily = 'runway'|'ark'|'veo'|'minimax'|'vidu'|'kling'|'wan'|'compatible';
export interface VideoAdapterSelection {
  providerId: ConfiguredVideoFamily;
  model: string;
  resolution: string;
  audio: 'default'|'off'|'on'|'optional';
}
export interface VideoAdapterImage {mimeType: string; base64: string; role: string}
export interface VideoAdapterInput {
  prompt: string; aspectRatio: string; duration: number; parameters: Record<string, unknown>;
  images: VideoAdapterImage[]; subjectReference: boolean;
}
export interface VideoSubmissionRequest {path: string; body?: Record<string, unknown>; raw?: {bytes: Uint8Array; contentType: string}; headers?: Record<string,string>}
export interface ConfiguredVideoTask {
  id: string; status: 'running'|'succeeded'|'failed'; progress?: number; url?: string; externalId?: string;
}
const object=(value: unknown): Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const uri=(image: VideoAdapterImage)=>`data:${image.mimeType};base64,${image.base64}`;
const TASK_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const RUNWAY_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNWAY_RATIOS: Readonly<Record<string,string>>={'9:16':'720:1280','16:9':'1280:720','1:1':'960:960','3:4':'832:1104','4:3':'1104:832','21:9':'1584:672'};
const invalidTask=()=>providerError('INVALID_PROVIDER_RESPONSE','The provider response did not match the existing task.',{retryable:true});

/** OpenAI Videos sizes are WIDTHxHEIGHT strings. The resolution label names the
 * short edge; both edges are kept even, as video encoders require. */
export function compatibleVideoSize(aspectRatio: string,resolution: string): string {
  const short=Number(/^([1-9][0-9]{2,3})p$/i.exec(resolution)?.[1]),[a,b]=aspectRatio.split(':').map(Number);
  if(!Number.isInteger(short)||!Number.isInteger(a)||!Number.isInteger(b)||!a||!b)throw providerError('UNSUPPORTED_CAPABILITY','The output size cannot be derived from this aspect ratio and resolution.');
  const long=(edge: number)=>Math.round(edge/2)*2;
  return a===b?`${short}x${short}`:a<b?`${short}x${long(short*b/a)}`:`${long(short*a/b)}x${short}`;
}
/** multipart/form-data exactly like the official client: text fields, then the
 * optional first-frame file as input_reference. The boundary is random per call. */
export function compatibleVideoForm(fields: Readonly<Record<string,string>>,image?: VideoAdapterImage,boundary=`mioon${randomUUID().replaceAll('-','')}`): {bytes: Uint8Array; contentType: string} {
  const parts: Buffer[]=[];
  for(const [name,value] of Object.entries(fields))parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,'utf8'));
  if(image){
    const extension=image.mimeType==='image/jpeg'?'jpg':image.mimeType==='image/webp'?'webp':'png';
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="input_reference"; filename="reference.${extension}"\r\nContent-Type: ${image.mimeType}\r\n\r\n`,'utf8'),Buffer.from(image.base64,'base64'),Buffer.from('\r\n','utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`,'utf8'));
  return {bytes:Buffer.concat(parts),contentType:`multipart/form-data; boundary=${boundary}`};
}

export function assertConfiguredTaskId(selection: VideoAdapterSelection,id: unknown): asserts id is string {
  if(typeof id!=='string')throw providerError('INVALID_PROVIDER_TASK_ID','The provider task identity is invalid.');
  if(selection.providerId==='veo'){
    const prefix=`models/${selection.model}/operations/`;
    if(!id.startsWith(prefix)||!TASK_ID.test(id.slice(prefix.length)))throw providerError('INVALID_PROVIDER_TASK_ID','The operation identity is invalid.');
  }else if(!(selection.providerId==='runway'?RUNWAY_ID:TASK_ID).test(id))throw providerError('INVALID_PROVIDER_TASK_ID','The provider task identity is invalid.');
}

/** Protocol mappings are deliberately explicit. A model name cannot select a new
 * origin, add an upload, or switch between old and new vendor API standards. */
export function configuredSubmission(selection: VideoAdapterSelection,input: VideoAdapterInput,requestId: string): VideoSubmissionRequest {
  const {providerId,model,resolution}=selection,{prompt,aspectRatio,duration,images,parameters}=input,first=images[0];
  switch(providerId){
    case 'runway':return {path:'/v1/image_to_video',body:{model,promptImage:first?uri(first):undefined,promptText:prompt,ratio:RUNWAY_RATIOS[aspectRatio],duration,...(parameters.seed===undefined?{}:{seed:parameters.seed})}};
    case 'ark':return {path:'/contents/generations/tasks',body:{model,content:[{type:'text',text:prompt},...images.map(image=>({type:'image_url',image_url:{url:uri(image)},role:input.subjectReference?'reference_image':image.role}))],duration,ratio:!input.subjectReference&&images.length?'adaptive':aspectRatio,...(input.subjectReference?{omni_reference_task_type:'reference'}:{}),resolution,output_format:'mp4',generate_audio:false}};
    case 'veo':return {path:`/models/${model}:predictLongRunning`,body:{instances:[{prompt,...(first?{image:{bytesBase64Encoded:first.base64,mimeType:first.mimeType}}:{})}],parameters:{aspectRatio,durationSeconds:duration,resolution,sampleCount:1}}};
    case 'minimax':return {path:'/v2/video_generation',body:{model,content:[{type:'text',text:prompt},...(first?[{type:'image_url',image_url:{url:uri(first)},role:'first_frame'}]:[])],duration,resolution,ratio:first?'adaptive':aspectRatio}};
    case 'vidu':return {path:first?'/ent/v2/img2video':'/ent/v2/text2video',body:{model,prompt,duration,resolution,audio:false,off_peak:false,...(first?{images:[uri(first)],is_rec:false}:{aspect_ratio:aspectRatio})}};
    case 'kling':return {path:`/${first?'image-to-video':'text-to-video'}/${model}`,body:{...(first?{contents:[{type:'prompt',text:prompt},{type:'first_frame',url:first.base64}]}:{prompt}),settings:{resolution,duration,audio:selection.audio==='on'||selection.audio==='optional'&&parameters.generateAudio===true?'native':'off',multi_shot:false,...(first?{}:{aspect_ratio:aspectRatio})},options:{external_task_id:requestId}}};
    case 'compatible':return {path:'/videos',raw:compatibleVideoForm({model,prompt,seconds:String(duration),size:compatibleVideoSize(aspectRatio,resolution)},first)};
    case 'wan':return {path:'/services/aigc/video-generation/video-synthesis',headers:{'X-DashScope-Async':'enable'},body:{model,input:{prompt,...(first?{media:[{type:'first_frame',url:uri(first)}]}:{})},parameters:{resolution,duration,prompt_extend:false,watermark:false,...(parameters.seed===undefined?{}:{seed:parameters.seed}),...(first?{}:{ratio:aspectRatio})}}};
  }
}

export function configuredSubmissionId(selection: VideoAdapterSelection,response: Record<string,unknown>): string {
  const id=selection.providerId==='veo'?response.name:selection.providerId==='kling'?object(response.data)?.id:selection.providerId==='wan'?object(response.output)?.task_id:selection.providerId==='minimax'||selection.providerId==='vidu'?response.task_id:response.id;
  try{
    if(selection.providerId==='kling'&&response.code!==0)throw new Error('rejected');
    assertConfiguredTaskId(selection,id);
  }catch{throw providerError('SUBMISSION_UNKNOWN','The provider did not return a valid task receipt. Do not resubmit.',{uncertain:true});}
  return id;
}

export function configuredTaskPath(selection: VideoAdapterSelection,id: string): string {
  assertConfiguredTaskId(selection,id);
  switch(selection.providerId){
    case 'runway':return `/v1/tasks/${id}`;
    case 'ark':return `/contents/generations/tasks/${id}`;
    case 'veo':return `/${id}`;
    case 'minimax':return `/v2/query/video_generation/${id}`;
    case 'vidu':return `/ent/v2/tasks/${id}/creations`;
    case 'kling':return `/tasks?task_ids=${encodeURIComponent(id)}`;
    case 'wan':return `/tasks/${id}`;
    case 'compatible':return `/videos/${id}`;
  }
}

function statusTask(id: string,task: Record<string,unknown>,key: string,running: readonly string[],success: string,failed: readonly string[],url: unknown): ConfiguredVideoTask {
  if(task.id!==id||typeof task[key]!=='string'||![...running,success,...failed].includes(task[key]))throw invalidTask();
  const status=task[key]===success?'succeeded':failed.includes(task[key])?'failed':'running';
  return {id,status,...(typeof url==='string'?{url}:{}),...(typeof task.progress==='number'&&Number.isFinite(task.progress)?{progress:Math.max(0,Math.min(status==='succeeded'?1:0.99,task.progress))}:{})};
}

export function configuredKlingTask(response: Record<string,unknown>,selection: VideoAdapterSelection,{id,externalId}: {id?: string;externalId?: string}): ConfiguredVideoTask|null {
  if(response.code!==0||!Array.isArray(response.data))throw invalidTask();
  const matches=response.data.map(object).filter((task):task is Record<string,unknown>=>Boolean(task)&&(id!==undefined?task!.id===id:task!.external_id===externalId));
  if(matches.length===0){if(id!==undefined)throw invalidTask();return null;}
  if(matches.length!==1)throw invalidTask();
  const task=matches[0];assertConfiguredTaskId(selection,task.id);
  if(externalId!==undefined&&task.external_id!==externalId)throw invalidTask();
  const outputs=Array.isArray(task.outputs)?task.outputs.map(object):[],videos=outputs.filter(output=>output?.type==='video');
  const result=statusTask(task.id,task,'status',['submitted','processing'],'succeeded',['failed'],videos[0]?.url);
  return {...result,...(typeof task.external_id==='string'?{externalId:task.external_id}:{})};
}

export function configuredTask(selection: VideoAdapterSelection,id: string,response: Record<string,unknown>): ConfiguredVideoTask {
  assertConfiguredTaskId(selection,id);
  switch(selection.providerId){
    case 'runway':{
      const outputs=Array.isArray(response.output)?response.output:[];
      return statusTask(id,response,'status',['PENDING','THROTTLED','RUNNING'],'SUCCEEDED',['FAILED','CANCELLED'],outputs[0]);
    }
    case 'ark':return statusTask(id,response,'status',['queued','running'],'succeeded',['failed','cancelled','expired'],object(response.content)?.video_url);
    case 'minimax':{
      const task=object(response.task);if(!task)throw invalidTask();
      return statusTask(id,task,'status',['queued','running'],'succeeded',['failed','cancelled'],object(task.content)?.url);
    }
    case 'vidu':{
      const first=Array.isArray(response.creations)?object(response.creations[0]):null;
      return statusTask(id,response,'state',['created','queueing','processing'],'success',['failed'],first?.url);
    }
    case 'kling':{
      const task=configuredKlingTask(response,selection,{id});if(!task)throw invalidTask();return task;
    }
    case 'wan':{
      const output=object(response.output);if(!output)throw invalidTask();
      // UNKNOWN includes expired/unavailable observations and does not establish
      // a definitive generation failure that would authorize another paid POST.
      return statusTask(id,{...output,id:output.task_id},'task_status',['PENDING','RUNNING'],'SUCCEEDED',['FAILED','CANCELED'],output.video_url);
    }
    case 'compatible':{
      // Progress is 0-100 in the OpenAI shape; statusTask expects a fraction.
      const progress=typeof response.progress==='number'&&Number.isFinite(response.progress)?response.progress/100:undefined;
      return statusTask(id,{...response,progress},'status',['queued','in_progress'],'completed',['failed','cancelled'],undefined);
    }
    case 'veo':{
      if(response.name!==id||response.done!==undefined&&typeof response.done!=='boolean')throw invalidTask();
      if(response.done!==true)return {id,status:'running',progress:0};
      if(response.error)return {id,status:'failed'};
      const generated=object(object(response.response)?.generateVideoResponse);
      if(!generated)throw invalidTask();
      const samples=generated.generatedSamples;if(!Array.isArray(samples)||samples.length===0)return {id,status:'failed'};
      const video=object(object(samples[0])?.video);if(typeof video?.uri!=='string')throw invalidTask();
      return {id,status:'succeeded',progress:1,url:video.uri};
    }
  }
}

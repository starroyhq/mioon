import {Configuration,VideoSynthesis} from 'dashscope-sdk-official';
import {AxiosHeaders} from 'axios';
import {parseVideoBinding} from '../../../contracts/src/video-providers.ts';
import type {VideoExecutionBinding} from '../../../contracts/src/video-providers.ts';
import {effectiveVideoParameters,isWan30Binding} from '../../../contracts/src/wan-video.ts';
import {awaitProvider,operationCancelled} from '../operation-lifecycle.ts';
import {createJsonRequest,imageDimensions,providerError} from '../providers/live-common.ts';
import type {ProviderContext} from '../providers/live-common.ts';
import {assertConfiguredTaskId,configuredSubmissionId,configuredTask} from './adapters.ts';
import type {ConfiguredVideoTask,VideoAdapterInput,VideoAdapterSelection} from './adapters.ts';

export interface WanSdkClientOptions {
  binding: VideoExecutionBinding;
  acquireCredential: ()=>Promise<string>;
  fetchImpl?: typeof fetch;
}

/* The package intentionally keeps RequestOptions private. This type-only bridge
 * obtains its public subclass extension contract without importing private paths. */
abstract class SdkRequestContract extends VideoSynthesis {
  requestContract(options: Parameters<SdkRequestContract['request']>[0]) { return this.request(options); }
}
type SdkRequestOptions = Parameters<SdkRequestContract['requestContract']>[0];
type SdkResponse = Awaited<ReturnType<SdkRequestContract['requestContract']>>;
type SdkVideoOptions = Parameters<VideoSynthesis['asyncCall']>[0];
const object=(value: unknown): Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;

/** SDK protocol construction, with the application's bounded and sanitized I/O.
 * A transport instance belongs to exactly one operation; no mutable signal or
 * request context can bleed into a concurrent submit or poll. */
class BoundVideoSynthesis extends VideoSynthesis {
  private readonly send: (options: SdkRequestOptions)=>Promise<Record<string,unknown>>;
  constructor(binding: VideoExecutionBinding,send: BoundVideoSynthesis['send']) {
    // Supply every SDK configuration field explicitly. The real credential and
    // workspace are used only by send; ambient DashScope variables cannot bind a
    // restored project task to a different account or endpoint.
    super(new Configuration({apiKey:'mioon-bound-transport',basePath:binding.endpoint,workspace:binding.workspaceId||'mioon-bound-transport',region:binding.region,webSocketBasePath:'wss://unused.invalid/'}));
    this.send=send;
  }
  protected override async request(options: SdkRequestOptions): Promise<SdkResponse> {
    // asyncCall()/fetch() consume only .data. No Axios client is invoked, hence
    // SDK package.json discovery and its environment/network defaults are unused
    // in the statically bundled desktop backend as well.
    return {data:await this.send(options),status:200,statusText:'OK',headers:{},config:{headers:new AxiosHeaders()}};
  }
}

export function createWanSdkClient({binding,acquireCredential,fetchImpl=globalThis.fetch}: WanSdkClientOptions) {
  const frozen=parseVideoBinding(binding);
  if(frozen.providerId!=='wan')throw providerError('VIDEO_BINDING_INVALID','The Wan SDK requires a bound Wan connection.');
  const wan30=isWan30Binding(frozen);
  const selection:VideoAdapterSelection={providerId:'wan',model:frozen.model.modelId,resolution:'',audio:frozen.model.audio};
  async function credential(context: ProviderContext): Promise<string> {
    if(context.signal?.aborted)throw operationCancelled({beforeDispatch:true});
    let secret:unknown;
    try{secret=await awaitProvider(acquireCredential,context.signal);}
    catch{if(context.signal?.aborted)throw operationCancelled({beforeDispatch:true});throw providerError('VIDEO_CREDENTIAL_UNAVAILABLE','The credential bound to this video task is unavailable. Restore it before continuing.',{beforeDispatch:true});}
    if(context.signal?.aborted)throw operationCancelled({beforeDispatch:true});
    if(typeof secret!=='string'||!secret||secret!==secret.trim()||secret.length>8192||/[\u0000-\u0020\u007f]/.test(secret))throw providerError('VIDEO_CREDENTIAL_UNAVAILABLE','The credential bound to this video task is unavailable. Restore it before continuing.',{beforeDispatch:true});
    return secret;
  }
  function sdk(context: ProviderContext) {
    return new BoundVideoSynthesis(frozen,async options=>{
      const method=options.method?.toUpperCase()??'GET';
      const allowed=['method','service','api','headers','data','sdkModule'];
      if(!['POST','GET'].includes(method)||Object.keys(options).some(key=>!allowed.includes(key)))throw providerError('VIDEO_BINDING_INVALID','The SDK requested an unsupported transport operation.');
      // Route segments originate exclusively in asyncCall/fetch. Reject URL-like
      // segments so SDK upgrades cannot silently bypass the bound official host.
      const segments=[options.service,options.api].filter((part):part is string=>part!==undefined);
      if(!segments.length||segments.some(part=>!part||part.startsWith('/')||part.includes('..')||/[?:#\\]/.test(part)))throw providerError('VIDEO_BINDING_INVALID','The SDK requested an invalid bound route.');
      const secret=await credential(context);
      const send=createJsonRequest({api:frozen.endpoint,headers:{...options.headers,Authorization:`Bearer ${secret}`,...(frozen.workspaceId?{'X-DashScope-WorkSpace':frozen.workspaceId}:{})},fetchImpl,ensureEnabled:()=>{},name:'Wan'});
      return send(`/${segments.join('/')}`,{method,body:options.data,context});
    });
  }
  return {
    async submit(input: VideoAdapterInput,context: ProviderContext={}): Promise<string> {
      const allowed=['resolution','seed','generateAudio','durationSeconds','aspectRatio','promptExtend','watermark'];
      if(Object.keys(input.parameters).some(key=>!allowed.includes(key)))throw providerError('UNSUPPORTED_PARAMETER','The Wan SDK accepts only advertised video parameters.');
      const effective=effectiveVideoParameters(frozen,input);
      const roles=input.images.map(image=>image.role);
      const frameInput=roles.length===1&&roles[0]==='first_frame';
      const imageInput=frameInput||wan30&&(roles.length===2&&roles[0]==='first_frame'&&roles[1]==='last_frame'||roles.length>=1&&roles.length<=10&&roles.every(role=>role==='reference_image'));
      if(input.subjectReference||roles.length>0&&!imageInput)throw providerError('UNSUPPORTED_INPUT_ROLE','The Wan SDK does not implement this image combination.');
      // A custom model ID must not switch the selected protocol via SDK heuristics.
      const options:SdkVideoOptions={model:frozen.model.modelId,task:'video-generation',prompt:input.prompt,extend_prompt:false,duration:effective.durationSeconds as number,resolution:effective.resolution as string,prompt_extend:wan30?effective.promptExtend as boolean:false,watermark:wan30?effective.watermark as boolean:false,
        ...(wan30||!roles.length?{ratio:effective.aspectRatio as string}:{}),
        ...(wan30?{audio:effective.generateAudio}:{}),
        ...(effective.seed===undefined?{}:{seed:effective.seed as number}),
        ...(roles.length?{media:input.images.map(image=>({type:image.role,url:`data:${image.mimeType};base64,${image.base64}`}))}:{}),
      };
      const response:unknown=await sdk(context).asyncCall(options);
      const record=object(response);
      if(!record)throw providerError('SUBMISSION_UNKNOWN','Wan returned an invalid task receipt. Do not resubmit.',{uncertain:true});
      return configuredSubmissionId(selection,record);
    },
    async retrieve(id: string,context: ProviderContext={}): Promise<ConfiguredVideoTask> {
      assertConfiguredTaskId(selection,id);
      const response:unknown=await sdk(context).fetch(id),record=object(response);
      if(!record)throw providerError('INVALID_PROVIDER_RESPONSE','Wan returned an invalid task response.',{retryable:true});
      return configuredTask(selection,id,record);
    },
  };
}

const invalidImage=()=>providerError('INVALID_REFERENCE_TYPE','The reference bytes do not match a supported opaque image.');
const transparentImage=()=>providerError('UNSUPPORTED_IMAGE_TRANSPARENCY','Wan 3.0 images must not contain an alpha channel or transparency.');

/** Inspect actual image structures, never the asset's declared alpha metadata. */
export function validateWanImageBytes(bytes: Buffer,mimeType: string): void {
  if(mimeType==='image/jpeg'){imageDimensions(bytes,mimeType);return;}
  if(mimeType==='image/png'){
    imageDimensions(bytes,mimeType);
    let ended=false;
    for(let offset=8;offset+12<=bytes.length;){
      const length=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8),start=offset+8;
      if(start+length+4>bytes.length)throw invalidImage();
      if(type==='IHDR'&&(offset!==8||length!==13))throw invalidImage();
      if(type==='IHDR'&&[4,6].includes(bytes[start+9]!))throw transparentImage();
      if(type==='tRNS')throw transparentImage();
      offset=start+length+4;
      if(type==='IEND'){if(length!==0||offset!==bytes.length)throw invalidImage();ended=true;break;}
    }
    if(!ended)throw invalidImage();
    return;
  }
  if(mimeType==='image/webp'){
    if(bytes.length<20||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WEBP'||bytes.readUInt32LE(4)+8!==bytes.length)throw invalidImage();
    let image=false,offset=12;
    for(;offset+8<=bytes.length;){
      const type=bytes.toString('ascii',offset,offset+4),length=bytes.readUInt32LE(offset+4),start=offset+8;
      if(start+length+(length&1)>bytes.length)throw invalidImage();
      if(type==='ALPH'||type==='VP8X'&&length>=10&&(bytes[start]!&0x10)!==0||type==='VP8L'&&length>=5&&(bytes.readUInt32LE(start+1)&0x10000000)!==0)throw transparentImage();
      if(type==='VP8 '&&length>=10&&bytes[start+3]===0x9d&&bytes[start+4]===1&&bytes[start+5]===0x2a||type==='VP8L'&&length>=5&&bytes[start]===0x2f)image=true;
      offset=start+length+(length&1);
    }
    if(!image||offset!==bytes.length)throw invalidImage();
    return;
  }
  throw invalidImage();
}

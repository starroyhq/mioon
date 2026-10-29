import {createHash} from 'node:crypto';
import {readFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {parseVideoBinding,videoConnectionEndpoint,validateVideoSnapshot,videoBindingCapabilities,videoOutputHosts,videoTemplate} from '../../../contracts/src/video-providers.ts';
import type {VideoExecutionBinding} from '../../../contracts/src/video-providers.ts';
import type {Provider,ProviderContext as RegisteredContext} from '../provider-registry.ts';
import {awaitProvider,checkpoint,operationCancelled} from '../operation-lifecycle.ts';
import {createJsonRequest,createPollCache,downloadMp4,managedImage,outputUrl,providerError} from '../providers/live-common.ts';
import type {ProviderContext,ProviderReferenceAsset,ManagedImage} from '../providers/live-common.ts';
import {assertConfiguredTaskId,configuredKlingTask,configuredSubmission,configuredSubmissionId,configuredTask,configuredTaskPath} from './adapters.ts';
import type {ConfiguredVideoTask,VideoAdapterInput,VideoAdapterSelection} from './adapters.ts';
import {createWanSdkClient,validateWanImageBytes} from './wan-sdk.ts';
import {effectiveVideoParameters,isWan30Binding} from '../../../contracts/src/wan-video.ts';
import {createPinnedVideoFetch} from './network.ts';
import {createCompatibleVideoSdkClient} from './compatible-sdk.ts';
import {createRunwaySdkClient} from './runway-sdk.ts';
import {createVeoSdkClient} from './veo-sdk.ts';
import {createArkSdkClient} from './ark-sdk.ts';
import {createMinimaxSdkClient} from './minimax-sdk.ts';

export interface ConfiguredVideoProviderOptions {
  root: string;
  binding: VideoExecutionBinding;
  acquireCredential: ()=>Promise<string>;
  fetchImpl?: typeof fetch;
  now?: ()=>number;
}
const record=(value: unknown): Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const contextOf=(context: RegisteredContext): ProviderContext=>({requestId:context.requestId,jobId:context.jobId,signal:context.signal??undefined,beforeSubmit:context.beforeSubmit,...(typeof context.validateReferenceState==='function'?{validateReferenceState:context.validateReferenceState as ()=>unknown}:{})});
const unsafeImage=()=>providerError('INVALID_REFERENCE_TYPE','The reference bytes do not match the supported image format.');

/** Only Runway's existing protocol accepts WebP. The shared image reader covers
 * PNG/JPEG; this bounded parser obtains WebP dimensions from the actual bytes. */
function webpDimensions(bytes: Buffer): {width:number;height:number} {
  if(bytes.length<30||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WEBP'||bytes.readUInt32LE(4)+8!==bytes.length)throw unsafeImage();
  for(let offset=12;offset+8<=bytes.length;){
    const type=bytes.toString('ascii',offset,offset+4),length=bytes.readUInt32LE(offset+4),start=offset+8;
    if(start+length>bytes.length)throw unsafeImage();
    if(type==='VP8X'&&length>=10)return {width:1+bytes.readUIntLE(start+4,3),height:1+bytes.readUIntLE(start+7,3)};
    if(type==='VP8L'&&length>=5&&bytes[start]===0x2f){const bits=bytes.readUInt32LE(start+1);return {width:1+(bits&0x3fff),height:1+((bits>>>14)&0x3fff)};}
    if(type==='VP8 '&&length>=10&&bytes[start+3]===0x9d&&bytes[start+4]===1&&bytes[start+5]===0x2a)return {width:bytes.readUInt16LE(start+6)&0x3fff,height:bytes.readUInt16LE(start+8)&0x3fff};
    offset=start+length+(length&1);
  }
  throw unsafeImage();
}

async function managedWebp(root: string,asset: ProviderReferenceAsset,maximum: number,context: ProviderContext): Promise<ManagedImage> {
  const check=()=>{checkpoint(context.signal);context.validateReferenceState?.();};check();
  if(typeof asset.path!=='string'||typeof asset.sha256!=='string')throw unsafeImage();
  const base=await realpath(root);check();const file=await realpath(asset.path);check();
  if(file===base||!file.startsWith(base+path.sep))throw providerError('UNSAFE_REFERENCE_PATH','Reference image must remain inside managed storage.');
  const info=await stat(file);check();if(!info.isFile()||info.size>maximum)throw providerError('REFERENCE_TOO_LARGE','The reference image exceeds the implemented input limit.');
  const bytes=await readFile(file);check();if(bytes.length>maximum)throw providerError('REFERENCE_TOO_LARGE','The reference image exceeds the implemented input limit.');
  if(createHash('sha256').update(bytes).digest('hex')!==asset.sha256.toLowerCase())throw providerError('REFERENCE_CHANGED','Reference image changed after its generation snapshot was created.');
  return {...webpDimensions(bytes),bytes,mimeType:'image/webp',base64:bytes.toString('base64')};
}

/** A factory has no network or credential side effects. Its immutable binding
 * chooses only an implemented official protocol; secrets are acquired for each
 * observation/dispatch and are never retained by the provider or its poll cache. */
export function createConfiguredVideoProvider({root,binding,acquireCredential,fetchImpl,now=Date.now}: ConfiguredVideoProviderOptions): Provider {
  const frozen=parseVideoBinding(binding),template=videoTemplate(frozen.model.templateId),hosts=new Set(videoOutputHosts(frozen));
  const compatible=frozen.providerId==='compatible';
  let endpoint='';try{endpoint=videoConnectionEndpoint({...frozen,...(compatible?{baseUrl:frozen.endpoint}:{})});}catch{}
  if(frozen.endpoint!==endpoint)throw providerError('VIDEO_BINDING_INVALID','The configured endpoint is not an implemented official endpoint.');
  // A user-named service host is only ever reached through the pinned transport.
  const transport=fetchImpl??(compatible?createPinnedVideoFetch():globalThis.fetch);
  const asOf=()=>new Date(now()).toISOString().slice(0,10);
  const capabilities={...videoBindingCapabilities(frozen,{configured:true,enabled:true,asOf:asOf()}),minPollIntervalMs:frozen.providerId==='runway'?5000:10000};
  const selection: VideoAdapterSelection={providerId:frozen.providerId,model:frozen.model.modelId,resolution:'',audio:frozen.model.audio};
  const wan=frozen.providerId==='wan'?createWanSdkClient({binding:frozen,acquireCredential,fetchImpl}):null;
  const ensureHosts=()=>{if(!hosts.size)throw providerError('PROVIDER_CONFIGURATION','Configure independently reviewed exact output hosts before generation.');};
  const validate=(snapshot: unknown): true=>{ensureHosts();return validateVideoSnapshot(frozen,snapshot,{asOf:asOf()});};
  async function credential(context: ProviderContext): Promise<string> {
    if(context.signal?.aborted)throw operationCancelled({beforeDispatch:true});
    let value: unknown;
    try{value=await awaitProvider(()=>acquireCredential(),context.signal);}
    catch{if(context.signal?.aborted)throw operationCancelled({beforeDispatch:true});throw providerError('VIDEO_CREDENTIAL_UNAVAILABLE','The credential bound to this video task is unavailable. Restore it before continuing.',{beforeDispatch:true});}
    if(context.signal?.aborted)throw operationCancelled({beforeDispatch:true});
    if(typeof value!=='string'||!value||value!==value.trim()||value.length>8192||/[\u0000-\u0020\u007f]/.test(value))throw providerError('VIDEO_CREDENTIAL_UNAVAILABLE','The credential bound to this video task is unavailable. Restore it before continuing.',{beforeDispatch:true});
    return value;
  }
  async function request(endpoint: string,{method='GET',body,raw,headers={},context={}}: {method?:string;body?:unknown;raw?:{bytes:Uint8Array;contentType:string};headers?:Record<string,string>;context?:ProviderContext}={}): Promise<Record<string,unknown>> {
    const secret=await credential(context);
    const authentication:Record<string,string>=frozen.providerId==='veo'?{'x-goog-api-key':secret}:{Authorization:`${frozen.providerId==='vidu'?'Token':'Bearer'} ${secret}`};
    const run=createJsonRequest({api:frozen.endpoint,headers:{...authentication,...(frozen.providerId==='runway'?{'X-Runway-Version':'2024-11-06'}:{}),...headers},fetchImpl:transport,ensureEnabled:()=>{},name:'Video provider'});
    return run(endpoint,{method,body,raw,context});
  }
  const sdkOptions={api:frozen.endpoint,model:frozen.model.modelId,send:request};
  const compatibleSdk=compatible?createCompatibleVideoSdkClient(sdkOptions):null;
  const sdk=compatibleSdk??(frozen.providerId==='runway'?createRunwaySdkClient(sdkOptions):frozen.providerId==='veo'?createVeoSdkClient(sdkOptions):frozen.providerId==='ark'?createArkSdkClient({...sdkOptions,audio:frozen.model.audio}):frozen.providerId==='minimax'?createMinimaxSdkClient(sdkOptions):null);
  const cache=createPollCache({now,interval:capabilities.minPollIntervalMs,retrieve:async(id,context)=>wan?{...await wan.retrieve(id,context)}:{...configuredTask(selection,id,sdk?await sdk.retrieve(id,context):await request(configuredTaskPath(selection,id),{context}))}});
  const retrieve=async(id: string,context: ProviderContext):Promise<ConfiguredVideoTask>=>{
    assertConfiguredTaskId(selection,id);
    // A cached successful observation must not let a removed key authorize a
    // later poll or download. The network wrapper reacquires again at actual I/O.
    await credential(context);
    return await cache.get(id,context) as unknown as ConfiguredVideoTask;
  };
  return {
    id:frozen.providerId,capabilities,validate,
    async submit(snapshot: unknown,registered: RegisteredContext={}){
      validate(snapshot);const value=record(snapshot)!;const context=contextOf(registered);
      if(registered.providerRegion!==undefined&&registered.providerRegion!==frozen.region)throw providerError('PROVIDER_REGION_CHANGED','The task region differs from its frozen connection.');
      const references=value.referenceAssets as Array<ProviderReferenceAsset&{sizeBytes:number;role?:string}>;
      const approvedHashes=new Set(references.map(asset=>String(asset.sha256).toLowerCase()));
      const images=[];
      for(const asset of references){
        const image=asset.mimeType==='image/webp'?await managedWebp(root,asset,template.maxImageBytes,context):await managedImage({root,asset,approvedHashes,maxBytes:template.maxImageBytes,signal:context.signal,validateCurrent:context.validateReferenceState});
        if(isWan30Binding(frozen))validateWanImageBytes(image.bytes,image.mimeType);
        if(image.width!==asset.width||image.height!==asset.height||image.bytes.length!==asset.sizeBytes)throw providerError('REFERENCE_CHANGED','Actual reference bytes differ from the frozen metadata.');
        if(frozen.providerId==='runway'&&Buffer.byteLength(`data:${image.mimeType};base64,${image.base64}`)>5*1024*1024)throw providerError('REFERENCE_TOO_LARGE','Encoded reference exceeds the Runway data URI limit.');
        images.push({mimeType:image.mimeType,base64:image.base64,role:asset.role??'first_frame'});
      }
      const parameters=(value.parameters??{}) as Record<string,unknown>,effective=effectiveVideoParameters(frozen,value),duration=effective.durationSeconds as number;
      const resolution=effective.resolution as string;
      const input:VideoAdapterInput={prompt:effective.prompt as string,aspectRatio:effective.aspectRatio as string,duration,parameters:{...parameters,resolution},images,subjectReference:Object.hasOwn(value,'subjectReference')};
      const requestId=registered.requestId;
      if(frozen.providerId==='kling'&&(typeof requestId!=='string'||!requestId||requestId.length>200))throw providerError('INVALID_REQUEST_ID','A stable request ID is required before creating a Kling task.');
      if(wan)return {providerJobId:await wan.submit(input,context)};
      if(sdk)return {providerJobId:configuredSubmissionId(selection,await sdk.submit(input,context))};
      const submission=configuredSubmission({...selection,resolution},input,requestId??'');
      return {providerJobId:configuredSubmissionId(selection,await request(submission.path,{method:'POST',body:submission.body,raw:submission.raw,headers:submission.headers,context}))};
    },
    async poll(id: string,registered: RegisteredContext={}){
      const task=await retrieve(id,contextOf(registered));
      return task.status==='failed'?{status:'failed',error:{code:'PROVIDER_GENERATION_FAILED',message:'The provider generation failed. Review the existing task before retrying.'}}:{status:task.status,progress:task.status==='succeeded'?1:task.progress??0};
    },
    async reconcile(requestId: string,registered: RegisteredContext={}){
      if(frozen.providerId!=='kling')return null;
      if(typeof requestId!=='string'||!requestId||requestId.length>200)throw providerError('INVALID_REQUEST_ID','The reconciliation request identity is invalid.');
      const task=configuredKlingTask(await request(`/tasks?external_task_ids=${encodeURIComponent(requestId)}`,{context:contextOf(registered)}),selection,{externalId:requestId});
      return task?{providerJobId:task.id}:null;
    },
    async download(id: string,destination: string,registered: RegisteredContext={}){
      ensureHosts();const context=contextOf(registered),task=await retrieve(id,context);
      if(task.status!=='succeeded')throw providerError('PROVIDER_NOT_READY','The existing provider task has no completed output.',{retryable:true});
      let url:URL,headers:Record<string,string>|undefined;
      // The OpenAI shape streams the result from the service's own authenticated
      // /content route; a redirect may only reach a declared output host.
      if(compatible){url=new URL(`${frozen.endpoint}/videos/${encodeURIComponent(id)}/content`);headers={Authorization:`Bearer ${await credential(context)}`};}
      else url=outputUrl(task.url,hosts);
      if(frozen.providerId==='veo'&&url.origin==='https://generativelanguage.googleapis.com'){
        if(!/^\/v1beta\/files\/[A-Za-z0-9_-]{1,200}:download$/.test(url.pathname))throw providerError('UNAPPROVED_OUTPUT_HOST','Veo authenticated downloads must use its official file route.');
        url=new URL(url.pathname+'?alt=media',url.origin);headers={'x-goog-api-key':await credential(context)};
      }
      const allowRedirect=frozen.providerId==='veo'||compatible?(location:string|null,current:URL)=>{if(!location)throw providerError('INVALID_OUTPUT_URL','The output redirect has no destination.');let next:URL;try{next=new URL(location,current);}catch{throw providerError('INVALID_OUTPUT_URL','The output redirect is invalid.');}return outputUrl(next.href,hosts);}:undefined;
      let credentialFailure:unknown;
      const boundDownloadFetch:typeof fetch=async(input,init)=>{
        let secret:string;
        try{secret=await credential(context);}catch(error){credentialFailure=error;throw error;}
        // The shared downloader drops authentication on every redirect. Refresh
        // only its initial authenticated file request; never add a key to a CDN.
        const currentHeaders=new Headers(init?.headers);
        if(compatible&&currentHeaders.has('authorization'))return transport(input,{...init,headers:{...Object.fromEntries(currentHeaders),authorization:`Bearer ${secret}`}});
        return transport(input,frozen.providerId==='veo'&&currentHeaders.has('x-goog-api-key')?{...init,headers:{...Object.fromEntries(currentHeaders),'x-goog-api-key':secret}}:init);
      };
      let initial=true;
      const downloadFetch:typeof fetch=async(input,init)=>{
        const first=initial;initial=false;
        // Only the initial authenticated resource request uses the SDK. The
        // managed downloader owns every redirect and has permanently removed
        // authentication before a later hop, including a return to this API.
        if(first&&compatibleSdk){
          if(String(input)!==url.href||init?.method!=='GET')throw providerError('VIDEO_SDK_REQUEST_INVALID','The initial video download request changed.');
          return compatibleSdk.downloadContent(id,{fetchImpl:boundDownloadFetch,signal:init.signal??undefined,headers:init.headers});
        }
        return boundDownloadFetch(input,init);
      };
      try{return await downloadMp4({root,destination,url,headers,fetchImpl:downloadFetch,context,allowRedirect,invalidate:()=>cache.invalidate(id)});}
      catch(error){
        // Network failures are sanitized by downloadMp4. Preserve a failure of
        // our own binding check so the worker pauses this exact accepted task.
        if(credentialFailure!==undefined)throw credentialFailure;
        throw error;
      }
    },
    async cancel(){return {cancelled:false,remoteCancelled:false,scope:'local',reason:'Only local waiting was stopped; provider generation and charges may continue.'};},
  };
}

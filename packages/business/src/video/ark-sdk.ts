import {ArkRuntimeClient} from '@volcengine/ark-runtime';
import type {ClientConfig} from '@volcengine/ark-runtime';
import axios from 'axios';
import {providerError} from '../providers/live-common.ts';
import type {ProviderContext} from '../providers/live-common.ts';
import type {VideoAdapterInput} from './adapters.ts';
import {invokeVideoSdk} from './sdk-transport.ts';
import type {VideoSdkSend} from './sdk-transport.ts';

const TASK_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
/** audio is the saved model entry's mode: 'optional' follows the request's
 * generateAudio, 'on' always asks for sound, and anything else stays silent. */
export interface ArkSdkClientOptions {api:string;model:string;send:VideoSdkSend;audio?:'default'|'off'|'on'|'optional'}

/** A fresh SDK and Axios adapter belong to one operation. The official SDK owns
 * routes and JSON serialization; the bounded application transport owns all I/O
 * and credentials, including the last synchronous submit fence. */
export function createArkSdkClient({api,model,send,audio='off'}:ArkSdkClientOptions) {
  function invoke(method:'POST'|'GET',context:ProviderContext,call:(sdk:ArkRuntimeClient)=>Promise<unknown>) {
    return invokeVideoSdk({api,method,context,send},fetch=>{
      // Axios exposes distinct CJS/ESM type identities. Ark's public declaration
      // uses CJS, while this module imports ESM; both resolve to the same pinned
      // Axios implementation and the adapter returns its complete response.
      const httpClient=axios.create({adapter:async config=>{
        const headers=new Headers();
        for(const [name,value] of Object.entries(config.headers.toJSON()))if(value!==undefined&&value!==null)headers.set(name,String(value));
        const response=await fetch(config.url!,{method:config.method?.toUpperCase(),headers,...(config.data===undefined?{}:{body:config.data}),signal:context.signal});
        return {data:await response.json(),status:response.status,statusText:response.statusText,headers:Object.fromEntries(response.headers),config};
      }}) as NonNullable<ClientConfig['httpClient']>;
      // Explicit placeholders prevent ambient Ark settings from changing the
      // frozen task account or endpoint. The real key is acquired only by send.
      const sdk=new ArkRuntimeClient({apiKey:'mioon-bound-transport',ak:'',sk:'',baseURL:api,region:'cn-beijing',httpClient,retryTimes:0,timeout:30_000});
      return call(sdk);
    });
  }
  return {
    async submit(input:VideoAdapterInput,context:ProviderContext={}):Promise<Record<string,unknown>> {
      const parameters=input.parameters;
      // Duration and ratio arrive already resolved in input; a copy in the
      // parameters must agree with them. generateAudio is valid only when the
      // saved model lets the user choose.
      if(Object.keys(parameters).some(key=>!['resolution','generateAudio','durationSeconds','aspectRatio'].includes(key))||
        parameters.generateAudio!==undefined&&(audio!=='optional'||typeof parameters.generateAudio!=='boolean')||
        parameters.durationSeconds!==undefined&&parameters.durationSeconds!==input.duration||parameters.aspectRatio!==undefined&&parameters.aspectRatio!==input.aspectRatio)throw providerError('UNSUPPORTED_PARAMETER','Seedance accepts only its advertised video parameters.');
      if(!Number.isInteger(input.duration)||input.duration!==-1&&(input.duration<4||input.duration>30))throw providerError('UNSUPPORTED_PARAMETER','Seedance duration must be 4–30 seconds or automatic.');
      const roles=input.images.map(image=>image.role),subject=input.subjectReference;
      const frames=roles.length===0||roles.length===1&&roles[0]==='first_frame'||roles.length===2&&roles[0]==='first_frame'&&roles[1]==='last_frame';
      if(subject?roles.length!==1||!['subject_reference','reference_image'].includes(roles[0]!):!frames)throw providerError('UNSUPPORTED_INPUT_ROLE','Seedance requires an advertised frame or subject image combination.');
      // Ark keeps a frame task's output ratio equal to its first frame and
      // accepts only adaptive there.
      return invoke('POST',context,sdk=>sdk.createContentGenerationTask({
        model,content:[{type:'text',text:input.prompt},...input.images.map(image=>({type:'image_url' as const,image_url:{url:`data:${image.mimeType};base64,${image.base64}`},role:subject?'reference_image':image.role}))],
        duration:input.duration,ratio:!subject&&roles.length?'adaptive':input.aspectRatio,
        ...(subject?{omni_reference_task_type:'reference'}:{}),resolution:String(parameters.resolution??'720p'),output_format:'mp4',
        generate_audio:audio==='on'||audio==='optional'&&parameters.generateAudio===true,
      },{signal:context.signal}));
    },
    async retrieve(id:string,context:ProviderContext={}):Promise<Record<string,unknown>> {
      if(typeof id!=='string'||!TASK_ID.test(id))throw providerError('INVALID_PROVIDER_TASK_ID','Seedance task ID is invalid.');
      return invoke('GET',context,sdk=>sdk.getContentGenerationTask(id,{signal:context.signal}));
    },
  };
}

import RunwayML from '@runwayml/sdk';
import {providerError} from '../providers/live-common.ts';
import type {ProviderContext} from '../providers/live-common.ts';
import type {VideoAdapterInput} from './adapters.ts';
import {invokeVideoSdk} from './sdk-transport.ts';
import type {VideoSdkSend} from './sdk-transport.ts';

const VERSION='2024-11-06';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RATIOS={'9:16':'720:1280','16:9':'1280:720','1:1':'960:960','3:4':'832:1104','4:3':'1104:832','21:9':'1584:672'} as const;
type CreateParameters=Parameters<RunwayML['imageToVideo']['create']>[0];
export interface RunwaySdkClientOptions {api:string;send:VideoSdkSend;model?:string}

/** Keep the SDK responsible for its routes and serialization. Every operation
 * receives its own client; only the bound transport ever sees a real key. */
export function createRunwaySdkClient({api,send,model='gen4_turbo'}: RunwaySdkClientOptions) {
  const invoke=(method:'POST'|'GET',context:ProviderContext,call:(sdk:RunwayML)=>Promise<unknown>)=>
    invokeVideoSdk({api,method,context,send,allowedHeaders:['x-runway-version']},async fetch=>{
      const sdk=new RunwayML({apiKey:'mioon-bound-transport',baseURL:api,runwayVersion:VERSION,maxRetries:0,timeout:30_000,logLevel:'off',fetch});
      return call(sdk);
    });
  const options=(context:ProviderContext)=>({maxRetries:0,timeout:30_000,signal:context.signal,headers:{'X-Runway-Version':VERSION}});
  return {
    async submit(input:VideoAdapterInput,context:ProviderContext={}):Promise<Record<string,unknown>> {
      const ratio=RATIOS[input.aspectRatio as keyof typeof RATIOS],image=input.images[0];
      if(!ratio)throw providerError('UNSUPPORTED_CAPABILITY','Runway requires an advertised output ratio.');
      if(input.subjectReference||input.images.length!==1||image?.role!=='first_frame')throw providerError('UNSUPPORTED_INPUT_ROLE','Runway accepts exactly one first-frame image.');
      if(Object.keys(input.parameters).some(key=>key!=='seed'&&key!=='resolution'))throw providerError('UNSUPPORTED_PARAMETER','Runway accepts only its advertised video parameters.');
      // A custom ID remains limited by its selected Gen-4 Turbo template. This
      // assertion adapts that already validated ID to the SDK's closed ID union.
      const body:CreateParameters={model:model as 'gen4_turbo',promptImage:`data:${image.mimeType};base64,${image.base64}`,promptText:input.prompt,ratio,duration:input.duration,...(input.parameters.seed===undefined?{}:{seed:input.parameters.seed as number})};
      return invoke('POST',context,async sdk=>sdk.imageToVideo.create(body,options(context)));
    },
    async retrieve(id:string,context:ProviderContext={}):Promise<Record<string,unknown>> {
      if(typeof id!=='string'||!UUID.test(id))throw providerError('INVALID_PROVIDER_TASK_ID','Runway task ID is invalid.');
      return invoke('GET',context,async sdk=>sdk.tasks.retrieve(id,options(context)));
    },
  };
}

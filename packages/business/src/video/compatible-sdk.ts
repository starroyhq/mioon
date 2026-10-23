import OpenAI from 'openai';
import {providerError} from '../providers/live-common.ts';
import type {ProviderContext} from '../providers/live-common.ts';
import {compatibleVideoSize} from './adapters.ts';
import type {VideoAdapterInput} from './adapters.ts';
import {invokeVideoSdk} from './sdk-transport.ts';
import type {VideoSdkSend} from './sdk-transport.ts';

export function createCompatibleVideoSdkClient({api,model,send}:{api:string;model:string;send:VideoSdkSend}){
  function client(fetch:typeof globalThis.fetch){return new OpenAI({baseURL:api,apiKey:'mioon-bound-transport',adminAPIKey:null,organization:null,project:null,maxRetries:0,timeout:30000,logLevel:'off',fetch});}
  return {
    submit(input:VideoAdapterInput,context:ProviderContext={}){
      if(input.subjectReference||input.images.length>1||input.images.some(image=>image.role!=='first_frame'))throw providerError('UNSUPPORTED_INPUT_ROLE','This video protocol supports one first-frame image.');
      if(Object.keys(input.parameters).some(key=>key!=='resolution'))throw providerError('UNSUPPORTED_PARAMETER','This video protocol accepts only its advertised parameters.');
      const first=input.images[0],extension=first?.mimeType==='image/jpeg'?'jpg':first?.mimeType==='image/webp'?'webp':'png';
      // Custom IDs/sizes remain bounded by the selected local protocol template;
      // the SDK's types enumerate only OpenAI's catalog, not compatible services.
      const options={model,prompt:input.prompt,seconds:String(input.duration),size:compatibleVideoSize(input.aspectRatio,String(input.parameters.resolution)),...(first?{input_reference:new File([Buffer.from(first.base64,'base64')],`reference.${extension}`,{type:first.mimeType})}:{})} as OpenAI.Videos.VideoCreateParams;
      return invokeVideoSdk({api,method:'POST',context,send},fetch=>client(fetch).videos.create(options,{signal:context.signal}));
    },
    retrieve(id:string,context:ProviderContext={}){
      return invokeVideoSdk({api,method:'GET',context,send},fetch=>client(fetch).videos.retrieve(id,{signal:context.signal}));
    },
  };
}

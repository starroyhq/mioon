import {GoogleGenAI,GenerateVideosOperation} from '@google/genai';
import {providerError} from '../providers/live-common.ts';
import type {ProviderContext} from '../providers/live-common.ts';
import type {VideoAdapterInput} from './adapters.ts';
import {invokeVideoSdk} from './sdk-transport.ts';
import type {VideoSdkSend} from './sdk-transport.ts';

interface VeoSdkClientOptions {api:string;model:string;send:VideoSdkSend}
const API='https://generativelanguage.googleapis.com/v1beta';
const MODEL=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
// Legacy Gemini tasks admitted a base64url-style suffix, including '-'/'_' as
// the first character. The configured runtime keeps its own stricter validator.
const OPERATION=/^models\/[A-Za-z0-9][A-Za-z0-9._:-]{0,99}\/operations\/[A-Za-z0-9_-]{1,200}$/;

/** The Gemini Developer API SDK constructs both submit and operation queries.
 * Return the bounded transport's raw operation: stored tasks and existing
 * parsers use generateVideoResponse.generatedSamples, whereas the SDK converts
 * it to response.generatedVideos. No task identity or snapshot is rewritten. */
export function createVeoSdkClient({api,model,send}:VeoSdkClientOptions) {
  if(api!==API)throw providerError('VIDEO_BINDING_INVALID','The Veo SDK requires the official Gemini Developer API endpoint.');
  if(!MODEL.test(model))throw providerError('UNSUPPORTED_MODEL','The Veo model identity is invalid.');
  function invoke(method:'POST'|'GET',context:ProviderContext,run:(sdk:GoogleGenAI)=>Promise<unknown>) {
    return invokeVideoSdk({api,method,context,send},fetch=>run(new GoogleGenAI({
      // Explicit values exclude ambient Vertex/Enterprise flags, keys and URLs.
      // The real key is acquired only by send at the project dispatch boundary.
      apiKey:'mioon-bound-transport',vertexai:false,enterprise:false,
      httpOptions:{baseUrl:new URL(api).origin,apiVersion:'v1beta',fetch,retryOptions:{attempts:1}},
    })));
  }
  return {
    async submit(input:VideoAdapterInput,context:ProviderContext={}) {
      if(Object.keys(input.parameters).some(key=>key!=='resolution'))throw providerError('UNSUPPORTED_PARAMETER','The Veo SDK accepts only advertised video parameters.');
      if(input.subjectReference||input.images.length>1||input.images.some(image=>image.role!=='first_frame'))throw providerError('UNSUPPORTED_INPUT_ROLE','The Veo SDK supports only text or a single first frame.');
      const first=input.images[0];
      return invoke('POST',context,sdk=>sdk.models.generateVideos({model,source:{prompt:input.prompt,...(first?{image:{imageBytes:first.base64,mimeType:first.mimeType}}:{})},config:{numberOfVideos:1,aspectRatio:input.aspectRatio,durationSeconds:input.duration,resolution:input.parameters.resolution as string}}));
    },
    async retrieve(id:string,context:ProviderContext={}) {
      if(!OPERATION.test(id)||!id.startsWith(`models/${model}/operations/`))throw providerError('INVALID_PROVIDER_TASK_ID','The Veo operation identity is invalid.');
      const operation=new GenerateVideosOperation();operation.name=id;
      return invoke('GET',context,sdk=>sdk.operations.getVideosOperation({operation}));
    },
  };
}

import {MiniMaxSDK} from 'mmx-cli/sdk';
import type {MiniMaxSDKOptions,RequestOpts,VideoV2Duration,VideoV2Ratio} from 'mmx-cli/sdk';
import {providerError} from '../providers/live-common.ts';
import type {ProviderContext} from '../providers/live-common.ts';
import type {VideoAdapterInput} from './adapters.ts';
import {invokeVideoSdk} from './sdk-transport.ts';
import type {VideoSdkSend} from './sdk-transport.ts';

const REGIONS={global:'https://api.minimax.io',cn:'https://api.minimax.cn'} as const;
const TASK_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
type VideoSdk=MiniMaxSDK['video'];
type VideoSdkConstructor=new(options:MiniMaxSDKOptions)=>VideoSdk;
let videoSdkConstructor:VideoSdkConstructor|undefined;

function boundVideoSdk(options:Required<MiniMaxSDKOptions>,fetch:typeof globalThis.fetch,context:ProviderContext):VideoSdk {
  // VideoSDK is not separately exported. Obtain its constructor through the
  // documented public instance, retaining its complete protected type contract.
  // Resolution is lazy: provider construction never reads the CLI config.
  const Constructor=videoSdkConstructor??=new MiniMaxSDK(options).video.constructor as VideoSdkConstructor;
  class BoundVideoSdk extends Constructor {
    constructor() {
      super(options);
      // The SDK unconditionally reads its CLI config in super(). Its public
      // options cannot disable that read, so replace every derived setting and
      // bypass its HTTP/auth/logging layer at the protected requestJson seam.
      // Local credentials, OAuth, environment URLs and verbosity never dispatch.
      this.config={apiKey:options.apiKey,region:options.region,baseUrl:options.baseUrl,output:'json',timeout:30,verbose:false,quiet:true,noColor:true,yes:false,dryRun:false,nonInteractive:true,async:true,needsRegionDetection:false};
    }
    protected override async requestJson<T>(request:RequestOpts):Promise<T> {
      const response=await fetch(request.url,{method:request.method??'GET',headers:{'Content-Type':'application/json'},...(request.body===undefined?{}:{body:JSON.stringify(request.body)}),signal:context.signal});
      return await response.json() as T;
    }
  }
  return new BoundVideoSdk();
}

/** Official H3 SDK validation/builders, with one bounded project dispatch. The
 * SDK's blocking polling, download and implicit CLI credential paths are unused. */
export function createMinimaxSdkClient({api,model,send}:{api:string;model:string;send:VideoSdkSend}) {
  const region=api===REGIONS.global?'global':api===REGIONS.cn?'cn':null;
  if(region===null)throw providerError('VIDEO_BINDING_INVALID','The MiniMax SDK requires a bound official regional endpoint.');
  const options:Required<MiniMaxSDKOptions>={apiKey:'mioon-bound-transport',region,baseUrl:api};
  function invoke(method:'POST'|'GET',context:ProviderContext,call:(sdk:VideoSdk)=>Promise<unknown>) {
    return invokeVideoSdk({api,method,context,send},fetch=>call(boundVideoSdk(options,fetch,context)));
  }
  return {
    async submit(input:VideoAdapterInput,context:ProviderContext={}):Promise<Record<string,unknown>> {
      if(model!=='MiniMax-H3')throw providerError('UNSUPPORTED_MODEL','The official MiniMax SDK supports only MiniMax-H3 for new submissions. Historical tasks can still be queried.',{beforeDispatch:true});
      if(Object.keys(input.parameters).some(key=>key!=='resolution'))throw providerError('UNSUPPORTED_PARAMETER','MiniMax accepts only its advertised video parameters.');
      if(input.parameters.resolution!=='2K')throw providerError('UNSUPPORTED_PARAMETERS','The official MiniMax H3 SDK requires 2K resolution. The original task snapshot was not changed.',{beforeDispatch:true});
      if(input.subjectReference||input.images.length>1||input.images.some(image=>image.role!=='first_frame'))throw providerError('UNSUPPORTED_INPUT_ROLE','The implemented MiniMax protocol accepts text or one first-frame image.');
      const first=input.images[0];
      return invoke('POST',context,sdk=>sdk.generate({model:model as 'MiniMax-H3',content:[{type:'text',text:input.prompt},...(first?[{type:'image_url' as const,image_url:{url:`data:${first.mimeType};base64,${first.base64}`},role:'first_frame' as const}]:[])],duration:input.duration as VideoV2Duration,resolution:'2K',ratio:(first?'adaptive':input.aspectRatio) as VideoV2Ratio,async:true}));
    },
    async retrieve(id:string,context:ProviderContext={}):Promise<Record<string,unknown>> {
      if(typeof id!=='string'||!TASK_ID.test(id))throw providerError('INVALID_PROVIDER_TASK_ID','MiniMax task ID is invalid.');
      // The template identifies V2, including historical custom-model entries.
      // Selecting the SDK's V2 query never replaces a stored task/model identity.
      return invoke('GET',context,sdk=>sdk.getTask({taskId:id,model:'MiniMax-H3'}));
    },
  };
}

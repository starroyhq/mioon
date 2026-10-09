import {createMockProvider} from './providers/mock.mjs';
import {createRunwayProvider} from './providers/runway.mjs';
import {createArkProvider} from './providers/ark.mjs';
import {createVeoProvider} from './providers/veo.mjs';
import {createMinimaxProvider} from './providers/minimax.mjs';
import {createViduProvider} from './providers/vidu.mjs';

export const providerSettings = Object.freeze({
 runway:{credential:'RUNWAYML_API_SECRET',prefix:'RUNWAY'},
 ark:{credential:'ARK_API_KEY',prefix:'ARK'},
 veo:{credential:'GEMINI_API_KEY',prefix:'VEO'},
 minimax:{credential:'MINIMAX_API_KEY',prefix:'MINIMAX'},
 vidu:{credential:'VIDU_API_KEY',prefix:'VIDU'},
});
export const providerEnvironmentKeys=Object.freeze(['MINIMAX_REGION','VIDU_REGION','MIOON_ENABLE_LIVE_PROVIDER',...Object.values(providerSettings).flatMap(({credential,prefix})=>[credential,`${prefix}_APPROVED_ASSET_SHA256`,`${prefix}_OUTPUT_HOSTS`,`${prefix}_MAX_GENERATIONS`])]);

export function generationLimit(providerId,env=process.env){
 const settings=providerSettings[providerId];
 if(!settings)return null;
 const raw=env[`${settings.prefix}_MAX_GENERATIONS`]||'';
 const value=/^[1-9]\d*$/.test(raw)?Number(raw):0;
 return Number.isSafeInteger(value)?value:0;
}
export function normalizedCapabilities(provider,env=process.env,used=0){
 const c=provider.capabilities,settings=providerSettings[provider.id],inputModes=c.inputModes||['image'];
 const modelCapabilities=c.modelCapabilities||c.models.map(model=>({
  id:typeof model==='string'?model:model.id,name:typeof model==='string'?model:model.name,
  inputModes,aspectRatios:c.aspectRatios,durations:c.durations,
  referenceImages:{min:inputModes.includes('text')?0:1,max:c.maxReferenceImages??1},
  ...(c.mock?{parameters:['scenario','delayMs','seed']}:{parameters:['seed'],seed:{min:0,max:4294967295},promptRequired:true,maxPromptLength:1000}),
 }));
 const limit=generationLimit(provider.id,env);
 const configured=Boolean(c.configured);
 const missing=settings?[...(c.configuration?.missing||(!configured?[settings.credential]:[])),...(!limit?[`${settings.prefix}_MAX_GENERATIONS`]:[])]:[];
 const enabled=Boolean(c.enabled)&&(!settings||Boolean(limit)&&used<limit);
 const status=!configured?'not_configured':enabled?'available':'disabled';
 return {...c,id:provider.id,inputModes,modelCapabilities,configured,enabled,status,liveVerified:c.mock?false:Boolean(c.liveVerified),
  configuration:{...(c.configuration||{}),missing:[...new Set([...(c.configuration?.missing||[]),...missing])],requirements:settings?[
   'MIOON_ENABLE_LIVE_PROVIDER=1：在后端明确启用真实调用',
   `${settings.prefix}_MAX_GENERATIONS：当前数据目录的授权生成次数上限`,
   `${settings.prefix}_APPROVED_ASSET_SHA256：图生视频仅发送已授权参考图`,
   ...(c.region?[`${settings.prefix}_REGION=global|cn：必须与密钥账户区域一致，不会跨区回退`]:[]),
   ...(provider.id==='vidu'?['VIDU_OUTPUT_HOSTS：必填，仅允许独立核实的精确输出域名']:[]),
   '提交前另行确认服务商、模型、提示词和素材范围、次数及总金额上限；次数限制不等于金额限制。',
  ]:[]},...(settings?{budget:{maxGenerations:limit,usedGenerations:used,remainingGenerations:Math.max(0,limit-used),scope:'local-data-directory'}}:{})};
}
export function createProviderRegistry({db,root,env=process.env}){
 return new Map([createMockProvider({db,root}),createRunwayProvider({root,env}),createArkProvider({root,env}),createVeoProvider({root,env}),createMinimaxProvider({root,env}),createViduProvider({root,env})].map(provider=>[provider.id,provider]));
}

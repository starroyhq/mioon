import {AppError,INPUT_PROFILE_VERSION,getCapabilityProfile,getGenerationProfileRegion,evaluateCapabilityLifecycle} from '@mioon/contracts';
import {createMockProvider,createMockProviderCapabilities} from './providers/mock.ts';
import {createRunwayProvider} from './providers/runway.ts';
import {createArkProvider} from './providers/ark.ts';
import {createVeoProvider} from './providers/veo.ts';
import {createMinimaxProvider} from './providers/minimax.ts';
import {createViduProvider} from './providers/vidu.ts';
import {providerSettings} from './providers/environment.ts';
import type {DatabaseSync} from 'node:sqlite';

export {providerEnvironmentKeys,providerSettings} from './providers/environment.ts';

/** Signed-in/embedded adapter contract consumed by the backend services. Methods
 * are declared with method syntax so adapter implementations stay assignable
 * under strictFunctionTypes without erasing their own input narrowing. */
export interface ProviderContext {
  readonly requestId?: string;
  readonly jobId?: string;
  readonly providerRegion?: unknown;
  readonly signal?: AbortSignal | null;
  readonly beforeSubmit?: () => void;
  readonly [key: string]: unknown;
}
export interface ProviderSubmission {
  readonly providerJobId?: string;
  readonly [key: string]: unknown;
}
export interface ProviderPollResult {
  readonly status: string;
  readonly progress?: number;
  readonly error?: unknown;
  readonly [key: string]: unknown;
}
export interface ProviderModelCapability {
  readonly id: string;
  readonly name: string;
  readonly inputModes?: readonly string[];
  readonly aspectRatios?: readonly string[];
  readonly durations?: readonly number[];
  readonly referenceImages?: Readonly<{min: number; max: number}>;
  readonly parameters?: readonly string[];
  readonly seed?: Readonly<{min: number; max: number}>;
  readonly promptRequired?: boolean;
  readonly maxPromptLength?: number;
  readonly [key: string]: unknown;
}
export interface ProviderConfiguration {
  readonly missing?: readonly string[];
  readonly requirements?: readonly string[];
  readonly [key: string]: unknown;
}
export interface ProviderCapabilities {
  readonly id?: string;
  readonly name?: string;
  readonly models: readonly (string | Readonly<{id: string; name: string; [key: string]: unknown}>)[];
  readonly modelCapabilities?: readonly ProviderModelCapability[];
  readonly inputModes?: readonly string[];
  readonly aspectRatios?: readonly string[];
  readonly durations?: readonly number[];
  readonly maxReferenceImages?: number;
  readonly mock?: boolean;
  readonly configured?: boolean;
  readonly enabled?: boolean;
  readonly region?: string;
  readonly liveVerified?: boolean;
  readonly minPollIntervalMs?: number;
  readonly configuration?: ProviderConfiguration;
  readonly [key: string]: unknown;
}
export interface Provider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  validate?(snapshot: unknown): unknown;
  submit(snapshot: unknown, context: ProviderContext): Promise<ProviderSubmission | unknown>;
  reconcile(requestId: string, context: ProviderContext): Promise<ProviderSubmission | null | undefined>;
  poll(providerJobId: string, context: ProviderContext): Promise<ProviderPollResult>;
  download(providerJobId: string, destination: string, context: ProviderContext): Promise<unknown>;
  cancel?(providerJobId: string, context: ProviderContext): Promise<unknown>;
}
export type ProviderMetadata=Pick<Provider,'id'|'capabilities'>;
export const isMockGenerationProvider=({id,capabilities}:ProviderMetadata):boolean=>id==='mock'||capabilities.mock===true;
export const GENERATION_SERVICE_UNAVAILABLE='GENERATION_SERVICE_UNAVAILABLE';
export function generationServiceUnavailable():AppError {
 return new AppError(GENERATION_SERVICE_UNAVAILABLE,'暂没有可用的服务，请先在设置里配置并启用生成服务。',409,{mutationOutcome:'not_applied'});
}
type CapabilityProfile=NonNullable<ReturnType<typeof getCapabilityProfile>>;

type ProviderSettingsKey=keyof typeof providerSettings;
const providerSetting=(id: string) =>
 Object.hasOwn(providerSettings,id)?providerSettings[id as ProviderSettingsKey]:undefined;
// Only the production registry opts into the reviewed profile policy. Trusted
// embedded adapters keep the legacy extension contract; request DTOs cannot
// opt a production registry out, including after a provider handle is replaced.
const profileRegistries=new WeakSet<object>(),profileProviders=new WeakSet<object>();
const handle=(value: unknown): object | null => (typeof value==='object'||typeof value==='function')&&value!==null?value:null;
export function usesInputProfiles(value: unknown): boolean {
 const registered=handle(value);
 if(!registered)return false;
 if(profileRegistries.has(registered)||profileProviders.has(registered))return true;
 // Native Map brand checking never probes an unknown object's properties,
 // descriptors, prototype or Proxy traps. Copies can retain known handles.
 let providers: MapIterator<unknown>;try{providers=Map.prototype.values.call(registered) as MapIterator<unknown>;}catch{return false;}
 for(const provider of providers){const registeredProvider=handle(provider);if(registeredProvider&&profileProviders.has(registeredProvider))return true;}
 return false;
}
// Trusted server composition only: a known source handle grants its wrapper
// the same policy. Serialized capabilities and guessed IDs cannot grant it.
export function registerInputProfileWrapper<T>(wrapper: T,source: unknown): T {
 const registeredSource=handle(source),registeredWrapper=handle(wrapper);
 if(!registeredSource||!profileProviders.has(registeredSource)||!registeredWrapper)throw new TypeError('A registered provider source and wrapper object are required.');
 profileProviders.add(registeredWrapper);return wrapper;
}
export const profileDate=()=>new Date().toISOString().slice(0,10);
// Keep the previous argument positions for embedded callers; readiness no
// longer depends on environment count limits or historical job totals.
export function normalizedCapabilities(provider: ProviderMetadata,_env: NodeJS.ProcessEnv=process.env,_used=0,{asOf=profileDate(),requireInputProfiles=usesInputProfiles(provider)}: {asOf?: string; requireInputProfiles?: boolean}={}) {
 const c=provider.capabilities,settings=providerSetting(provider.id),inputModes=c.inputModes||['image'];
 const modelCapabilities: readonly ProviderModelCapability[]=c.modelCapabilities||c.models.map(model=>({
  id:typeof model==='string'?model:model.id,name:typeof model==='string'?model:model.name,
  inputModes,aspectRatios:c.aspectRatios,durations:c.durations,
  referenceImages:{min:inputModes.includes('text')?0:1,max:c.maxReferenceImages??1},
  ...(c.mock?{parameters:['scenario','delayMs','seed']}:{parameters:['seed'],seed:{min:0,max:4294967295},promptRequired:true,maxPromptLength:1000}),
 }));
 const configured=Boolean(c.configured);
 const missing=c.configuration?.missing??(settings&&!configured?[settings.credential]:[]);
 const enabled=Boolean(c.enabled);
 const status=!configured?'not_configured':enabled?'available':'disabled';
 const providerRegion=getGenerationProfileRegion(provider.id,c);
 const inputProfiles=(requireInputProfiles?c.models.map(model=>getCapabilityProfile(provider.id,typeof model==='string'?model:model.id,providerRegion)):[]).filter((profile): profile is CapabilityProfile=>profile!==null);
 const profiles=requireInputProfiles?{inputProfileVersion:INPUT_PROFILE_VERSION,profileEvaluationDate:asOf,providerRegion,
  inputProfiles,inputProfileEvaluations:inputProfiles.map(profile=>({profileId:profile.profileId,...evaluateCapabilityLifecycle(profile,{asOf})}))}:{};
 // Discovery must not imply enforcement for an unregistered embedded adapter.
 // Reserve these fields for this boundary's canonical, registered evaluation.
 const publicCapabilities: Record<string, unknown>={...c};
 for(const key of ['inputProfiles','inputProfileVersion','providerRegion','profileEvaluationDate','inputProfileEvaluations'])delete publicCapabilities[key];
 return {...publicCapabilities,...profiles,id:provider.id,inputModes,modelCapabilities,configured,enabled,status,liveVerified:c.mock?false:Boolean(c.liveVerified),
  configuration:{...(c.configuration||{}),missing:[...new Set(missing)],requirements:settings?[
   `${settings.approvedAssetSha256}：图生视频仅发送已授权参考图`,
   ...(c.region?[`${settings.prefix}_REGION=global|cn：必须与密钥账户区域一致，不会跨区回退`]:[]),
   ...(provider.id==='vidu'?[`${settings.outputHosts}：必填，仅允许独立核实的精确输出域名`]:[]),
   '提交前确认服务商、模型、提示词、素材范围与费用；应用不设置生成次数上限，也不提供金额硬上限。',
  ]:[]}};
}
export function createProviderRegistry({db,root,env=process.env}: {db: DatabaseSync; root: string; env?: NodeJS.ProcessEnv}): Map<string, Provider> {
 const adapters: {id: string; provider: Provider}[]=[createMockProvider({db,root}),createRunwayProvider({root,env}),createArkProvider({root,env}),createVeoProvider({root,env}),createMinimaxProvider({root,env}),createViduProvider({root,env})].map(provider=>({id: provider.id, provider: provider as unknown as Provider}));
 const registry=new Map<string, Provider>(adapters.map(entry=>{profileProviders.add(handle(entry.provider) as object);return [entry.id,entry.provider] as const;}));
 profileRegistries.add(registry);return registry;
}

/** Application discovery needs no project connection or Mock ledger. Live
 * factories perform no I/O at construction; retain only their public metadata,
 * never any submit/poll/download methods or their mutable caches. */
export function createProviderCatalog({root,env=process.env,mockAllowed=true}: {root:string;env?:NodeJS.ProcessEnv;mockAllowed?:boolean}) {
 const entries: ProviderMetadata[]=[...(mockAllowed?[{id:'mock',capabilities:createMockProviderCapabilities()}]:[]),
  ...[createRunwayProvider({root,env}),createArkProvider({root,env}),createVeoProvider({root,env}),createMinimaxProvider({root,env}),createViduProvider({root,env})]
   .map(({id,capabilities})=>({id,capabilities}))];
 for(const entry of entries)profileProviders.add(entry);
 return Object.freeze({list:()=>{const asOf=profileDate();return structuredClone(entries.map(entry=>normalizedCapabilities(entry,env,0,{asOf,requireInputProfiles:true})));}});
}

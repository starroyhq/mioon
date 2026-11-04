import {message} from '../../../packages/i18n/src/index.ts';
import type {DisplayMessage,MessageKey,MessageArguments} from '../../../packages/i18n/src/index.ts';
import {AGENT_PROTOCOLS,deriveAgentEndpoint} from '../../../packages/contracts/src/agent-protocol.ts';
import type {AgentProtocol} from '../../../packages/contracts/src/agent-protocol.ts';
import {AGENT_CONNECTION_LIMITS,agentSettingsSnapshotSchema,agentSettingsMetadataSchema,agentSettingsUpdateSchema,agentServiceInput} from '../../../packages/contracts/src/agent-connection-settings.ts';
import type {AgentSettingsSnapshot,AgentServiceInput,AgentServiceSnapshot,AgentMioSelection,AgentSecretAction,AgentSettingsUpdate,AgentExecutionSettings,AgentSettingsBinding} from '../../../packages/contracts/src/agent-connection-settings.ts';
import type {AgentTaskConnectionTest} from '../../../packages/contracts/src/agent-tasks-v2.ts';
import {agentPresetPlatform,resolveAgentPresetBaseUrl,agentCredentialReceiverBinding,isAgentModelIdentifier} from '../../../packages/contracts/src/agent-provider-catalog.ts';
import type {AgentPresetEntry,AgentPresetPlatform} from '../../../packages/contracts/src/agent-provider-catalog.ts';
export {AGENT_PROTOCOLS,deriveAgentEndpoint};
export type {AgentSettingsSnapshot,AgentServiceInput,AgentServiceSnapshot};
export type AgentSettingsPreset=AgentPresetEntry;
export type AgentSettingsPlatform=AgentPresetPlatform;
export type Translate=<K extends MessageKey>(key:K,...args:MessageArguments<K>)=>string;
export type SecretStorage='none'|'session'|'persistent';
export interface AgentConfiguration {presetId:string;platformId:string;baseUrl:string;model:string;protocol:string}
export interface AgentProtocolConfiguration extends AgentConfiguration {protocol:AgentProtocol}
export interface AgentSettingsDraft {services:AgentServiceInput[];mioSelection:AgentMioSelection|null}
export interface AgentServiceIntent {action:'keep'|'remove';storage:'session'|'persistent'}
export type AgentSettingsPhase='loading'|'ready'|'saving'|'reconciling'|'review'|'blocked'|'load_error'|'error'|'saved';
export interface AgentSettingsState {
 phase:AgentSettingsPhase;snapshot:AgentSettingsSnapshot|null;draft:AgentSettingsDraft|null;
 serviceIntents:Record<string,AgentServiceIntent>;selectedKey:string;message:string;displayMessages:DisplayMessage[];recovery:'conflict'|'unknown'|null;
}
export interface AgentSettingsClient {read:()=>Promise<unknown>;write:(input:unknown)=>Promise<unknown>}
export interface AgentSettingsSessionOptions {client?:AgentSettingsClient;onChange?:(state:AgentSettingsState)=>void;newServiceKey?:()=>string}
export interface AgentSettingsSecretSource {read:(serviceKey:string)=>string;clear:()=>void}
const fields=['presetId','platformId','baseUrl','model','protocol'] as const;
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const text=(value:unknown):string=>typeof value==='string'?value:'';
const failure=(code='NETWORK'):Error=>Object.assign(new Error('Agent settings request did not complete.'),{code});
const codes=new Set(['UNAUTHORIZED','AGENT_SETTINGS_VALIDATION','AGENT_SETTINGS_CONFLICT','AGENT_SETTINGS_STORAGE_UNAVAILABLE','AGENT_SETTINGS_SAVE_FAILED','AGENT_SETTINGS_CORRUPT','AGENT_SETTINGS_CLOSED']);
const failureCode=(error:unknown):string|undefined=>record(error)&&typeof error.code==='string'?error.code:undefined;
export const isAgentProtocol=(value:unknown):value is AgentProtocol=>typeof value==='string'&&Object.hasOwn(AGENT_PROTOCOLS,value);
export const agentConfiguration=(value:unknown):AgentConfiguration=>{
 const source=record(value)?value:{};return {presetId:text(source.presetId),platformId:text(source.platformId),baseUrl:text(source.baseUrl),model:text(source.model),protocol:text(source.protocol)};
};
export function agentProtocolConfiguration(value:unknown):AgentProtocolConfiguration|null {
 const configuration=agentConfiguration(value);return isAgentProtocol(configuration.protocol)?{...configuration,protocol:configuration.protocol}:null;
}
export const agentEndpointPreview=(value:AgentConfiguration|null|undefined):string=>{try{const configuration=agentProtocolConfiguration(value);return configuration?deriveAgentEndpoint(configuration):'';}catch{return '';}};
export const agentConfigurationEqual=(left:Partial<AgentConfiguration>|null|undefined,right:Partial<AgentConfiguration>|null|undefined):boolean=>fields.every(key=>left?.[key]===right?.[key]);
/** Legacy diagnostics without the selection/entry witness are history only. */
export function agentDiagnosticMatchesExecution(latest:(AgentTaskConnectionTest&{settingsRevision?:number;settingsBinding?:AgentSettingsBinding})|null,execution:AgentExecutionSettings|null):boolean {
 return Boolean(latest&&execution&&latest.settingsRevision===execution.revision&&latest.settingsBinding?.serviceKey===execution.binding.serviceKey&&latest.settingsBinding?.entryRevision===execution.binding.entryRevision&&latest.settingsBinding?.selectionRevision===execution.binding.selectionRevision&&latest.protocol===execution.configuration.protocol&&latest.model===execution.configuration.model);
}

function sourceUrls(sources:AgentPresetPlatform['sources']):AgentPresetPlatform['sources'] {
 return sources.filter(source=>{try{const url=new URL(source.url);return url.protocol==='https:'&&!url.username&&!url.password;}catch{return false;}});
}
/** Reject an inconsistent collection before exposing it to the form. The only
 * optional display sanitization drops unusable help links, never settings. */
export function safeAgentSettings(value:unknown):AgentSettingsSnapshot {
 const parsed=agentSettingsSnapshotSchema.safeParse(value);if(!parsed.success)throw failure('INVALID_RESPONSE');
 const safe=parsed.data;
 safe.presets=safe.presets.map(preset=>({...preset,platforms:preset.platforms.map(platform=>({...platform,sources:sourceUrls(platform.sources),
  protocols:Object.fromEntries(Object.entries(platform.protocols).map(([protocol,endpoint])=>[protocol,endpoint?{...endpoint,sources:sourceUrls(endpoint.sources)}:endpoint]))}))}));
 return safe;
}
export function agentServiceBase(service:AgentServiceInput,catalog:readonly AgentPresetEntry[]):string {
 const platform=agentPresetPlatform(catalog,service.presetId,service.platformId);
 return resolveAgentPresetBaseUrl(catalog,service.presetId,service.platformId,service.protocol,platform?.addressMode==='fixed'?undefined:service.addressInput);
}
export function agentServiceConfiguration(service:AgentServiceInput,model:string,catalog:readonly AgentPresetEntry[]):AgentProtocolConfiguration|null {
 try{return {presetId:service.presetId,platformId:service.platformId,protocol:service.protocol,baseUrl:agentServiceBase(service,catalog),model};}catch{return null;}
}
export function agentServiceEndpointPreview(service:AgentServiceInput,catalog:readonly AgentPresetEntry[]):string {
 const configuration=agentServiceConfiguration(service,'endpoint-preview',catalog);return agentEndpointPreview(configuration);
}
export function agentServiceBindingChanged(saved:AgentServiceInput|null|undefined,draft:AgentServiceInput|null|undefined,catalog:readonly AgentPresetEntry[]):boolean {
 if(!saved||!draft||saved.serviceKey!==draft.serviceKey)return true;
 try{
  const before=agentServiceConfiguration(saved,'binding-only',catalog),after=agentServiceConfiguration(draft,'binding-only',catalog);
  return !before||!after||agentCredentialReceiverBinding(catalog,before)!==agentCredentialReceiverBinding(catalog,after);
 }catch{return true;}
}
export function agentServiceEqual(left:AgentServiceInput,right:AgentServiceInput,catalog:readonly AgentPresetEntry[]):boolean {
 if(left.serviceKey!==right.serviceKey||left.presetId!==right.presetId||left.platformId!==right.platformId||left.protocol!==right.protocol||left.name.trim()!==right.name.trim()||JSON.stringify(left.manualModelIds)!==JSON.stringify(right.manualModelIds))return false;
 try{return agentServiceBase(left,catalog)===agentServiceBase(right,catalog);}catch{return left.addressInput===right.addressInput;}
}
const draftFrom=(snapshot:AgentSettingsSnapshot):AgentSettingsDraft=>({services:snapshot.services.map(agentServiceInput),mioSelection:snapshot.mioSelection?{...snapshot.mioSelection}:null});
const intentsFrom=(snapshot:AgentSettingsSnapshot):Record<string,AgentServiceIntent>=>Object.fromEntries(snapshot.services.map(service=>[service.serviceKey,{action:'keep' as const,storage:service.secret.storage==='persistent'?'persistent' as const:'session' as const}]));
export const initialAgentSettingsState=():AgentSettingsState=>({phase:'loading',snapshot:null,draft:null,serviceIntents:{},selectedKey:'general',message:'',displayMessages:[],recovery:null});
export const agentSettingsBusy=(state:AgentSettingsState|null|undefined):boolean=>Boolean(state&&['loading','saving','reconciling'].includes(state.phase));
export const agentSettingsEditable=(state:AgentSettingsState|null|undefined):boolean=>Boolean(state?.snapshot)&&!agentSettingsBusy(state);
export const agentSettingsCanSave=(state:AgentSettingsState|null|undefined):boolean=>agentSettingsEditable(state)&&Boolean(state&&!state.recovery&&state.phase!=='blocked');
export const agentSettingsDirty=(state:AgentSettingsState|null|undefined):boolean=>Boolean(state?.snapshot&&state.draft&&(
 JSON.stringify(state.snapshot.mioSelection)!==JSON.stringify(state.draft.mioSelection)||state.snapshot.services.length!==state.draft.services.length||
 state.draft.services.some(service=>{const saved=state.snapshot!.services.find(item=>item.serviceKey===service.serviceKey);return !saved||!agentServiceEqual(saved,service,state.snapshot!.presets);})||
 Object.values(state.serviceIntents).some(intent=>intent.action==='remove')));

export function createAgentSettingsClient({ fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init), timeoutMs = 12000 }: { fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>; timeoutMs?: number } = {}) {
  async function request(method: string, body?: string): Promise<AgentSettingsSnapshot> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const transport = (async () => {
      const response = await fetchImpl('/api/agent/settings', { method, credentials: 'same-origin', cache: 'no-store', signal: abort.signal,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body }) });
      let envelope: unknown;
      try { envelope = await response.json(); } catch { throw failure('INVALID_RESPONSE'); }
      const envelopeRecord = record(envelope) ? envelope : {};
      const errorRecord = record(envelopeRecord.error) ? envelopeRecord.error : {};
      if (!response.ok || envelopeRecord.ok !== true) throw failure(response.status === 401 ? 'UNAUTHORIZED' : codes.has(typeof errorRecord.code === 'string' ? errorRecord.code : '') ? errorRecord.code as string : 'NETWORK');
      return safeAgentSettings(envelopeRecord.data);
    })();
    try {
      return timeoutMs > 0 ? await Promise.race([transport, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(failure('NETWORK')); }, timeoutMs);
      })]) : await transport;
    } catch (error) { const code = failureCode(error); throw failure(code && (codes.has(code) || code === 'INVALID_RESPONSE') ? code : 'NETWORK'); }
    finally { clearTimeout(timer); }
  }
  return { read: () => request('GET'), write: (input: unknown) => request('PUT', JSON.stringify(input)) };
}


export function agentSettingsIssue(draft: AgentConfiguration | null | undefined, secret = ''): string {
  if (!isAgentProtocol(draft?.protocol)) return '请选择明确的 API 协议。';
  if (!draft?.presetId || !draft?.platformId || !draft?.baseUrl.trim() || !draft?.model.trim()) return '请填写服务地址和模型名称。';
  if (draft.baseUrl.length > 2048 || draft.model.length > 200) return '服务地址最多 2048 个字符，模型名称最多 200 个字符。';
  try {
    const url = new URL(draft.baseUrl.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '服务地址不能包含账号、密码、查询参数或片段。';
    if (draft.presetId !== 'ollama' && url.protocol !== 'https:') return '远程服务地址必须使用 HTTPS。';
  } catch { return '请输入完整的服务地址。'; }
  if (secret && (!secret.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(secret) || new TextEncoder().encode(secret).length > 8192)) return '密钥不能为空白、包含控制字符或超过 8192 字节。';
  return '';
}

const errorDescriptors: Record<string, DisplayMessage> = {
  UNAUTHORIZED: message('connections.error.unauthorized'),
  AGENT_SETTINGS_VALIDATION: message('agent.settings.error.validation'),
  AGENT_SETTINGS_STORAGE_UNAVAILABLE: message('agent.settings.error.storage'),
  AGENT_SETTINGS_CORRUPT: message('agent.settings.error.corrupt'),
  AGENT_SETTINGS_CLOSED: message('agent.settings.error.closed'),
};
const errorDescriptor = (code: string | undefined): DisplayMessage => code && Object.hasOwn(errorDescriptors, code) ? errorDescriptors[code] : message('connections.error.unknown');



const notices:Record<AgentSettingsSnapshot['notices'][number],DisplayMessage>={
 LEGACY_KEYS_CLEARED:message('agent.settings.x6.legacyKeysCleared'),LEGACY_SETTINGS_RESET:message('agent.settings.x6.legacySettingsReset'),LEGACY_ENDPOINT_RESET:message('agent.settings.x6.legacyEndpointReset'),
};
/** One collection page. Passwords enter only a single save request via the DOM
 * reader and are cleared synchronously before dispatch; no state keeps them. */
export function createAgentSettingsSession({client=createAgentSettingsClient(),onChange=()=>{},newServiceKey=()=>globalThis.crypto.randomUUID()}:AgentSettingsSessionOptions={}) {
 let state=initialAgentSettingsState(),active=true,visible=true,epoch=0;
 const publish=(patch:Partial<AgentSettingsState>)=>{if(active){state={...state,...patch};onChange(state);}};
 const current=(token:number)=>active&&token===epoch;
 const editable=()=>active&&visible&&agentSettingsEditable(state);
 const readyPatch=()=>({phase:state.recovery?state.phase:'ready' as const,message:state.recovery?state.message:'',displayMessages:state.recovery?state.displayMessages:[]});
 const service=(key:string)=>state.draft?.services.find(item=>item.serviceKey===key);
 const issue=(descriptor:DisplayMessage)=>publish({phase:'error',message:'AGENT_SETTINGS_VALIDATION',displayMessages:[descriptor]});
 function read({recover=false}:{recover?:boolean}={}):Promise<boolean> {
  if(!active||agentSettingsBusy(state)&&state.phase!=='loading')return Promise.resolve(false);
  const token=++epoch;publish({phase:recover?'reconciling':'loading',message:'',displayMessages:recover?[message('agent.settings.notice.rereading')]:[]});
  return Promise.resolve().then(()=>client.read()).then(value=>{
   if(!current(token))return false;const snapshot=safeAgentSettings(value);
   const draft=recover&&state.draft?state.draft:draftFrom(snapshot);
   publish({snapshot,draft,serviceIntents:intentsFrom(snapshot),selectedKey:state.selectedKey==='general'||draft.services.some(item=>item.serviceKey===state.selectedKey)?state.selectedKey:'general',
    phase:recover?'review':'ready',recovery:recover?state.recovery??'unknown':null,message:'',displayMessages:recover?[message('agent.settings.notice.review')]:snapshot.notices.map(code=>notices[code])});
   return true;
  }).catch(error=>{
   if(!current(token))return false;const code=failureCode(error);
   publish({phase:recover?'blocked':'load_error',message:'',displayMessages:recover?[message('agent.settings.notice.blocked')]:code&&Object.hasOwn(errorDescriptors,code)?[errorDescriptor(code)]:[message('agent.settings.notice.loadError')]});return false;
  });
 }
 function editService(key:string,patch:Partial<Pick<AgentServiceInput,'name'|'addressInput'|'manualModelIds'>>):boolean {
  const found=service(key);if(!editable()||!found||Object.keys(patch).some(field=>!['name','addressInput','manualModelIds'].includes(field))||patch.name!==undefined&&found.presetId!=='custom')return false;
  publish({draft:{...state.draft!,services:state.draft!.services.map(item=>item.serviceKey===key?{...item,...patch,...(patch.manualModelIds?{manualModelIds:[...patch.manualModelIds]}:{})}:item)},...readyPatch()});return true;
 }
 function replaceService(key:string,patch:Partial<Pick<AgentServiceInput,'platformId'|'protocol'|'addressInput'>>):boolean {
  if(!editable()||!service(key))return false;
  publish({draft:{...state.draft!,services:state.draft!.services.map(item=>item.serviceKey===key?{...item,...patch}:item)},...readyPatch()});return true;
 }
 function selectPlatform(key:string,id:string):boolean {
  const found=service(key),platform=state.snapshot?.presets.find(preset=>preset.id===found?.presetId)?.platforms.find(item=>item.id===id);
  if(!found||!platform)return false;
  const protocol=platform.availableProtocols.includes(found.protocol)?found.protocol:platform.defaultProtocol;
  const addressInput=platform.addressMode==='fixed'||platform.addressMode==='workspace'?'':platform.addressMode==='local'?new URL(platform.protocols[protocol]!.baseUrl).origin:found.addressInput;
  return replaceService(key,{platformId:id,protocol,addressInput});
 }
 function selectProtocol(key:string,protocol:string):boolean {
  const found=service(key);if(!found||!isAgentProtocol(protocol)||!agentPresetPlatform(state.snapshot?.presets??[],found.presetId,found.platformId)?.availableProtocols.includes(protocol))return false;
  return replaceService(key,{protocol});
 }
 function view(key:string):boolean {
  if(!active||!visible||key!=='general'&&!service(key))return false;publish({selectedKey:key});return true;
 }
 function addCustom(name:string):string|null {
  if(!editable()||!state.draft||state.draft.services.filter(item=>item.presetId==='custom').length>=AGENT_CONNECTION_LIMITS.customServices)return null;
  const preset=state.snapshot!.presets.find(item=>item.id==='custom'),platform=preset?.platforms[0];if(!platform)return null;
  const key=newServiceKey(),draft:AgentServiceInput={serviceKey:key,presetId:'custom',name,platformId:platform.id,protocol:platform.defaultProtocol,addressInput:'',manualModelIds:[]};
  if(state.draft.services.some(item=>item.serviceKey===key))return null;
  publish({draft:{...state.draft,services:[...state.draft.services,draft]},serviceIntents:{...state.serviceIntents,[key]:{action:'keep',storage:'session'}},selectedKey:key,...readyPatch()});return key;
 }
 function canRemove(key:string):boolean {return Boolean(service(key)?.presetId==='custom'&&state.snapshot?.mioSelection?.serviceKey!==key&&state.draft?.mioSelection?.serviceKey!==key);}
 function removeCustom(key:string):boolean {
  if(!editable()||!state.draft||!canRemove(key))return false;
  const serviceIntents={...state.serviceIntents};delete serviceIntents[key];
  publish({draft:{...state.draft,services:state.draft.services.filter(item=>item.serviceKey!==key)},serviceIntents,selectedKey:state.selectedKey===key?'general':state.selectedKey,...readyPatch()});return true;
 }
 function addModel(key:string,value:string):boolean {
  const found=service(key),model=value.trim();if(!found||!isAgentModelIdentifier(model)||found.manualModelIds.includes(model)||found.manualModelIds.length>=AGENT_CONNECTION_LIMITS.manualModels)return false;
  return editService(key,{manualModelIds:[...found.manualModelIds,model]});
 }
 function removeModel(key:string,model:string):boolean {const found=service(key);return found?editService(key,{manualModelIds:found.manualModelIds.filter(id=>id!==model)}):false;}
 function selectMio(key:string,modelId:string):boolean {
  if(!editable()||!service(key)||!isAgentModelIdentifier(modelId)||!state.draft)return false;
  publish({draft:{...state.draft,mioSelection:{serviceKey:key,modelId}},...readyPatch()});return true;
 }
 function useLatest():boolean {
  if(!editable()||state.phase==='blocked'||!state.snapshot)return false;
  publish({draft:draftFrom(state.snapshot),selectedKey:state.selectedKey==='general'||state.snapshot.services.some(item=>item.serviceKey===state.selectedKey)?state.selectedKey:'general',serviceIntents:intentsFrom(state.snapshot),phase:'ready',recovery:null,message:'',displayMessages:[message('connections.notice.useSaved')]});return true;
 }
 function acknowledge():boolean {
  if(!editable()||state.phase!=='review'||!state.recovery)return false;
  publish({phase:'ready',recovery:null,message:'',displayMessages:[message('agent.settings.notice.keepDraft')]});return true;
 }
 function save(source:AgentSettingsSecretSource={read:()=>'',clear:()=>{}}):Promise<boolean> {
  const saved=state.snapshot,draft=state.draft;if(!active||!visible||!agentSettingsCanSave(state)||!saved||!draft)return Promise.resolve(false);
  const metadata={expectedRevision:saved.revision,services:draft.services.map(item=>({...item,name:item.name.trim(),manualModelIds:[...item.manualModelIds]})),mioSelection:draft.mioSelection?{...draft.mioSelection}:null};
  let input:AgentSettingsUpdate;const expectedSecrets=new Map<string,AgentServiceSnapshot['secret']>();
  try {
   if(!agentSettingsMetadataSchema.safeParse(metadata).success)throw failure('AGENT_SETTINGS_VALIDATION');
   for(const entry of metadata.services)agentServiceBase(entry,saved.presets);
   const secretActions:AgentSecretAction[]=metadata.services.map(entry=>{
    const value=source.read(entry.serviceKey),intent=state.serviceIntents[entry.serviceKey]??{action:'keep' as const,storage:'session' as const};
    const previous=saved.services.find(item=>item.serviceKey===entry.serviceKey);
    if(value){
     if(intent.storage==='persistent'&&!saved.storage.persistentAvailable)throw failure('AGENT_SETTINGS_STORAGE_UNAVAILABLE');
     expectedSecrets.set(entry.serviceKey,{configured:true,storage:intent.storage});return {serviceKey:entry.serviceKey,action:'replace',value,storage:intent.storage};
    }
    const removing=intent.action==='remove'||agentServiceBindingChanged(previous,entry,saved.presets);
    expectedSecrets.set(entry.serviceKey,removing?{configured:false,storage:'none'}:previous?.secret??{configured:false,storage:'none'});
    return {serviceKey:entry.serviceKey,action:removing?'remove':'keep'};
   });
   const parsed=agentSettingsUpdateSchema.safeParse({...metadata,secretActions});if(!parsed.success)throw failure('AGENT_SETTINGS_VALIDATION');input=parsed.data;
  }catch(error){const code=failureCode(error);issue(code==='AGENT_SETTINGS_STORAGE_UNAVAILABLE'?errorDescriptor(code):message('agent.settings.x6.validation'));return Promise.resolve(false);}
  finally{source.clear();}
  const token=++epoch;
  publish({phase:'saving',serviceIntents:intentsFrom(saved),message:'',displayMessages:[message('agent.settings.notice.saving')]});
  let operation:Promise<unknown>;try{operation=client.write(input);}catch(error){operation=Promise.reject(error);}
  return Promise.resolve(operation).then(value=>{
   if(!current(token))return false;const snapshot=safeAgentSettings(value);
   if(snapshot.revision!==saved.revision+1||snapshot.services.length!==metadata.services.length||JSON.stringify(snapshot.mioSelection)!==JSON.stringify(metadata.mioSelection)||metadata.services.some(entry=>{
    const actual=snapshot.services.find(item=>item.serviceKey===entry.serviceKey),secret=expectedSecrets.get(entry.serviceKey);
    return !actual||!agentServiceEqual(actual,entry,snapshot.presets)||!secret||actual.secret.configured!==secret.configured||actual.secret.storage!==secret.storage;
   }))throw failure('INVALID_RESPONSE');
   publish({snapshot,draft:draftFrom(snapshot),serviceIntents:intentsFrom(snapshot),phase:'saved',recovery:null,message:'',displayMessages:[message('agent.settings.x6.saved')]});return true;
  }).catch(error=>{
   if(!current(token))return false;const code=failureCode(error);
   if(code==='UNAUTHORIZED'||code==='AGENT_SETTINGS_VALIDATION'||code==='AGENT_SETTINGS_STORAGE_UNAVAILABLE'){
    publish({phase:'error',message:'',displayMessages:[errorDescriptor(code),message('agent.settings.notice.keyCleared')]});return false;
   }
   const recovery=code==='AGENT_SETTINGS_CONFLICT'?'conflict':'unknown';
   publish({phase:'reconciling',recovery,message:'',displayMessages:[message(recovery==='conflict'?'agent.settings.notice.conflictReading':'agent.settings.notice.readNoRetry')]});
   return Promise.resolve().then(()=>client.read()).then(value=>{
    if(!current(token))return false;const snapshot=safeAgentSettings(value);
    publish({snapshot,serviceIntents:intentsFrom(snapshot),phase:'review',message:'',displayMessages:[message(recovery==='conflict'?'agent.settings.notice.conflict':'agent.settings.notice.unknown')]});return false;
   }).catch(()=>{if(current(token))publish({phase:'blocked',message:'',displayMessages:[message('agent.settings.notice.blocked')]});return false;});
  });
 }
 return {getState:():AgentSettingsState=>state,load:()=>read(),reload:()=>read({recover:Boolean(state.snapshot)}),view,editService,selectPlatform,selectProtocol,addCustom,canRemove,removeCustom,addModel,removeModel,selectMio,useLatest,acknowledge,save,
  setVisible(value:boolean){visible=Boolean(value);},
  setStorage(key:string,storage:string):boolean {if(!editable()||!service(key)||(storage!=='session'&&storage!=='persistent')||storage==='persistent'&&!state.snapshot?.storage.persistentAvailable)return false;publish({serviceIntents:{...state.serviceIntents,[key]:{...state.serviceIntents[key]??{action:'keep'},storage}}});return true;},
  removeKey(key:string,remove=true):boolean {if(!editable()||!service(key))return false;publish({serviceIntents:{...state.serviceIntents,[key]:{...state.serviceIntents[key]??{storage:'session'},action:remove?'remove':'keep'}},...readyPatch()});return true;},
  dispose(){active=false;epoch++;state=initialAgentSettingsState();},
 };
}

// Display descriptors are transient UI metadata. Legacy diagnostics and request payloads remain unchanged.
export function agentSettingsIssueDescriptor(draft: AgentConfiguration | null | undefined, secret = ''): DisplayMessage | null {
  if (!isAgentProtocol(draft?.protocol)) return message('agent.settings.issue.protocol');
  if (!draft?.presetId || !draft?.platformId || !draft?.baseUrl.trim() || !draft?.model.trim()) return message('agent.settings.issue.required');
  if (draft.baseUrl.length > 2048 || draft.model.length > 200) return message('agent.settings.issue.length');
  try {
    const url = new URL(draft.baseUrl.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return message('agent.settings.issue.urlParts');
    if (draft.presetId !== 'ollama' && url.protocol !== 'https:') return message('agent.settings.issue.https');
  } catch { return message('agent.settings.issue.url'); }
  if (secret && (!secret.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(secret) || new TextEncoder().encode(secret).length > 8192)) return message('agent.settings.issue.key');
  return null;
}

const presetNames: Record<string, string> = Object.freeze({ openai: 'OpenAI', anthropic: 'Anthropic', deepseek: 'DeepSeek', qwen: 'Qwen / DashScope', zhipu: 'Zhipu / Z.ai', kimi: 'Kimi / Moonshot', minimax: 'MiniMax', openrouter: 'OpenRouter' });
export const agentPresetLabel = (preset: { id: string }, t: Translate): string => preset.id === 'custom' ? t('agent.settings.presets.custom') : preset.id === 'ollama' ? t('agent.settings.presets.ollama') : (Object.hasOwn(presetNames, preset.id) ? presetNames[preset.id] : preset.id);
const platformKeys: Record<string, MessageKey> = Object.freeze({ beijing: 'agent.settings.platform.beijing', singapore: 'agent.settings.platform.singapore', 'workspace-cn-beijing': 'agent.settings.platform.workspaceBeijing', 'workspace-ap-southeast-1': 'agent.settings.platform.workspaceSingapore', 'workspace-us-east-1': 'agent.settings.platform.workspaceUs', 'workspace-cn-hongkong': 'agent.settings.platform.workspaceHongkong', 'workspace-ap-northeast-1': 'agent.settings.platform.workspaceTokyo', 'workspace-eu-central-1': 'agent.settings.platform.workspaceFrankfurt', custom: 'agent.settings.platform.custom', local: 'agent.settings.platform.local' });
export function agentPlatformLabel(presetId: string, platform: { id: string }, t: Translate): string {
  if (Object.hasOwn(platformKeys, platform.id)) return t(platformKeys[platform.id]);
  const brand = presetId === 'zhipu' ? platform.id === 'china' ? 'BigModel' : 'Z.ai' : presetId === 'kimi' ? 'Moonshot' : presetId === 'minimax' ? 'MiniMax' : null;
  if (brand && ['china', 'international'].includes(platform.id)) return t(platform.id === 'china' ? 'agent.settings.platform.china' : 'agent.settings.platform.international', { brand });
  return presetId === 'openai' ? 'OpenAI' : presetId === 'anthropic' ? 'Anthropic' : presetId === 'deepseek' ? 'DeepSeek API' : presetId === 'openrouter' ? 'OpenRouter' : platform.id;
}
const presetNoteKeys: Record<string, MessageKey> = Object.freeze({ openai: 'agent.settings.presets.openaiNote', anthropic: 'agent.settings.presets.anthropicNote', deepseek: 'agent.settings.presets.deepseekNote', qwen: 'agent.settings.presets.qwenNote', zhipu: 'agent.settings.presets.zhipuNote', kimi: 'agent.settings.presets.kimiNote', minimax: 'agent.settings.presets.minimaxNote', openrouter: 'agent.settings.presets.openrouterNote', custom: 'agent.settings.presets.customNote', ollama: 'agent.settings.presets.ollamaNote' });
export const agentPresetNote = (preset: { id: string } | null | undefined, platform: { id?: string } | null | undefined, t: Translate): string => t(typeof preset?.id === 'string' && preset.id === 'qwen' && typeof platform?.id === 'string' && platform.id.startsWith('workspace-') ? 'agent.settings.presets.qwenWorkspace' : (typeof preset?.id === 'string' && Object.hasOwn(presetNoteKeys, preset.id) ? presetNoteKeys[preset.id] : 'agent.settings.presetFallback'));

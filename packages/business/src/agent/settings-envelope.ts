import {randomUUID} from 'node:crypto';
import {agentServiceInputSchema,AGENT_CONNECTION_LIMITS} from '../../../contracts/src/agent-connection-settings.ts';
import type {AgentServiceInput,AgentMioSelection} from '../../../contracts/src/agent-connection-settings.ts';
import {agentEncryptedSecretSchema as cipher,agentSettingsEnvelopeSchema as envelope} from '../../../contracts/src/agent-connection-private.ts';
import type {AgentEncryptedSecret} from '../../../contracts/src/agent-connection-private.ts';
import {agentPresetPlatform,resolveAgentPresetBaseUrl} from '../../../contracts/src/agent-provider-catalog.ts';
import type {AgentProtocol} from '../../../contracts/src/agent-protocol.ts';
import {AGENT_PRESETS} from './presets.ts';
import {agentSettingsError,exactObject,normalizeAgentBaseUrl,parseAgentConfiguration,agentCredentialBinding,normalizeAgentService} from './config.ts';
import type {AgentConfiguration} from './config.ts';

export type LoadedSecret=AgentEncryptedSecret;
export type ServiceState=AgentServiceInput&{revision:number;secret:LoadedSecret|null};
export interface SettingsEnvelope{version:3;revision:number;services:ServiceState[];mioSelection:AgentMioSelection|null;mioSelectionRevision:number;mioRevision:number}
export type SettingsNotice='LEGACY_KEYS_CLEARED'|'LEGACY_SETTINGS_RESET'|'LEGACY_ENDPOINT_RESET';
const fail=():never=>{throw agentSettingsError('AGENT_SETTINGS_CORRUPT');};
export function connectionFor(entry:AgentServiceInput,model='connection-validation',options:{selfPort?:number}={}):AgentConfiguration{
 const platform=agentPresetPlatform(AGENT_PRESETS,entry.presetId,entry.platformId);
 if(!platform)throw agentSettingsError('AGENT_SETTINGS_VALIDATION');
 const baseUrl=resolveAgentPresetBaseUrl(AGENT_PRESETS,entry.presetId,entry.platformId,entry.protocol,platform.addressMode==='fixed'?undefined:entry.addressInput);
 return parseAgentConfiguration({presetId:entry.presetId,platformId:entry.platformId,baseUrl,model,protocol:entry.protocol},options);
}
export const normalizeService=normalizeAgentService;
export const serviceBinding=(entry:AgentServiceInput):string=>JSON.stringify(['mioon.agent.credentials.v3',entry.serviceKey,agentCredentialBinding(connectionFor(entry))]);
export function defaultServices():ServiceState[]{
 return AGENT_PRESETS.filter(p=>p.id!=='custom').map(p=>{
  const platform=p.platforms[0]!;
  const addressInput=platform.addressMode==='fixed'?'':platform.addressMode==='local'?new URL(platform.baseUrl).origin:'';
  return {...normalizeService({serviceKey:p.id,presetId:p.id,name:p.label,platformId:platform.id,protocol:platform.defaultProtocol,addressInput,manualModelIds:[]}),revision:0,secret:null};
 });
}
export function emptyEnvelope(rev=0):SettingsEnvelope{return {version:3,revision:rev,services:defaultServices(),mioSelection:null,mioSelectionRevision:0,mioRevision:0};}
export function parseCurrentEnvelope(input:unknown):SettingsEnvelope{
 try{
  const parsed=envelope.parse(input),services:ServiceState[]=parsed.services.map(row=>{
   const raw=agentServiceInputSchema.parse({serviceKey:row.serviceKey,presetId:row.presetId,name:row.name,platformId:row.platformId,protocol:row.protocol,addressInput:row.addressInput,manualModelIds:row.manualModelIds}),entry=normalizeService(raw);
   if(JSON.stringify(entry)!==JSON.stringify(raw)||row.secret&&row.secret.binding!==serviceBinding(entry))throw Error();
   return {...entry,revision:row.revision,secret:row.secret};
  });
  const keys=new Set(services.map(s=>s.serviceKey));
  if(keys.size!==services.length||AGENT_PRESETS.some(p=>p.id!=='custom'&&!services.some(s=>s.serviceKey===p.id&&s.presetId===p.id))||parsed.mioSelection&&!keys.has(parsed.mioSelection.serviceKey))throw Error();
  if(Buffer.byteLength(JSON.stringify(parsed)+'\n')>AGENT_CONNECTION_LIMITS.transportBytes)throw Error();
  return {...parsed,services};
 }catch{return fail();}
}

// Frozen v1/v2 syntax is intentionally separate from today's endpoint catalog.
// Old valid metadata may have edited builtin URLs or now-blocked protocols.
function legacyConfiguration(input:unknown,version:1|2):AgentConfiguration{
 if(!exactObject(input,version===1?['presetId','platformId','baseUrl','model']:['presetId','platformId','baseUrl','model','protocol']))return fail();
 const preset=AGENT_PRESETS.find(p=>p.id===input.presetId),platform=preset?.platforms.find(p=>p.id===input.platformId),protocol=version===1?'chat_completions':input.protocol;
 if(!preset||!platform||!['chat_completions','responses','anthropic_messages'].includes(String(protocol))||typeof input.model!=='string'||!input.model.trim()||input.model.length>200||/[\u0000-\u001f\u007f-\u009f]/u.test(input.model))return fail();
 const configuration={presetId:preset.id,platformId:platform.id,baseUrl:normalizeAgentBaseUrl(input.baseUrl,{local:preset.id==='ollama',protocol:protocol as AgentProtocol}),model:input.model.trim(),protocol:protocol as AgentProtocol};
 const original=version===1?{presetId:configuration.presetId,platformId:configuration.platformId,baseUrl:configuration.baseUrl,model:configuration.model}:configuration;
 if(JSON.stringify(original)!==JSON.stringify(input))return fail();
 return configuration;
}
export function loadSettingsEnvelope(input:unknown|null):{state:SettingsEnvelope;notices:SettingsNotice[]}{
 if(input===null)return {state:emptyEnvelope(),notices:[]};
 if(typeof input==='object'&&input!==null&&'version'in input&&input.version===3)return {state:parseCurrentEnvelope(input),notices:[]};
 try{
  if(!exactObject(input,['version','revision','configuration','secret'])||input.version!==1&&input.version!==2||!Number.isSafeInteger(input.revision)||Number(input.revision)<0)return fail();
  const configuration=legacyConfiguration(input.configuration,input.version as 1|2),rev=Number(input.revision);
  if(input.secret!==null){const saved=cipher.parse(input.secret);if(saved.binding!==JSON.stringify([configuration.presetId,configuration.platformId,configuration.baseUrl]))return fail();}
  const notices:SettingsNotice[]=['LEGACY_KEYS_CLEARED'];
  try{
   const preset=AGENT_PRESETS.find(p=>p.id===configuration.presetId),platform=agentPresetPlatform(AGENT_PRESETS,configuration.presetId,configuration.platformId);if(!preset||!platform)throw Error();
   const protocol=platform.availableProtocols.includes(configuration.protocol)?configuration.protocol:platform.defaultProtocol;
   let addressInput='';
   if(platform.addressMode==='workspace'){
    const template=platform.protocols[configuration.protocol]?.baseUrlTemplate;if(!template)throw Error();
    const [prefix,suffix]=template.split('{WorkspaceId}');if(!prefix||!suffix||!configuration.baseUrl.startsWith(prefix)||!configuration.baseUrl.endsWith(suffix))throw Error();
    addressInput=configuration.baseUrl.slice(prefix.length,configuration.baseUrl.length-suffix.length);
   }else if(platform.addressMode==='local')addressInput=new URL(configuration.baseUrl).origin;
   else if(platform.addressMode==='custom')addressInput=configuration.baseUrl;
   const serviceKey=configuration.presetId==='custom'?randomUUID():configuration.presetId;
   const entry=normalizeService({serviceKey,presetId:configuration.presetId,name:preset.label,platformId:configuration.platformId,protocol,addressInput,manualModelIds:[]});
   const state=emptyEnvelope(rev),saved={...entry,revision:1,secret:null};
   state.services=state.services.filter(s=>s.serviceKey!==serviceKey);state.services.push(saved);state.mioSelection={serviceKey,modelId:configuration.model};state.mioSelectionRevision=1;state.mioRevision=1;
   const canonical=connectionFor(entry,configuration.model);if(canonical.baseUrl!==configuration.baseUrl||canonical.protocol!==configuration.protocol)notices.push('LEGACY_ENDPOINT_RESET');
   return {state,notices};
  }catch{return {state:emptyEnvelope(rev),notices:['LEGACY_SETTINGS_RESET']};}
 }catch{return fail();}
}

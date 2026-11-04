import {AGENT_PRESETS} from '../../packages/business/src/agent/presets.ts';
import {agentServiceInputSchema,agentSettingsSnapshotSchema,agentServiceInput} from '../../packages/contracts/src/agent-connection-settings.ts';
import type {AgentServiceInput,AgentSettingsSnapshot} from '../../packages/contracts/src/agent-connection-settings.ts';
import type {AgentProviderConfiguration} from '../../packages/contracts/src/agent-provider-catalog.ts';

export const ADAPTER_CUSTOM_SERVICE_KEY='11111111-2222-4333-8444-555555555555';
export const ADAPTER_CONFIGURATION:AgentProviderConfiguration={presetId:'custom',platformId:'custom',baseUrl:'https://synthetic.example',model:'synthetic-model',protocol:'chat_completions'};

/** Fake HTTP transports need the same strict public collection as production;
 * these values perform no persistence, crypto, or inference. */
export function adapterSettings(configuration:AgentProviderConfiguration|null=ADAPTER_CONFIGURATION,options:{revision?:number;secretStorage?:'none'|'session'|'persistent'}={}):AgentSettingsSnapshot{
 const services:AgentServiceInput[]=AGENT_PRESETS.filter(p=>p.id!=='custom').map(preset=>{
  const platform=preset.platforms[0];if(!platform)throw Error('Missing fixture platform');
  return agentServiceInputSchema.parse({serviceKey:preset.id,presetId:preset.id,name:preset.label,platformId:platform.id,protocol:platform.defaultProtocol,
   addressInput:platform.addressMode==='local'?new URL(platform.baseUrl).origin:'',manualModelIds:[]});
 });
 const secret={configured:options.secretStorage!==undefined&&options.secretStorage!=='none',storage:options.secretStorage??'none'};
 const serviceKey=configuration?.presetId==='custom'?ADAPTER_CUSTOM_SERVICE_KEY:configuration?.presetId;
 if(configuration){
  const preset=AGENT_PRESETS.find(p=>p.id===configuration.presetId),platform=preset?.platforms.find(p=>p.id===configuration.platformId);
  if(!preset||!platform)throw Error('Unknown fixture provider');
  const entry=agentServiceInputSchema.parse({serviceKey,presetId:preset.id,name:preset.id==='custom'?'Synthetic custom':preset.label,platformId:platform.id,protocol:configuration.protocol,
   addressInput:platform.addressMode==='fixed'?'':platform.addressMode==='local'?new URL(configuration.baseUrl).origin:platform.addressMode==='workspace'?new URL(configuration.baseUrl).hostname.split('.')[0]:configuration.baseUrl,manualModelIds:[configuration.model]});
  const existing=services.findIndex(item=>item.serviceKey===serviceKey);if(existing>=0)services[existing]=entry;else services.push(entry);
 }
 return agentSettingsSnapshotSchema.parse({revision:options.revision??4,services:services.map(entry=>({...entry,revision:1,secret:entry.serviceKey===serviceKey?secret:{configured:false,storage:'none'}})),
  mioSelection:configuration?{serviceKey,modelId:configuration.model}:null,mioSelectionRevision:configuration?1:0,
  execution:configuration?{revision:options.revision??4,binding:{serviceKey,entryRevision:1,selectionRevision:1},configuration,secret}:null,
  storage:{persistentAvailable:true,sessionScope:'server',reasonCode:null},presets:structuredClone(AGENT_PRESETS),scope:'settings_only',verification:'not_tested',notices:[]});
}
export function adapterMetadata(snapshot:AgentSettingsSnapshot=adapterSettings()){
 return {expectedRevision:snapshot.revision,services:snapshot.services.map(agentServiceInput),mioSelection:snapshot.mioSelection};
}

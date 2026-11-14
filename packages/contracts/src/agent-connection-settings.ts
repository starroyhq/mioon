import {z} from 'zod';
import {agentProviderCatalogSchema,agentProviderConfigurationSchema,isAgentModelIdentifier,resolveAgentPresetBaseUrl} from './agent-provider-catalog.ts';

export const AGENT_CONNECTION_LIMITS=Object.freeze({services:19,customServices:10,manualModels:50,modelCharacters:200,keyBytes:8192,transportBytes:64*1024,dtoBytes:62*1024});
export const AGENT_SETTINGS_NOTICES=['LEGACY_KEYS_CLEARED','LEGACY_SETTINGS_RESET','LEGACY_ENDPOINT_RESET'] as const;
const builtins=['openai','anthropic','deepseek','qwen','zhipu','kimi','minimax','openrouter','ollama'] as const;
const revision=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const protocol=z.enum(['chat_completions','responses','anthropic_messages']);
const utf8=(value:string)=>new TextEncoder().encode(value).byteLength;
const scalar=(value:string):boolean=>{
 for(let i=0;i<value.length;i++){const n=value.charCodeAt(i);if(n>=0xd800&&n<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false;}else if(n>=0xdc00&&n<=0xdfff)return false;}return true;
};
const safeText=(max:number,min=0)=>z.string().min(min).max(max).refine(value=>scalar(value)&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
export const agentServiceKeySchema=z.union([z.enum(builtins),z.string().uuid().regex(/^[a-f0-9-]{36}$/u)]);
export const agentConfigurationSchema=agentProviderConfigurationSchema;
export const agentSettingsBindingSchema=z.object({serviceKey:agentServiceKeySchema,entryRevision:revision,selectionRevision:revision}).strict();
export type AgentSettingsBinding=z.infer<typeof agentSettingsBindingSchema>;
const secretStatus=z.object({configured:z.boolean(),storage:z.enum(['none','session','persistent'])}).strict().refine(value=>value.configured===(value.storage!=='none'));
const serviceFields={serviceKey:agentServiceKeySchema,presetId:z.enum([...builtins,'custom']),name:safeText(100,1).refine(v=>v.trim()===v),platformId:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),protocol,addressInput:safeText(2048),manualModelIds:z.array(z.string().refine(isAgentModelIdentifier)).max(50).refine(v=>new Set(v).size===v.length)};
export const agentServiceInputSchema=z.object(serviceFields).strict().superRefine((value,context)=>{
 if(value.presetId==='custom'?builtins.some(id=>id===value.serviceKey):value.serviceKey!==value.presetId)context.addIssue({code:'custom',message:'Invalid service identity'});
});
export type AgentServiceInput=z.infer<typeof agentServiceInputSchema>;
export const agentServiceSnapshotSchema=z.object({...serviceFields,revision,secret:secretStatus}).strict();
export type AgentServiceSnapshot=z.infer<typeof agentServiceSnapshotSchema>;
export const agentMioSelectionSchema=z.object({serviceKey:agentServiceKeySchema,modelId:z.string().refine(isAgentModelIdentifier)}).strict();
export type AgentMioSelection=z.infer<typeof agentMioSelectionSchema>;
const metadata=z.object({expectedRevision:revision,services:z.array(agentServiceInputSchema).min(9).max(19),mioSelection:agentMioSelectionSchema.nullable()}).strict();
function collectionIssues(value:{services:readonly AgentServiceInput[];mioSelection:AgentMioSelection|null},context:z.RefinementCtx):void{
 const keys=new Set(value.services.map(s=>s.serviceKey));
 if(keys.size!==value.services.length||value.services.some(s=>s.presetId==='custom'?builtins.some(id=>id===s.serviceKey):s.serviceKey!==s.presetId)||builtins.some(id=>!value.services.some(s=>s.serviceKey===id&&s.presetId===id))||value.services.filter(s=>s.presetId==='custom').length>10||value.mioSelection&&!keys.has(value.mioSelection.serviceKey))context.addIssue({code:'custom',message:'Invalid service collection'});
}
const byteBound=(value:unknown):boolean=>utf8(JSON.stringify(value))<=AGENT_CONNECTION_LIMITS.dtoBytes;
export const agentSettingsMetadataSchema=metadata.superRefine(collectionIssues).refine(byteBound);
export type AgentSettingsMetadata=z.infer<typeof agentSettingsMetadataSchema>;
export const agentSecretActionSchema=z.discriminatedUnion('action',[
 z.object({serviceKey:agentServiceKeySchema,action:z.literal('keep')}).strict(),
 z.object({serviceKey:agentServiceKeySchema,action:z.literal('remove')}).strict(),
 z.object({serviceKey:agentServiceKeySchema,action:z.literal('replace'),storage:z.enum(['session','persistent']),value:safeText(8192,1).refine(v=>Boolean(v.trim())&&utf8(v)<=8192)}).strict(),
]);
export type AgentSecretAction=z.infer<typeof agentSecretActionSchema>;
export const agentSettingsUpdateSchema=metadata.extend({secretActions:z.array(agentSecretActionSchema).max(19)}).superRefine((value,context)=>{
 collectionIssues(value,context);const ids=value.secretActions.map(s=>s.serviceKey);
 if(new Set(ids).size!==ids.length||ids.some(id=>!value.services.some(s=>s.serviceKey===id)))context.addIssue({code:'custom',message:'Invalid credential actions'});
}).refine(byteBound);
export type AgentSettingsUpdate=z.infer<typeof agentSettingsUpdateSchema>;
export const agentExecutionSettingsSchema=z.object({revision,binding:agentSettingsBindingSchema,configuration:agentConfigurationSchema,secret:secretStatus}).strict();
export type AgentExecutionSettings=z.infer<typeof agentExecutionSettingsSchema>;
export const agentSettingsStorageSchema=z.object({persistentAvailable:z.boolean(),sessionScope:z.enum(['app','server']),reasonCode:z.enum(['WEB_SESSION_ONLY','OS_SECRET_STORE_UNAVAILABLE','OS_SECRET_STORE_PENDING','LINUX_BASIC_TEXT']).nullable()}).strict();
export const agentSettingsSnapshotSchema=z.object({revision,services:z.array(agentServiceSnapshotSchema).min(9).max(19),mioSelection:agentMioSelectionSchema.nullable(),mioSelectionRevision:revision,execution:agentExecutionSettingsSchema.nullable(),storage:agentSettingsStorageSchema,presets:agentProviderCatalogSchema,scope:z.literal('settings_only'),verification:z.literal('not_tested'),notices:z.array(z.enum(AGENT_SETTINGS_NOTICES)).max(3)}).strict().superRefine((value,context)=>{
 collectionIssues(value,context);
 try{
  for(const entry of value.services){
   const preset=value.presets.find(p=>p.id===entry.presetId),platform=preset?.platforms.find(p=>p.id===entry.platformId);
   if(!preset||!platform||entry.presetId!=='custom'&&entry.name!==preset.label)throw Error();
   resolveAgentPresetBaseUrl(value.presets,entry.presetId,entry.platformId,entry.protocol,platform.addressMode==='fixed'?undefined:entry.addressInput);
   if(platform.addressMode==='fixed'&&entry.addressInput!=='')throw Error();
  }
  if(value.mioSelection===null){if(value.execution!==null)throw Error();}
  else{
   const chosen=value.services.find(s=>s.serviceKey===value.mioSelection!.serviceKey),active=value.execution;
   if(!chosen||!active||active.binding.serviceKey!==chosen.serviceKey||active.binding.entryRevision!==chosen.revision||active.binding.selectionRevision!==value.mioSelectionRevision)throw Error();
   const platform=value.presets.find(p=>p.id===chosen.presetId)?.platforms.find(p=>p.id===chosen.platformId);
   if(!platform)throw Error();
   const expected={presetId:chosen.presetId,platformId:chosen.platformId,baseUrl:resolveAgentPresetBaseUrl(value.presets,chosen.presetId,chosen.platformId,chosen.protocol,platform.addressMode==='fixed'?undefined:chosen.addressInput),model:value.mioSelection.modelId,protocol:chosen.protocol};
   if(JSON.stringify(active.configuration)!==JSON.stringify(expected)||JSON.stringify(active.secret)!==JSON.stringify(chosen.secret))throw Error();
  }
 }catch{context.addIssue({code:'custom',message:'Inconsistent connection snapshot'});}
}).refine(byteBound);
export type AgentSettingsSnapshot=z.infer<typeof agentSettingsSnapshotSchema>;
export function agentServiceInput(entry:AgentServiceInput):AgentServiceInput{
 const {serviceKey,presetId,name,platformId,protocol,addressInput,manualModelIds}=entry;
 return agentServiceInputSchema.parse({serviceKey,presetId,name,platformId,protocol,addressInput,manualModelIds:[...manualModelIds]});
}

import {z} from 'zod';
import {agentServiceKeySchema} from './agent-connection-settings.ts';
import {agentProviderConfigurationSchema,isAgentModelIdentifier} from './agent-provider-catalog.ts';

export const AGENT_MODEL_LIST_LIMITS=Object.freeze({requestBytes:16*1024,resultBytes:256*1024,rawBytes:1024*1024,models:1000,pages:10,totalTimeoutMs:15000,connectTimeoutMs:5000,readTimeoutMs:5000,maxHeaderBytes:16384,maxDnsAnswers:64});
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
const revision=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const safeText=(value:string)=>!/[\u0000-\u001f\u007f-\u009f]/u.test(value)&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const safeDisplay=(value:string)=>safeText(value)&&!/[<>]/u.test(value);
export const agentModelListSelectionSchema=agentProviderConfigurationSchema.omit({model:true});
export type AgentModelListSelection=z.infer<typeof agentModelListSelectionSchema>;
export const agentModelListCredentialSchema=z.discriminatedUnion('source',[
 z.object({source:z.literal('saved')}).strict(),
 z.object({source:z.literal('input'),value:z.string().min(1).max(8192).refine(value=>Boolean(value.trim())&&new TextEncoder().encode(value).byteLength<=8192&&safeText(value))}).strict(),
 z.object({source:z.literal('none')}).strict(),
]);
const requestFields={serviceKey:agentServiceKeySchema,expectedSettingsRevision:revision,selection:agentModelListSelectionSchema};
export const agentModelListRequestSchema=z.object({...requestFields,credential:agentModelListCredentialSchema}).strict().refine(value=>bytes(value)<=AGENT_MODEL_LIST_LIMITS.requestBytes);
export type AgentModelListRequest=z.infer<typeof agentModelListRequestSchema>;
export const agentModelListCacheRequestSchema=z.object(requestFields).strict().refine(value=>bytes(value)<=AGENT_MODEL_LIST_LIMITS.requestBytes);
export type AgentModelListCacheRequest=z.infer<typeof agentModelListCacheRequestSchema>;
export const agentListedModelSchema=z.object({id:z.string().refine(value=>isAgentModelIdentifier(value)&&safeDisplay(value)),displayName:z.string().min(1).max(256).refine(safeDisplay).optional(),adaptation:z.enum(['adapted','unverified'])}).strict();
export type AgentListedModel=z.infer<typeof agentListedModelSchema>;
export const agentModelListSuccessSchema=z.object({outcome:z.literal('success'),models:z.array(agentListedModelSchema).max(1000).refine(models=>new Set(models.map(item=>item.id)).size===models.length),complete:z.boolean(),source:z.enum(['current_protocol','same_platform_compatible','public_local']),fetchedAt:z.string().datetime()}).strict().refine(value=>bytes(value)<=AGENT_MODEL_LIST_LIMITS.resultBytes);
export type AgentModelListSuccess=z.infer<typeof agentModelListSuccessSchema>;
export const agentModelListResultSchema=z.union([
 agentModelListSuccessSchema,
 z.object({outcome:z.literal('invalid_key'),reason:z.enum(['required','rejected','permission_denied'])}).strict(),
 z.object({outcome:z.literal('unavailable'),reason:z.enum(['not_provided','unsupported_shape','http_unavailable','not_found'])}).strict(),
 z.object({outcome:z.literal('unreachable'),reason:z.enum(['connection_failed','timeout','aborted','http_error','rate_limited','server_error','invalid_response','response_limit'])}).strict(),
 z.object({outcome:z.literal('network_denied'),reason:z.literal('policy')}).strict(),
]);
export type AgentModelListResult=z.infer<typeof agentModelListResultSchema>;
export const agentModelListCacheResultSchema=z.union([z.object({status:z.literal('miss')}).strict(),z.object({status:z.literal('hit'),result:agentModelListSuccessSchema}).strict()]).refine(value=>bytes(value)<=AGENT_MODEL_LIST_LIMITS.resultBytes);
export type AgentModelListCacheResult=z.infer<typeof agentModelListCacheResultSchema>;

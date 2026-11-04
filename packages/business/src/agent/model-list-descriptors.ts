import {agentModelListSelectionSchema} from '../../../contracts/src/agent-model-list.ts';
import type {AgentModelListSelection,AgentModelListSuccess,AgentListedModel} from '../../../contracts/src/agent-model-list.ts';
import {parseAgentConfiguration} from './config.ts';
import {agentModelAdaptation} from './model-profiles.ts';

export interface AgentModelListDescriptor {
 readonly id:string; readonly url:string;
 readonly format:'openai'|'anthropic'; readonly pagination:'none'|'cursor'|'offset';
 readonly auth:'bearer'|'anthropic'; readonly allowNone:boolean;
 readonly local:boolean; readonly source:AgentModelListSuccess['source'];
}
export function parseAgentModelListSelection(input:unknown,options:{selfPort?:number}={}):AgentModelListSelection {
 const selection=agentModelListSelectionSchema.parse(input);
 const {model:_model,...configuration}=parseAgentConfiguration({...selection,model:'model-list-validation'},options);
 return configuration;
}
/** Versioned server-owned list routes. The caller never supplies a route,
 * authentication header, query field or provider-controlled next URL. */
export function resolveAgentModelListDescriptor(input:unknown,options:{selfPort?:number}={}):AgentModelListDescriptor|null {
 const selection=parseAgentModelListSelection(input,options),{presetId,platformId,protocol,baseUrl}=selection;
 if(presetId==='qwen'||presetId==='zhipu')return null;
 const messages=protocol==='anthropic_messages';
 let url=baseUrl+(messages?'/v1/models':'/models'),format:AgentModelListDescriptor['format']=messages?'anthropic':'openai',pagination:AgentModelListDescriptor['pagination']=messages?'cursor':'none',auth:AgentModelListDescriptor['auth']=messages?'anthropic':'bearer',source:AgentModelListSuccess['source']='current_protocol';
 if(presetId==='deepseek'){url='https://api.deepseek.com/models';format='openai';pagination='none';auth='bearer';if(messages)source='same_platform_compatible';}
 if(presetId==='openrouter')pagination='offset';
 if(presetId==='ollama'){url=new URL(baseUrl).origin+'/v1/models';format='openai';pagination='none';auth='bearer';source='public_local';}
 const allowNone=presetId==='openrouter'||presetId==='ollama';
 const id=JSON.stringify(['agent-model-list-v1',presetId,platformId,protocol,url,format,pagination,auth,source]);
 return Object.freeze({id,url,format,pagination,auth,allowNone,local:presetId==='ollama',source});
}
/** Cache labels always follow today's local profiles, never cached or remote
 * capabilities. Custom recipients have no verified provider identity. */
export function adaptAgentModelListModels(selection:AgentModelListSelection,models:readonly {id:string;displayName?:string}[]):AgentListedModel[]{
 return models.map(model=>({...model,adaptation:selection.presetId==='custom'?'unverified':agentModelAdaptation({...selection,model:model.id})}));
}

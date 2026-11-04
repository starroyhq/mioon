// Disk-only cache shape. Never use this as an HTTP, CLI or renderer result.
import {z} from 'zod';
import {agentServiceKeySchema} from './agent-connection-settings.ts';
import {agentModelListSuccessSchema} from './agent-model-list.ts';

export const AGENT_MODEL_LIST_CACHE_LIMITS=Object.freeze({version:1,fileBytes:264*1024,files:57,directoryBytes:16*1024*1024});
export const agentModelListCacheIdentitySchema=z.object({serviceKey:agentServiceKeySchema,binding:z.string().min(1).max(8192),descriptor:z.string().min(1).max(8192)}).strict();
export const agentModelListCacheRecordSchema=z.object({version:z.literal(AGENT_MODEL_LIST_CACHE_LIMITS.version),identity:agentModelListCacheIdentitySchema,result:agentModelListSuccessSchema}).strict();

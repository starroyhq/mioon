// Disk-only shape. Never use this as an HTTP, CLI or renderer result schema.
import {z} from 'zod';
import {agentServiceSnapshotSchema,agentMioSelectionSchema} from './agent-connection-settings.ts';
const revision=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const agentEncryptedSecretSchema=z.object({binding:z.string().min(1).max(8192),encrypted:z.string().min(1).max(48*1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)}).strict();
export const agentSettingsEnvelopeSchema=z.object({version:z.literal(3),revision,services:z.array(agentServiceSnapshotSchema.omit({secret:true}).extend({secret:agentEncryptedSecretSchema.nullable()}).strict()).min(9).max(19),mioSelection:agentMioSelectionSchema.nullable(),mioSelectionRevision:revision,mioRevision:revision}).strict();
export type AgentEncryptedSecret=z.infer<typeof agentEncryptedSecretSchema>;

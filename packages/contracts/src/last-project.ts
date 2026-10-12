import {z} from 'zod';

// Private UI rediscovery only; deliberately absent from the operation catalog.
export const LAST_PROJECT_LIMITS=Object.freeze({fileBytes:4096,httpBytes:2048,urlBytes:2048});
const id=z.string().uuid(),scope=z.string().regex(/^[a-f0-9]{64}$/);
const revision=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const authority={workspaceScope:scope,instanceId:id};
export const lastProjectPutSchema=z.object({...authority,expectedRevision:revision,projectId:id}).strict();
export const lastProjectDiskSchema=z.object({version:z.literal(1),workspaceScope:scope,revision:revision.min(1),projectId:id,updatedAt:z.string().datetime()}).strict();
export const lastProjectUnsupportedSchema=z.object({supported:z.literal(false),reason:z.literal('RESTORED_WORKSPACE_UNSUPPORTED')}).strict();
export const lastProjectEnvelopeSchema=z.union([
  lastProjectUnsupportedSchema,
  z.object({supported:z.literal(true),...authority,revision:z.literal(0),projectId:z.null(),updatedAt:z.null(),targetStatus:z.literal('unset')}).strict(),
  z.object({supported:z.literal(true),...authority,revision:revision.min(1),projectId:id,updatedAt:z.string().datetime(),targetStatus:z.enum(['matching','missing'])}).strict(),
]);
export type LastProjectPut=z.infer<typeof lastProjectPutSchema>;
export type LastProjectDisk=z.infer<typeof lastProjectDiskSchema>;
export type LastProjectEnvelope=z.infer<typeof lastProjectEnvelopeSchema>;

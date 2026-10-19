import {z} from 'zod';
export const exportFileIdentitySchema=z.object({projectId:z.string().uuid(),exportId:z.string().uuid()}).strict();
export const exportFileStatusSchema=z.object({projectId:z.string().uuid(),exportId:z.string().uuid(),assetId:z.string().uuid(),status:z.enum(['present','missing']),sizeBytes:z.number().int().positive().safe(),sha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export type ExportFileStatus=z.infer<typeof exportFileStatusSchema>;

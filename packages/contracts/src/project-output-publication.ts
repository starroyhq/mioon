import {z} from 'zod';
import {projectIdSchema} from './project-file.ts';

export const PROJECT_OUTPUT_FOLDERS = Object.freeze({generated: '生成', exports: '导出', assets: '素材'});
export const projectOutputOwnerSchema = z.object({
  kind: z.enum(['generation', 'image', 'frame', 'scene', 'export', 'previs', 'import']),
  id: projectIdSchema,
  requestId: z.string().min(1).max(200),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();
export type ProjectOutputOwner = z.infer<typeof projectOutputOwnerSchema>;

/** Portable result facts. The private intent additionally binds filesystem
 * identity; a matching name or matching bytes alone never establish ownership. */
export const projectOutputPublicationProofSchema = z.object({
  version: z.literal(1), publicationId: projectIdSchema, projectId: projectIdSchema, assetId: projectIdSchema,
  owner: projectOutputOwnerSchema, targetKind: z.enum(['generated', 'exports', 'assets']),
  relativePath: z.string().min(1).max(1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4']),
}).strict().refine(value => {
  const parts = value.relativePath.split('/');
  return parts.length === 2 && parts[0] === PROJECT_OUTPUT_FOLDERS[value.targetKind] &&
    Boolean(parts[1]) && !parts[1]!.startsWith('.') && !/[\\\0]/u.test(value.relativePath) &&
    !parts.some(part => part === '.' || part === '..');
}, 'Use the fixed ordinary project output directory.');
export type ProjectOutputPublicationProof = z.infer<typeof projectOutputPublicationProofSchema>;

const identitySchema = z.object({dev:z.string().min(1).max(40),ino:z.string().min(1).max(40),birthtimeNs:z.string().min(1).max(40)}).strict();
/** Private local bookkeeping, never a public operation input. */
export const projectOutputPublicationReceiptSchema = z.object({
  version:z.literal(1),proof:projectOutputPublicationProofSchema,
  stageRelativePath:z.string().min(1).max(4096),stageIdentity:identitySchema,rootIdentity:identitySchema,directoryIdentity:identitySchema,
  mode:z.enum(['link','copy']),phase:z.enum(['intent','copying','prepared','registered']),targetIdentity:identitySchema.nullable(),
  finalStats:z.object({mtimeNs:z.string().min(1).max(40),ctimeNs:z.string().min(1).max(40)}).strict().nullable().optional(),
  attempt:z.number().int().min(1).max(16),abandoned:z.array(z.string().min(1).max(1024)).max(16),
}).strict();
export type ProjectOutputPublicationReceipt = z.infer<typeof projectOutputPublicationReceiptSchema>;
export const projectOutputPublicationIndexSchema=z.object({version:z.literal(1),projectId:projectIdSchema,assetId:projectIdSchema,owner:projectOutputOwnerSchema,publicationId:projectIdSchema}).strict();
export type ProjectOutputPublicationIndex=z.infer<typeof projectOutputPublicationIndexSchema>;

import {z} from 'zod';
import {mediaFingerprintSchema} from './media-reference.ts';
import {projectOutputPublicationProofSchema} from './project-output-publication.ts';
const identity=z.object({projectId:z.string().uuid(),exportId:z.string().uuid()}).strict();
export const exportControlSchemas={
  'export.cancel':identity,
  'export.activity.get':identity,
  'export.output.get':identity,
};
export const exportControlDescriptions={
  'export.cancel':'Stops only an owned local queued/running export, preserving its frozen request and all source media. Repetition never restarts rendering.',
  'export.activity.get':'Reads local export stage and elapsed time without rendering, polling a supplier or mutating the export.',
  'export.output.get':'Reads a verified owned export location and file metadata. No caller-controlled path or shell action is accepted.',
};
export const exportActivitySchema=z.object({projectId:z.string().uuid(),exportId:z.string().uuid(),status:z.string(),stage:z.enum(['queued','preparing','encoding','finalizing','complete','failed','cancelled']),progress:z.number().min(0).max(100).nullable(),elapsedSeconds:z.number().nonnegative(),cancelled:z.boolean()}).strict();
/** This dedicated native descriptor exposes only a fixed project output path.
 * It does not change the recursive path redaction used by ordinary results. */
export const exportOutputPublicationSchema=projectOutputPublicationProofSchema.innerType().omit({relativePath:true}).extend({projectRelativePath:z.string().min(1).max(1024)}).strict().refine(({projectRelativePath,...proof})=>projectOutputPublicationProofSchema.safeParse({...proof,relativePath:projectRelativePath}).success,'Use the fixed published output path.');
export const exportOutputSchema=z.object({projectId:z.string().uuid(),exportId:z.string().uuid(),assetId:z.string().uuid(),fileLocation:z.string().min(1).max(4096),sizeBytes:z.number().int().positive().safe(),sha256:z.string().regex(/^[a-f0-9]{64}$/u),url:z.string().min(1).max(4096),referenceRevision:z.number().int().positive().safe(),fingerprint:mediaFingerprintSchema,producer:z.object({kind:z.literal('export'),id:z.string().uuid()}).strict(),publication:exportOutputPublicationSchema.optional()}).strict().refine(value=>value.producer.id===value.exportId&&value.fingerprint.sizeBytes===value.sizeBytes&&value.fingerprint.fullSha256===value.sha256&&(!value.publication||value.publication.projectId===value.projectId&&value.publication.assetId===value.assetId&&value.publication.owner.kind==='export'&&value.publication.owner.id===value.exportId&&value.publication.targetKind==='exports'&&value.publication.sha256===value.sha256&&value.publication.sizeBytes===value.sizeBytes&&value.publication.mimeType==='video/mp4'),'Export source proof must name this export and the same full content.');
export type ExportActivity=z.infer<typeof exportActivitySchema>;
export type ExportOutput=z.infer<typeof exportOutputSchema>;

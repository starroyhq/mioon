import {z} from 'zod';
import {imageSchemas, canonicalImageInput} from './images.ts';
import {customImageConnectionIdV2Schema, customImageConnectionV2Schema} from './generation-image-settings.ts';
import {isImageReviewResponse} from './image-reviews.ts';

// Web HTTP/client only. These operations are deliberately absent from the
// public RPC, CLI, MCP and fixed Mio tool catalogs.
const projectId = z.string().uuid().regex(/^[a-f0-9-]{36}$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const customGeneration = imageSchemas['image.generate'].refine(value => value.providerId === 'openai-compatible');
export const generationImageServiceSchemas = Object.freeze({
  'image.service.list': z.object({projectId}).strict(),
  'image.service.review.prepare': z.object({input: customGeneration, connectionId: customImageConnectionIdV2Schema,
    configurationRevision: revision}).strict(),
});
export type GenerationImageServiceOperation = keyof typeof generationImageServiceSchemas;
export const generationImageServiceListResponseSchema = z.object({projectId,
  items: z.array(customImageConnectionV2Schema).max(10)}).strict()
  .refine(value => new Set(value.items.map(item => item.connectionId)).size === value.items.length, 'Duplicate service identity');
export function isGenerationImageServiceResponse(operation: GenerationImageServiceOperation, input: unknown, result: unknown): boolean {
  const parsed = generationImageServiceSchemas[operation].safeParse(input);
  if (!parsed.success) return false;
  if (operation === 'image.service.list') {
    const response = generationImageServiceListResponseSchema.safeParse(result);
    return response.success && response.data.projectId === (parsed.data as {projectId: string}).projectId;
  }
  const request = parsed.data as z.infer<typeof generationImageServiceSchemas['image.service.review.prepare']>;
  return isImageReviewResponse(result) && 'connectionId' in result && 'configurationRevision' in result &&
    result.connectionId === request.connectionId && result.configurationRevision === request.configurationRevision &&
    result.settingsRevision === request.configurationRevision && canonicalImageInput(result.input) === canonicalImageInput(request.input);
}

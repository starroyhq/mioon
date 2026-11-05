import {z} from 'zod';
import {projectIdSchema} from './project-file.ts';
import {assetMediaLocationSchema, assetMediaDtoSchema, ASSET_MEDIA_PAGE_LIMIT} from './asset-media.ts';
import {outsideProjectLocationSchema} from './media-reference.ts';

/** Strict consumers for the existing S1 UI responses. No new wire fields or operations.
 * The existing S1 service inspects at most 20,000 project references. */
const id = projectIdSchema;
const member = z.object({assetId: id}).strict();
export const mediaLocationPageSchema = z.object({
  assets: z.array(assetMediaLocationSchema).max(ASSET_MEDIA_PAGE_LIMIT),
  locations: z.array(outsideProjectLocationSchema.extend({locationToken: id, confirmed: z.boolean()}).strict()).max(20_000),
  nextCursor: id.nullable(),
}).strict().refine(value => new Set(value.assets.map(asset => asset.assetId)).size === value.assets.length &&
  new Set(value.locations.map(location => location.directory)).size === value.locations.length);
export type MediaLocationPage = z.infer<typeof mediaLocationPageSchema>;
export const mediaRelinkPreviewSchema = z.object({
  previewToken: id, chosen: member.extend({matches: z.boolean()}).strict(),
  found: z.array(member).max(20_000), mismatched: z.array(member).max(20_000), unverified: z.array(member).max(20_000),
}).strict().refine(value => {
  const ids = [value.chosen.assetId, ...value.found.map(item => item.assetId), ...value.mismatched.map(item => item.assetId), ...value.unverified.map(item => item.assetId)];
  return ids.length <= 20_000 && new Set(ids).size === ids.length;
});
export type MediaRelinkPreview = z.infer<typeof mediaRelinkPreviewSchema>;
export const mediaChangedResponseSchema = z.object({asset: assetMediaDtoSchema, replacesAssetId: id}).strict();
export const mediaAppliedResponseSchema = z.object({assets: z.array(assetMediaDtoSchema).min(1).max(20_000)}).strict()
  .refine(value => new Set(value.assets.map(asset => asset.id)).size === value.assets.length);
export const mediaPermissionResponseSchema = z.object({confirmedDirectories: z.array(z.string().min(1).max(4096)).max(1), revokedDirectories: z.array(z.string().min(1).max(4096)).max(1)}).strict();

// Edit capability per fixed image model. Values follow the pinned openai@7.39.0
// images.edit documentation (checked 2026-10-27): GPT Image 2.5 Flare accepts
// png/webp/jpg sources under 50 MB and arbitrary WIDTHxHEIGHT outputs whose
// edges are multiples of 16, with an aspect ratio between 1:3 and 3:1. Sizes
// above 2560x1440 are documented as experimental and are not offered here.
// Local bounds (edge, pixels, opacity) keep source validation bounded; they are
// application limits, not a claim about the model. Mock mirrors the OpenAI
// rules so every size path is exercised offline.
export type ImageEditSourceMimeType = 'image/png' | 'image/jpeg' | 'image/webp';
export interface ImageEditProfile {
  readonly providerId: 'mock' | 'openai';
  readonly model: string;
  readonly source: Readonly<{mimeTypes: readonly ImageEditSourceMimeType[]; maxBytes: number; maxEdge: number; maxPixels: number}>;
  readonly output: Readonly<{longEdge: number; multiple: number; minEdge: number; maxEdge: number; maxPixels: number; minRatio: number; maxRatio: number}>;
}
export const IMAGE_EDIT_SOURCE_MIME_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp'] as const);
// Union of every profile's source bounds; descriptors never exceed these.
export const IMAGE_EDIT_SOURCE_BOUNDS = Object.freeze({maxBytes: 50 * 1024 * 1024 - 1, maxEdge: 4096, maxPixels: 4096 * 4096});
export const IMAGE_EDIT_OUTPUT_BOUNDS = Object.freeze({minEdge: 256, maxEdge: 2560, maxPixels: 2560 * 1440});
const source = Object.freeze({mimeTypes: IMAGE_EDIT_SOURCE_MIME_TYPES, ...IMAGE_EDIT_SOURCE_BOUNDS});
const output = Object.freeze({longEdge: 1536, multiple: 16, ...IMAGE_EDIT_OUTPUT_BOUNDS, minRatio: 1 / 3, maxRatio: 3});
export const IMAGE_EDIT_PROFILES: Readonly<Record<'mock' | 'openai', ImageEditProfile>> = Object.freeze({
  mock: Object.freeze({providerId: 'mock', model: 'mock-image-v1', source, output}),
  openai: Object.freeze({providerId: 'openai', model: 'gpt-image-2.5-flare-2026-09-08', source, output}),
});

export function imageEditProfile(providerId: unknown, model: unknown): ImageEditProfile | null {
  const profile = providerId === 'mock' || providerId === 'openai' ? IMAGE_EDIT_PROFILES[providerId] : null;
  return profile && profile.model === model ? profile : null;
}
export function parseImageSize(size: unknown): {width: number; height: number} | null {
  const match = typeof size === 'string' ? /^([1-9][0-9]{0,4})x([1-9][0-9]{0,4})$/.exec(size) : null;
  return match ? {width: Number(match[1]), height: Number(match[2])} : null;
}
/** True when the model can produce this exact output size. */
export function isImageEditOutputSize(profile: ImageEditProfile | null, size: unknown): boolean {
  const parsed = parseImageSize(size);
  if (!profile || !parsed) return false;
  const {width, height} = parsed, rule = profile.output;
  return [width, height].every(edge => edge % rule.multiple === 0 && edge >= rule.minEdge && edge <= rule.maxEdge) &&
    width * height <= rule.maxPixels && width / height >= rule.minRatio && width / height <= rule.maxRatio;
}
/** Output that follows the source's aspect ratio: the long edge is fixed and the
 * short edge is rounded to the model's multiple, clamped to its ratio range. */
export function imageEditOutputSize(profile: ImageEditProfile, width: number, height: number): string {
  const rule = profile.output, ratio = Math.min(rule.maxRatio, Math.max(rule.minRatio, width / height));
  const short = (value: number): number => Math.max(rule.minEdge, Math.round(value / rule.multiple) * rule.multiple);
  const size = ratio >= 1 ? `${rule.longEdge}x${short(rule.longEdge / ratio)}` : `${short(rule.longEdge * ratio)}x${rule.longEdge}`;
  if (!isImageEditOutputSize(profile, size)) throw new Error('Edit output rule produced an unsupported size');
  return size;
}
export type ImageEditSourceIssue = 'format' | 'bytes' | 'dimensions';
/** Why this model cannot edit the source, or null when it can. */
export function imageEditSourceIssue(profile: ImageEditProfile, value: {mimeType?: unknown; byteLength?: unknown; width?: unknown; height?: unknown}): ImageEditSourceIssue | null {
  const limits = profile.source, integer = (item: unknown): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item > 0;
  if (!(limits.mimeTypes as readonly unknown[]).includes(value.mimeType)) return 'format';
  if (!integer(value.byteLength) || value.byteLength > limits.maxBytes) return 'bytes';
  if (!integer(value.width) || !integer(value.height) || value.width > limits.maxEdge || value.height > limits.maxEdge || value.width * value.height > limits.maxPixels) return 'dimensions';
  return null;
}

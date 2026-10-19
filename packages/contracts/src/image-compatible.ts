import {z} from 'zod';

// Browser-safe syntax only. DNS and address classification remain the transport's
// responsibility. No normalization is performed while validating stored intent.
export const CUSTOM_IMAGE_ENDPOINT_LIMIT = 2048;
export const customImageModelSchema = z.string().min(1).max(120).regex(/^[\x21-\x7e]+$/);
function invalid(): never { throw new TypeError('Invalid custom image base URL'); }
export function normalizeCustomImageBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > CUSTOM_IMAGE_ENDPOINT_LIMIT ||
      !/^[\x21-\x7e]+$/.test(value) || /[%\\?#@]/.test(value)) invalid();
  const match = /^https:\/\/([^/]+)(\/.*)?$/.exec(value);
  if (!match || !/^[A-Za-z0-9.-]+(?::443)?$/.test(match[1])) invalid();
  const hostname = match[1].replace(/:443$/, '').toLowerCase();
  const labels = hostname.split('.');
  if (hostname.length > 253 || labels.length < 2 || labels.some(label =>
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      !/[a-z]/.test(labels[labels.length - 1])) invalid();
  const path = match[2] ?? '';
  if (path !== '' && path !== '/' && !/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+\/?$/.test(path)) invalid();
  if (path.split('/').some(segment => segment === '.' || segment === '..')) invalid();
  const normalized = `https://${hostname}${path === '/' ? '' : path.replace(/\/$/, '')}`;
  let url: URL;
  try { url = new URL(normalized); } catch { return invalid(); }
  if (url.hostname !== hostname || url.protocol !== 'https:' || url.port || url.username || url.password ||
      normalized.length + '/images/generations'.length > CUSTOM_IMAGE_ENDPOINT_LIMIT) invalid();
  return normalized;
}
export const customImageBaseUrlSchema = z.string().min(1).max(CUSTOM_IMAGE_ENDPOINT_LIMIT).refine(value => {
  try { return normalizeCustomImageBaseUrl(value) === value; } catch { return false; }
}, 'Custom image base URL must be canonical');
export function getCustomImageDestination(baseUrl: string): string {
  if (!customImageBaseUrlSchema.safeParse(baseUrl).success) throw new TypeError('Invalid custom image base URL');
  return `${baseUrl}/images/generations`;
}

import {providerError} from '../providers/live-common.ts';
import type {ProviderError} from '../providers/live-common.ts';

export interface OmniFailure {
  providerType?: string;
  code?: string;
  message?: string;
  httpStatus?: number;
}
const failures = new WeakMap<object, Readonly<OmniFailure>>();
const taskFailures = new WeakMap<object, Readonly<OmniFailure>>();
const taskLookupFailures = new WeakSet<object>();
// Interactions API error labels and legacy Files API status labels. Arbitrary
// message suffixes, identifiers and echoed request fields are never retained.
const labels = new Set([
  'invalid_request', 'failed_precondition', 'out_of_range', 'parameter_unknown',
  'authentication', 'payment_required', 'permission_denied', 'not_found',
  'model_not_found', 'already_exists', 'aborted', 'rate_limit_exceeded',
  'quota_exceeded', 'too_many_requests', 'cancelled', 'api_error',
  'unimplemented', 'service_unavailable', 'deadline_exceeded', 'safety',
  'recitation', 'language', 'prohibited_content', 'spii', 'blocklist',
  'image_safety', 'image_prohibited_content', 'image_recitation', 'image_other',
  'content_blocked', 'no_image', 'INVALID_ARGUMENT', 'UNAUTHENTICATED',
  'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'NOT_FOUND', 'INTERNAL',
  'UNAVAILABLE', 'FAILED_PRECONDITION', 'DEADLINE_EXCEEDED',
]);
const explanations = [
  'Rate limit exceeded', 'Too many requests', 'Quota exceeded', 'API quota exceeded',
  'You exceeded your current quota', 'Insufficient credits',
  'Your prepayment credits are depleted', 'Invalid API key', 'Invalid credentials',
  'Authentication failed', 'Permission denied', 'Model not found',
  'The specified model was not found', 'Invalid request', 'Invalid parameter',
  'Safety violations blocked the request', 'Content blocked', 'Generation blocked',
  'Internal error', 'Service unavailable', 'Deadline exceeded',
].sort((left, right) => right.length - left.length);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
const safeLabel = (value: unknown): string | undefined =>
  typeof value === 'string' && labels.has(value) ? value : undefined;

export function omniFailure(payload: unknown, httpStatus?: number): Readonly<OmniFailure> {
  const body = record(payload);
  const recorded = Array.isArray(body?.errors) && body.errors.length <= 32 ? record(body.errors[0]) : undefined;
  const error = record(body?.error) ?? recorded ?? body;
  const providerType = safeLabel(error?.type ?? error?.status);
  const code = typeof error?.code === 'number' && Number.isInteger(error.code) && error.code >= 1 && error.code <= 16
    ? String(error.code) : safeLabel(error?.code);
  let message: string | undefined;
  if (typeof error?.message === 'string') {
    const start = error.message.slice(0, 256).trimStart();
    message = explanations.find(value => start.startsWith(value) &&
      (!start[value.length] || /[\s.:;,!()\[\]-]/u.test(start[value.length]!)));
  }
  return Object.freeze({
    ...(providerType ? {providerType} : {}),
    ...(code ? {code} : {}),
    ...(message ? {message} : {}),
    ...(httpStatus !== undefined ? {httpStatus} : {}),
  });
}
export function omniProviderError(code: string, message: string, detail: Readonly<OmniFailure>, tags: Record<string, unknown> = {}): ProviderError {
  const failure = providerError(code, detail.message ?? message, tags);
  failures.set(failure, detail);
  return failure;
}
export function getOmniFailure(error: unknown): Readonly<OmniFailure> | undefined {
  return error !== null && typeof error === 'object' ? failures.get(error) : undefined;
}
/** Preserve only admitted provider evidence when the owner adds recovery state. */
export function retainOmniFailure<T extends object>(source: unknown, target: T): T {
  const detail = getOmniFailure(source);
  if (detail) failures.set(target, detail);
  return target;
}
export function rememberOmniTaskFailure<T extends object>(task: T, detail: Readonly<OmniFailure>): T {
  taskFailures.set(task, detail);
  return task;
}
export function getOmniTaskFailure(task: unknown): Readonly<OmniFailure> | undefined {
  return task !== null && typeof task === 'object' ? taskFailures.get(task) : undefined;
}
export function rememberOmniTaskLookupFailure<T extends object>(error: T): T {
  taskLookupFailures.add(error);
  return error;
}
export function isOmniTaskLookupFailure(error: unknown): boolean {
  return error !== null && typeof error === 'object' && taskLookupFailures.has(error);
}

import {z} from 'zod';
import {UI_PREFERENCES_LIMITS} from './ui-preferences.ts';

/** Only errors observed through the application HTTP routes. Library opening
 * and lifecycle errors remain internal startup/owner failures. */
export const APP_LIBRARY_HTTP_ERROR_CODES = Object.freeze(['APP_LIBRARY_LIMIT', 'APP_LIBRARY_INVALID'] as const);
export type AppLibraryHttpErrorCode = typeof APP_LIBRARY_HTTP_ERROR_CODES[number];
export const APP_LIBRARY_HTTP_ERROR_STATUS = Object.freeze({APP_LIBRARY_LIMIT: 507, APP_LIBRARY_INVALID: 422} as const);

const response = {message: z.string().min(1).max(300), retryable: z.literal(false)};
export const appLibraryHttpFailureSchema = z.discriminatedUnion('code', [
  z.object({code: z.literal('APP_LIBRARY_LIMIT'), ...response,
    details: z.object({limit: z.literal(UI_PREFERENCES_LIMITS.recentProjects)}).strict()}).strict(),
  z.object({code: z.literal('APP_LIBRARY_INVALID'), ...response,
    details: z.object({reason: z.literal('unusable')}).strict()}).strict(),
]);
export type AppLibraryHttpFailure = z.infer<typeof appLibraryHttpFailureSchema>;
export const appLibraryHttpFailureEnvelopeSchema = z.object({ok: z.literal(false), error: appLibraryHttpFailureSchema}).strict();
export type AppLibraryHttpFailureEnvelope = z.infer<typeof appLibraryHttpFailureEnvelopeSchema>;

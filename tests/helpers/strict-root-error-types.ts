// Errors at rejection assertions come from several boundaries. Only the Error
// fields are shared; a test must establish or explicitly expect each extension.
export interface RootFailure extends Error {
 terminationUnconfirmed?: boolean; recovery?: string; uncertain?: boolean; dispatched?: boolean; outcomeUnknown?: boolean; code?: string; status?: number; exitCode?: number; retryable?: boolean;
 details?: Record<string, unknown>; reason?: string;
}

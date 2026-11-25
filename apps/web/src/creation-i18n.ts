/** React-compatible text interpolation without translating user content. */
export function creationParameter(value: unknown): string | number {
  return typeof value === 'string' || typeof value === 'number' ? value : '';
}

import { message } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { videoCredentialDiagnosticSchema, videoResultCredentialRecoverySchema } from '@mioon/contracts/video-credential-diagnostic';
/** Known backend statuses are display-mapped, never rewritten in saved jobs. */
export function statusDescriptor(status: unknown): DisplayMessage {
  switch (status) {
    case 'queued': return message('tasks.status.queued');
    case 'submitting': return message('tasks.status.submitting');
    case 'running': return message('tasks.status.running');
    case 'downloading': return message('tasks.status.downloading');
    case 'succeeded': case 'completed': return message('tasks.status.succeeded');
    case 'failed': return message('tasks.status.failed');
    case 'submission_unknown': return message('tasks.status.submissionUnknown');
    case 'cancelled': return message('tasks.status.cancelled');
    case 'ready': return message('tasks.status.ready');
    case 'pending': return message('tasks.status.pending');
    case null: case undefined: case '': return message('tasks.status.notStarted');
    default: return message('tasks.status.unknown');
  }
}
type JobDisplay = { phase?: unknown; status?: unknown; error?: unknown; providerJobId?: unknown; submissionCount?: unknown };

export function videoResultCredentialRecovery(value: unknown) {
  const audit = videoResultCredentialRecoverySchema.safeParse(value);
  return audit.success ? audit.data : null;
}

const videoConnectionDetails = {
  VIDEO_SETTINGS_CONFLICT: 'tasks.error.videoSettingsBusy',
  VIDEO_SETTINGS_CLOSED: 'tasks.error.videoSettingsRestarting',
  VIDEO_SETTINGS_STORAGE_UNAVAILABLE: 'tasks.error.videoSecretStore',
  VIDEO_SETTINGS_SAVE_FAILED: 'tasks.error.videoSettingsSaveUnconfirmed',
  VIDEO_SETTINGS_CORRUPT: 'tasks.error.videoSettingsUnreadable',
  VIDEO_SETTINGS_NOT_CONFIGURED: 'tasks.error.videoCredentialMissing',
  VIDEO_SETTINGS_DELETED: 'tasks.error.videoConnectionDeleted',
  VIDEO_SETTINGS_UNAVAILABLE: 'tasks.error.videoSettingsUnavailable',
  VIDEO_BINDING_INVALID: 'tasks.error.videoBindingInvalid',
  VIDEO_CREDENTIAL_UNAVAILABLE: 'tasks.error.videoCredentialUnavailable',
  VIDEO_CREDENTIAL_INVALID: 'tasks.error.videoCredentialInvalid',
  VIDEO_TASK_NOT_FOUND: 'tasks.error.videoProviderCannotFindTask',
  VIDEO_TASK_NOT_FOUND_WITH_REPLACEMENT: 'tasks.error.videoReplacementCannotFindTask',
  VIDEO_REPLACEMENT_NOT_AUTHORIZED: 'tasks.error.videoReplacementNotAuthorized',
} as const;

export function unsubmittedVideoConnection(job: JobDisplay | null | undefined): boolean {
  return job?.status === 'queued' && job.phase === 'connection_required' && job.providerJobId == null && job.submissionCount === 0;
}

export function cancelledBeforeSubmit(job: JobDisplay): boolean {
  return job.status === 'cancelled' && job.phase === 'cancelled_before_dispatch' && job.providerJobId == null && job.submissionCount === 0;
}

export function videoJobConnection(job: JobDisplay | null | undefined) {
  if (!job?.error || (job.phase !== 'connection_required' && job.phase !== 'connection_retrying') ||
    (job.status !== 'queued' && job.status !== 'running' && job.status !== 'downloading')) return null;
  const diagnostic = videoCredentialDiagnosticSchema.safeParse(typeof job.error === 'object' && 'diagnostic' in job.error ? job.error.diagnostic : undefined);
  const cause = diagnostic.success ? diagnostic.data.cause : null;
  const unsubmitted = unsubmittedVideoConnection(job);
  const requiresAction = unsubmitted || diagnostic.success && diagnostic.data.recovery === 'user_action';
  const hasProviderTask = typeof job.providerJobId === 'string' && job.providerJobId.length > 0;
  const legacyCode = safeTaskErrorCode(job.error);
  const storageBlocked = cause === 'VIDEO_SETTINGS_STORAGE_UNAVAILABLE' || cause === null && legacyCode === 'VIDEO_SETTINGS_STORAGE_UNAVAILABLE';
  let result: DisplayMessage | null = null;
  if (unsubmitted) result = message('tasks.error.videoUnsubmittedNoCharge');
  else if (hasProviderTask) {
    switch (cause) {
      case 'VIDEO_SETTINGS_CORRUPT': case 'VIDEO_SETTINGS_NOT_CONFIGURED': case 'VIDEO_CREDENTIAL_INVALID': case 'VIDEO_CREDENTIAL_UNAVAILABLE':
        result = message('tasks.error.videoRecoverWithOriginalAccount');
        break;
      case 'VIDEO_SETTINGS_DELETED':
        result = message('tasks.error.videoResultAtProvider');
        break;
      case 'VIDEO_TASK_NOT_FOUND': case 'VIDEO_TASK_NOT_FOUND_WITH_REPLACEMENT': case 'VIDEO_REPLACEMENT_NOT_AUTHORIZED':
        break;
      default:
        result = message('tasks.error.videoOriginalTaskRetained');
    }
  }
  return {
    diagnosticCode: cause ?? (legacyCode && Object.hasOwn(videoConnectionDetails, legacyCode) ? legacyCode : null),
    requiresAction,
    storageBlocked,
    status: message(storageBlocked ? 'tasks.status.videoSecretStoreWaiting' : requiresAction ? 'tasks.status.videoConnectionRequired' : 'tasks.status.videoConnectionWaiting'),
    detail: storageBlocked ? null : message(cause ? videoConnectionDetails[cause] : unsubmitted ? 'tasks.error.videoCredentialUnavailable' : 'tasks.error.videoConnectionUnclassified'),
    canCheckAgain: !storageBlocked && hasProviderTask && (job.status === 'running' || job.status === 'downloading'),
    result: storageBlocked ? null : result,
  };
}

export function jobStatusDescriptor(job: JobDisplay | null | undefined): DisplayMessage {
  if (job?.phase === 'output_review_required') return message('tasks.status.outputReview');
  return videoJobConnection(job)?.status ?? statusDescriptor(job?.status);
}
export const outputReviewDescriptor = message('tasks.outputReviewDisclosure');
export const workspaceHeldDescriptor = message('tasks.heldReason');

function knownProviderBrandName(id: unknown): string | null {
  switch (id) {
    case 'runway': return 'Runway';
    case 'ark': return 'Volcengine Ark';
    case 'veo': return 'Google Veo';
    case 'minimax': return 'MiniMax';
    case 'vidu': return 'Vidu';
    case 'kling': return 'Kling';
    case 'wan': return 'Wan';
    default: return null;
  }
}

/** Reads the structured HTTP status from providerFailure.httpStatus or PROVIDER_HTTP_<NNN>.
 * Never inspects or parses error.message. */
export function providerHttpStatus(error: unknown): number | null {
  if (error === null || typeof error !== 'object') return null;
  const providerFailure = 'providerFailure' in error ? error.providerFailure : null;
  if (providerFailure !== null && typeof providerFailure === 'object' && 'httpStatus' in providerFailure) {
    const status = (providerFailure as { httpStatus?: unknown }).httpStatus;
    if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) return status;
  }
  const code = safeTaskErrorCode(error);
  const match = code ? /^PROVIDER_HTTP_(\d{3})$/.exec(code) : null;
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed >= 400 && parsed <= 599 ? parsed : null;
}

/** Translates structured provider HTTP failures into plain language using the job's service name. */
export function providerHttpErrorDescriptor(error: unknown, service?: string): DisplayMessage | null {
  const code = safeTaskErrorCode(error);
  if (code === 'SUBMISSION_UNKNOWN' || code === 'PROVIDER_SUBMISSION_UNKNOWN') return null;
  const status = providerHttpStatus(error);
  if (status === null) return null;
  const providerFailure = error !== null && typeof error === 'object' && 'providerFailure' in error
    && error.providerFailure !== null && typeof error.providerFailure === 'object'
    ? error.providerFailure as { providerType?: unknown } : null;
  const resolvedService = (typeof service === 'string' ? service.trim() : '')
    || knownProviderBrandName(providerFailure?.providerType)
    || '';
  if (!resolvedService) {
    if (status === 401 || status === 403) return message('tasks.error.authorization');
    return message('tasks.error.providerFailed');
  }
  if (status === 401) return message('tasks.error.providerHttp401', { service: resolvedService });
  if (status === 402) return message('tasks.error.providerHttp402', { service: resolvedService });
  if (status === 403) return message('tasks.error.providerHttp403', { service: resolvedService });
  if (status === 404) return message('tasks.error.providerHttp404', { service: resolvedService });
  if (status === 429) return message('tasks.error.providerHttp429', { service: resolvedService });
  if (status >= 500 && status <= 599) return message('tasks.error.providerHttp5xx', { service: resolvedService });
  return message('tasks.error.providerHttpRejected', { service: resolvedService });
}

/** Provider HTTP failures require an explicit retryable flag. Other failures keep their existing actions. */
export function canRetryGenerationFailure(error: unknown): boolean {
  if (providerHttpStatus(error) === null) return true;
  return error !== null && typeof error === 'object' && 'retryable' in error && error.retryable === true;
}

export function taskErrorDescriptor(error: unknown, service?: string): DisplayMessage {
  const httpError = providerHttpErrorDescriptor(error, service);
  if (httpError) return httpError;
  const code = safeTaskErrorCode(error);
  switch (code) {
    case 'NETWORK': case 'NETWORK_ERROR': case 'TIMEOUT': case 'PROVIDER_TIMEOUT': return message('tasks.error.network');
    case 'UNAUTHORIZED': case 'FORBIDDEN': case 'PROVIDER_AUTH_FAILED': return message('tasks.error.authorization');
    case 'SUBMISSION_UNKNOWN': case 'PROVIDER_SUBMISSION_UNKNOWN': return message('tasks.error.submissionUnknown');
    case 'PROVIDER_GENERATION_FAILED': case 'GENERATION_FAILED': case 'PROVIDER_FAILED': case 'PROVIDER_ERROR': return message('tasks.error.providerFailed');
    case 'OUTPUT_WRITE_FAILED': case 'OUTPUT_VERIFY_FAILED': case 'OUTPUT_UNAVAILABLE': case 'OUTPUT_INVALID': return message('tasks.error.outputFailed');
    case 'EXPORT_CANCELLED': return message('tasks.error.exportCancelled');
    // The specific raw code stays available inside Details; the
    // sentence never asks the user to judge the saved state themselves.
    default: return code ? message('tasks.error.unknown') : message('tasks.error.safeSummary');
  }
}
/** Translate the frozen generation error code into the concrete failure line
 * shown by the property panel and the 21-09 panel, without exposing raw codes. */
export function generationFailureDescriptor(error: unknown, service?: string): DisplayMessage {
  const httpError = providerHttpErrorDescriptor(error, service);
  if (httpError) return httpError;
  const code = safeTaskErrorCode(error);
  switch (code) {
    case 'MOCK_GENERATION_FAILED': return message('tasks.error.mockGenerationFailed');
    case 'MOCK_RENDERER_UNSUPPORTED': return message('tasks.error.mockRendererUnsupported');
    case 'PROVIDER_GENERATION_FAILED': case 'PROVIDER_FAILED': case 'PROVIDER_ERROR':
    case 'PROVIDER_NOT_READY': case 'PROVIDER_NO_OUTPUT': return message('tasks.error.providerNoVideo');
    case 'DOWNLOAD_FAILED': return message('tasks.error.downloadFailed');
    case 'LOCAL_WAIT_STOPPED': case 'PROVIDER_CANCELLED': return message('tasks.error.generationCancelled');
    case 'GENERATION_STATE_CHANGED': return message('tasks.error.generationStateChanged');
    case 'SUBMISSION_UNKNOWN': case 'PROVIDER_SUBMISSION_UNKNOWN': return message('tasks.error.submissionUnknown');
    case 'PROVIDER_TIMEOUT': case 'TIMEOUT': case 'NETWORK': case 'NETWORK_ERROR': return message('tasks.error.network');
    case 'UNAUTHORIZED': case 'FORBIDDEN': case 'PROVIDER_AUTH_FAILED': return message('tasks.error.authorization');
    default: return message('tasks.error.generationFailed');
  }
}

export function formatBoardGenerationFailure(
  error: unknown,
  service: string | undefined,
  t: CreationTranslator,
  render: (descriptor: DisplayMessage) => string,
): string {
  const descriptor = generationFailureDescriptor(error, service);
  if (descriptor.key === 'tasks.error.generationFailed') return t('redesign.board.failed');
  return t('redesign.board.failureReason', { reason: render(descriptor) });
}

export function safeTaskErrorCode(error: unknown): string | null {
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(code) ? code : null;
}

import type { MessageArguments, MessageKey } from '../../../packages/i18n/src/index.ts';
type CreationTranslator = <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => string;
export function agentTimelineFrameDisplay(frame: number, fps: number, t: CreationTranslator): string {
  return t('agent.move.state.frameTime', { frame, framefps: (frame / fps).toFixed(3) });
}
export function agentTimelineGainDisplay(gain: number, t: CreationTranslator): string {
  return t('agent.gain.state.gainValue', { value: String(gain), value2: Number((gain * 100).toFixed(4)), value3: gain === 0 ? t('agent.gain.state.clipMuted') : '' });
}

/** Provider identities are fixed. Human-readable built-in descriptions are localized. */
export function providerDisplayName(provider: { id?: string; connectionId?: string; name?: string } | null | undefined, t: CreationTranslator): string {
  if (provider?.id === 'veo' && provider.connectionId) return t('video.providers.google');
  if (provider?.connectionId && provider.name) return provider.name;
  if (provider?.id === 'mock') return t('generation.provider.localSimulation');
  return knownProviderBrandName(provider?.id) || provider?.id || t('generation.provider.provider');
}

/** Resolves the human-readable service name from a persisted job record (preferring the recorded connection name). */
export function jobServiceDisplayName(
  job: { providerId?: unknown; snapshot?: unknown } | null | undefined,
  t: CreationTranslator,
  providers?: readonly { id?: string; connectionId?: string; name?: string }[],
): string {
  const snapshot = job?.snapshot && typeof job.snapshot === 'object' ? job.snapshot as Record<string, unknown> : null;
  const binding = snapshot?.executionBinding && typeof snapshot.executionBinding === 'object'
    ? snapshot.executionBinding as Record<string, unknown> : null;
  const connectionId = typeof binding?.connectionId === 'string' && binding.connectionId ? binding.connectionId : undefined;
  const connectionName = typeof snapshot?.executionConnectionName === 'string' && snapshot.executionConnectionName.trim()
    ? snapshot.executionConnectionName.trim() : undefined;
  if (connectionName) return connectionName;
  const providerId = typeof binding?.providerId === 'string' && binding.providerId
    ? binding.providerId
    : typeof job?.providerId === 'string' ? job.providerId : '';
  if (connectionId) {
    const live = providers?.find(provider => provider.connectionId === connectionId && (!providerId || provider.id === providerId));
    return providerDisplayName(live ?? { id: providerId, connectionId }, t);
  }
  const live = providers?.find(provider => !provider.connectionId && provider.id === providerId);
  return providerDisplayName(live ?? { id: providerId }, t);
}

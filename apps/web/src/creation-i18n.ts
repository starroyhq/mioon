/** React-compatible text interpolation without translating user content. */
export function creationParameter(value: unknown): string | number {
  return typeof value === 'string' || typeof value === 'number' ? value : '';
}

import { message } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
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
export function jobStatusDescriptor(job: { phase?: unknown; status?: unknown } | null | undefined): DisplayMessage {
  return job?.phase === 'output_review_required' ? message('tasks.status.outputReview') : statusDescriptor(job?.status);
}
export const outputReviewDescriptor = message('tasks.outputReviewDisclosure');
export const workspaceHeldDescriptor = message('tasks.heldReason');
export function taskErrorDescriptor(error: unknown): DisplayMessage {
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
  switch (code) {
    case 'NETWORK': case 'NETWORK_ERROR': case 'TIMEOUT': case 'PROVIDER_TIMEOUT': return message('tasks.error.network');
    case 'UNAUTHORIZED': case 'FORBIDDEN': case 'PROVIDER_AUTH_FAILED': return message('tasks.error.authorization');
    default: return message('tasks.error.safeSummary');
  }
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
export function providerDisplayName(provider: { id?: string } | null | undefined, t: CreationTranslator): string {
  switch (provider?.id) {
    case 'mock': return t('generation.provider.localSimulation');
    case 'runway': return 'Runway';
    case 'ark': return 'Volcengine Ark';
    case 'veo': return 'Google Veo';
    case 'minimax': return 'MiniMax';
    case 'vidu': return 'Vidu';
    default: return provider?.id || t('generation.provider.provider');
  }
}

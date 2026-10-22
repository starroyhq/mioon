import type { agentTaskErrorMessages } from '../../../packages/i18n/src/catalogs/agent-task-errors.ts';

type ErrorKey = keyof typeof agentTaskErrorMessages;
const codes: Readonly<Record<string, ErrorKey>> = Object.freeze({
  AGENT_TASK_SKIP_REQUIRED:'agent.task.error.skipRequired', AGENT_TASK_NOTE_LIMIT:'agent.task.error.noteLimit', AGENT_TASK_NOTE_CAPACITY:'agent.task.error.noteCapacity', TARGET_SKIPPED:'agent.task.error.targetSkipped',
  AGENT_TASK_NOT_FOUND:'agent.task.error.notFound', AGENT_CHAT_NOT_FOUND:'agent.task.error.notFound',
  AGENT_TASK_READ_ONLY:'agent.task.error.readOnly', AGENT_TASK_STOPPED:'agent.task.error.stopped', AGENT_CHAT_ABORTED:'agent.task.error.stopped',
  AGENT_TASK_INVALID:'agent.task.error.validation', AGENT_CHAT_VALIDATION:'agent.task.error.validation',
  AGENT_TASK_BUSY:'agent.task.error.busy', AGENT_CHAT_BUSY:'agent.task.error.busy',
  AGENT_TASK_CONSENT_REQUIRED:'agent.task.error.consent', AGENT_AUTHORIZATION_REQUIRED:'agent.task.error.consent',
  AGENT_TASK_SETTINGS_CHANGED:'agent.task.error.changed', AGENT_TASK_TARGET_CHANGED:'agent.task.error.changed',
  AGENT_CHAT_CONTEXT_CHANGED:'agent.task.error.changed', AGENT_TASK_TARGET_CLAIMED:'agent.task.error.editing',
  AGENT_TASK_UNKNOWN_RESULT:'agent.task.error.unknown', REQUEST_UNCONFIRMED:'agent.task.error.unknown', OPERATION_PENDING:'agent.task.error.unknown',
  AGENT_TASK_REVISION_CONFLICT:'agent.task.error.changed', REVISION_CONFLICT:'agent.task.error.changed',
  AGENT_TASK_REQUEST_CONFLICT:'agent.task.error.changed', IDEMPOTENCY_CONFLICT:'agent.task.error.changed',
  AGENT_TASK_STORAGE_UNAVAILABLE:'agent.task.error.storage', AGENT_CHAT_STORAGE_UNAVAILABLE:'agent.task.error.storage', LOCAL_RECEIPT_UNAVAILABLE:'agent.task.error.receipt',
  AGENT_TASK_APPROVAL_REQUIRED:'agent.task.error.approval', AGENT_TASK_PAUSED:'agent.task.error.paused',
  AGENT_CHAT_CONNECT_FAILED:'agent.task.error.connection', NETWORK:'agent.task.error.localConnection',
  AGENT_CHAT_NETWORK_DENIED:'agent.task.error.networkDenied', AGENT_CHAT_TIMEOUT:'agent.task.error.timeout',
  AGENT_CHAT_HTTP_ERROR:'agent.task.error.modelRejected', AGENT_CHAT_KEY_REQUIRED:'agent.task.error.key',
  AGENT_CHAT_PROTOCOL_ERROR:'agent.task.error.protocol', AGENT_CHAT_TRUNCATED:'agent.task.error.protocol',
  AGENT_CHAT_PROFILE_UNSUPPORTED:'agent.task.error.protocol', AGENT_CHAT_REASONING_UNSUPPORTED:'agent.task.error.protocol',
  INVALID_RESPONSE:'agent.task.error.localResponse', AGENT_CHAT_LIMIT:'agent.task.error.limit', AGENT_CHAT_STORAGE_LIMIT:'agent.task.error.limit',
  AGENT_CHAT_TOOLS_UNSUPPORTED:'agent.task.error.tools', AGENT_CHAT_INSPECTION_UNAVAILABLE:'agent.task.error.tools',
  AGENT_CHAT_PROVIDER_ERROR:'agent.task.error.provider', REQUEST_BLOCKED:'agent.task.error.changed', UPLOAD_REJECTED:'agent.task.error.upload',
});

/** Only stable codes choose a template. Diagnostic text and unknown codes are
 * never echoed, even for records produced by an older application version. */
export function agentTaskErrorKey(code: unknown): ErrorKey {
  if (typeof code !== 'string') return 'agent.task.error.generic';
  if (Object.hasOwn(codes, code)) return codes[code];
  if (/^(?:FFMPEG_|FFPROBE_|TIMELINE_(?:SUBTITLE|EXPORT|RENDER)_)/u.test(code)) return 'agent.task.error.media';
  return 'agent.task.error.generic';
}

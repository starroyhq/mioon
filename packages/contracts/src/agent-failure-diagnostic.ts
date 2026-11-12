import { z } from 'zod';

// Provider HTTP metadata is restricted to known codes.
const providerLabels = z.enum([
  'api_error', 'authentication_error', 'billing_error', 'billing_hard_limit_reached',
  'billing_not_active', 'content_policy_violation', 'context_length_exceeded',
  'credit_balance_exhausted', 'insufficient_quota', 'internal_error', 'invalid_api_key',
  'invalid_authentication', 'invalid_request', 'invalid_request_error', 'model_not_found',
  'not_found_error', 'organization_spend_limit_exceeded', 'organization_usage_limit_exceeded',
  'overloaded_error', 'permission_denied', 'permission_error', 'project_spend_limit_exceeded',
  'rate_limit_error', 'rate_limit_exceeded', 'request_timeout', 'request_too_large',
  'resource_not_found', 'server_error', 'server_overloaded', 'service_unavailable',
  'unsupported_parameter', 'unsupported_value', 'usage_limit_exceeded',
]);
const upstreamStatus = z.number().int().min(100).max(599).refine(status => status < 200 || status >= 300);
export const agentHttpFailureDiagnosticSchema = z.object({
  kind: z.literal('http'),
  status: upstreamStatus,
  providerType: providerLabels.optional(),
  providerCode: z.union([providerLabels, z.number().int().min(400).max(599)]).optional(),
}).strict();
export type AgentHttpFailureDiagnostic = z.infer<typeof agentHttpFailureDiagnosticSchema>;

const protocolReason = z.enum([
  'terminal_mismatch', 'unknown_event', 'unsupported_item', 'invalid_event', 'invalid_field',
  'incomplete_stream', 'provider_error',
]);
export type AgentProtocolFailureReason = z.infer<typeof protocolReason>;

const knownProtocolEvent = z.enum([
  'message', 'error', 'ping', 'message_start', 'message_delta', 'message_stop',
  'content_block_start', 'content_block_delta', 'content_block_stop', 'response.created',
  'response.in_progress', 'response.completed', 'response.incomplete', 'response.failed',
  'response.output_item.added', 'response.output_item.done', 'response.output_text.delta',
  'response.output_text.done', 'response.function_call_arguments.delta',
  'response.function_call_arguments.done', 'response.content_part.added', 'response.content_part.done',
  'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done',
  'response.reasoning_text.delta', 'response.reasoning_text.done', 'response.refusal.delta',
  'response.refusal.done', 'response.web_search_call.in_progress', 'response.web_search_call.searching',
  'response.web_search_call.completed', 'response.queued', 'response.output_text.annotation.added',
  'response.audio.delta', 'response.audio.done', 'response.audio.transcript.delta',
  'response.audio.transcript.done', 'response.compaction.compacting',
  'response.code_interpreter_call_code.delta', 'response.code_interpreter_call_code.done',
  'response.code_interpreter_call.completed', 'response.code_interpreter_call.in_progress',
  'response.code_interpreter_call.interpreting', 'response.custom_tool_call_input.delta',
  'response.custom_tool_call_input.done', 'response.file_search_call.completed',
  'response.file_search_call.in_progress', 'response.file_search_call.searching',
  'response.image_generation_call.completed', 'response.image_generation_call.generating',
  'response.image_generation_call.in_progress', 'response.image_generation_call.partial_image',
  'response.mcp_call_arguments.delta', 'response.mcp_call_arguments.done', 'response.mcp_call.completed',
  'response.mcp_call.failed', 'response.mcp_call.in_progress', 'response.mcp_list_tools.completed',
  'response.mcp_list_tools.failed', 'response.mcp_list_tools.in_progress',
  'response.shell_call_command.added', 'response.shell_call_command.delta',
  'response.shell_call_command.done', 'response.shell_call_output_content.delta',
  'response.shell_call_output_content.done', 'response.steer.accepted', 'response.steer',
  'response.steer.failed', 'response.steer.pending',
  'unrecognized',
]);
const knownProtocolItem = z.enum([
  'message', 'function_call', 'reasoning', 'output_text', 'summary_text', 'reasoning_text',
  'text', 'thinking', 'redacted_thinking', 'tool_use', 'function', 'server_tool_use',
  'web_search_call', 'file_search_call', 'computer_call', 'image_generation_call',
  'custom_tool_call', 'refusal', 'code_interpreter_call', 'compaction', 'mcp_call',
  'mcp_list_tools', 'mcp_approval_request', 'local_shell_call', 'shell_call', 'apply_patch_call',
  'tool_search_call', 'unrecognized',
]);
const knownProtocolField = z.enum([
  'sse_framing', 'utf8', 'chunk', 'json', 'content_type', 'content_encoding', 'done',
  'read', 'output', 'type', 'id', 'status', 'role', 'content', 'summary', 'encrypted_content',
  'phase', 'call_id', 'name', 'arguments', 'annotations', 'text', 'item_id', 'output_index',
  'content_index', 'summary_index', 'finish_reason', 'stop_reason', 'choices', 'delta',
  'tool_calls', 'index', 'reasoning_content', 'reasoning_details', 'thinking', 'signature',
  'event_name', 'function_call', 'part', 'partial_json', 'usage', 'input_transformations',
  'stop_sequence', 'input', 'content_block', 'model', 'stop_details', 'container', 'service_tier',
  'diagnostics', 'citations', 'caller', 'toolset_name', 'data', 'body', 'sdk_response', 'upgrade',
  'unknown_field', 'unrecognized',
]);
// The ASCII alphabet makes the Responses character bound a byte bound too.
const responsesEventName = z.string().max(96).regex(/^response(\.[a-z][a-z0-9_]{0,40}){1,4}$/u);
const protocolIdentifier = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/u);
const responsesProtocolEvent = knownProtocolEvent.or(responsesEventName);
const anthropicProtocolEvent = knownProtocolEvent.or(protocolIdentifier);
const protocolItem = knownProtocolItem.or(protocolIdentifier);
const protocolField = knownProtocolField.or(protocolIdentifier);
const agentProtocolFailureDiagnosticSchema = z.object({
  kind: z.literal('protocol'),
  reason: protocolReason,
  event: responsesProtocolEvent.or(protocolIdentifier).optional(),
  item: protocolItem.optional(),
  field: protocolField.optional(),
}).strict();

const failureLimit = z.enum([
  'stream_bytes', 'stream_event_bytes', 'stream_events', 'output_bytes', 'reasoning_bytes',
  'argument_bytes', 'tool_calls', 'output_items', 'max_output_tokens', 'identifier_bytes',
  'encrypted_content_bytes', 'reasoning_item_bytes', 'history_bytes', 'request_bytes', 'context_tokens',
  'field_bytes', 'usage_tokens',
]);
export type AgentFailureLimit = z.infer<typeof failureLimit>;
const agentLimitFailureDiagnosticSchema = z.object({ kind: z.literal('limit'), limit: failureLimit }).strict();
export const agentFailureDiagnosticSchema = z.discriminatedUnion('kind', [
  agentHttpFailureDiagnosticSchema, agentProtocolFailureDiagnosticSchema, agentLimitFailureDiagnosticSchema,
]);
export type AgentFailureDiagnostic = z.infer<typeof agentFailureDiagnosticSchema>;

export function agentHttpFailureDiagnostic(status: unknown, type?: unknown, code?: unknown): AgentHttpFailureDiagnostic | undefined {
  const safeStatus = upstreamStatus.safeParse(status);
  if (!safeStatus.success) return undefined;
  const providerType = providerLabels.safeParse(type);
  const providerCode = agentHttpFailureDiagnosticSchema.shape.providerCode.safeParse(code);
  return {
    kind: 'http',
    status: safeStatus.data,
    ...(providerType.success ? { providerType: providerType.data } : {}),
    ...(providerCode.success && providerCode.data !== undefined ? { providerCode: providerCode.data } : {}),
  };
}

export function agentProtocolFailureDiagnostic(reason: AgentProtocolFailureReason, details: {
  event?: unknown;
  eventProtocol?: 'responses' | 'anthropic_messages';
  item?: unknown;
  field?: unknown;
} = {}): z.infer<typeof agentProtocolFailureDiagnosticSchema> {
  const eventSchema = details.eventProtocol === 'responses' ? responsesProtocolEvent
    : details.eventProtocol === 'anthropic_messages' ? anthropicProtocolEvent : knownProtocolEvent;
  const event = eventSchema.safeParse(details.event);
  const item = protocolItem.safeParse(details.item);
  const field = protocolField.safeParse(details.field);
  return {
    kind: 'protocol',
    reason,
    ...(details.event !== undefined ? { event: event.success ? event.data : 'unrecognized' } : {}),
    ...(details.item !== undefined ? { item: item.success ? item.data : 'unrecognized' } : {}),
    ...(details.field !== undefined ? { field: field.success ? field.data : 'unrecognized' } : {}),
  };
}

import {buildAgentChatBody, createChatCompletionGateway, validateAgentChatConfiguration} from './chat-completions.ts';
import {buildAgentResponsesBody, createResponsesGateway, validateAgentResponsesConfiguration} from './responses.ts';
import {agentChatError} from './chat-errors.ts';
import type {AgentConfiguration} from './config.ts';
import type {ToolCall, WireMessage} from './tool-wire.ts';
import type {AgentTransportDependencies} from './network-policy.ts';

export interface AgentUsage {prompt_tokens?: number; completion_tokens?: number; total_tokens?: number}
export interface AgentStreamDelta {type: 'delta'; text: string}
export interface AgentStreamDone {
  type: 'done';
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  usage?: AgentUsage;
  toolCall?: ToolCall;
  providerOutput?: unknown;
}
export type AgentStreamItem = AgentStreamDelta | AgentStreamDone;
export interface AgentDispatchOptions {
  configuration: AgentConfiguration;
  apiKey?: string | null;
  messages: readonly WireMessage[];
  signal?: AbortSignal;
  selfPort?: number;
  readTools?: unknown;
  beforeSubmit?: (() => void) | undefined;
}
export type AgentGateway = (options: AgentDispatchOptions) => AsyncGenerator<AgentStreamItem, void, undefined>;
export interface AgentGatewayValidationOptions {selfPort?: number; readTools?: unknown}

/** Pure preflight, called before acquiring a credential or opening a socket. */
export function validateAgentGatewayConfiguration(configuration: unknown, options: AgentGatewayValidationOptions = {}): AgentConfiguration {
  const protocol = (configuration as {protocol?: unknown} | null | undefined)?.protocol;
  if (protocol === 'chat_completions') return validateAgentChatConfiguration(configuration, options);
  if (protocol === 'responses') return validateAgentResponsesConfiguration(configuration, options);
  throw agentChatError('AGENT_CHAT_VALIDATION');
}
/** Build the exact key-free body for durable request journaling before dispatch. */
export function buildAgentRequest(options: AgentDispatchOptions): {configuration: AgentConfiguration; body: string} {
  const configuration = validateAgentGatewayConfiguration(options.configuration, {selfPort: options.selfPort, readTools: options.readTools});
  return (configuration.protocol === 'responses' ? buildAgentResponsesBody : buildAgentChatBody)({...options, configuration});
}
/** Explicit, single dispatch. Never probe, retry or fall back to another API. */
export function createAgentGateway(dependencies: AgentTransportDependencies = {}): AgentGateway {
  const chat = createChatCompletionGateway(dependencies), responses = createResponsesGateway(dependencies);
  return async function* streamAgentResponse(options: AgentDispatchOptions): AsyncGenerator<AgentStreamItem, void, undefined> {
    if (options.signal?.aborted) throw agentChatError('AGENT_CHAT_ABORTED');
    const configuration = validateAgentGatewayConfiguration(options.configuration, {selfPort: options.selfPort, readTools: options.readTools});
    yield* (configuration.protocol === 'responses' ? responses : chat)({...options, configuration});
  };
}
export const streamAgentResponse = createAgentGateway();

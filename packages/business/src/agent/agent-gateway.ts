import {buildAgentChatBody, createChatCompletionGateway} from './chat-completions.ts';
import {buildAgentResponsesBody, createResponsesGateway} from './responses.ts';
import {buildAgentAnthropicBody, createAnthropicMessagesGateway} from './anthropic-messages.ts';
import {validateAgentGatewayConfiguration as validateProfileConfiguration} from './model-profiles.ts';
import {agentChatError} from './chat-errors.ts';
import type {AgentConfiguration} from './config.ts';
import {validateReadTools} from './tool-wire.ts';
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
  const config = validateProfileConfiguration(configuration, {selfPort: options.selfPort});
  validateReadTools(config, options.readTools);
  return config;
}
/** Build the exact key-free body for durable request journaling before dispatch. */
export function buildAgentRequest(options: AgentDispatchOptions): {configuration: AgentConfiguration; body: string} {
  const configuration = validateAgentGatewayConfiguration(options.configuration, {selfPort: options.selfPort, readTools: options.readTools});
  if (configuration.protocol === 'anthropic_messages') return buildAgentAnthropicBody({...options, configuration});
  return (configuration.protocol === 'responses' ? buildAgentResponsesBody : buildAgentChatBody)({...options, configuration});
}
/** Explicit, single dispatch. Never probe, retry or fall back to another API. */
export function createAgentGateway(dependencies: AgentTransportDependencies = {}): AgentGateway {
  const chat = createChatCompletionGateway(dependencies), responses = createResponsesGateway(dependencies), anthropic = createAnthropicMessagesGateway(dependencies);
  return async function* streamAgentResponse(options: AgentDispatchOptions): AsyncGenerator<AgentStreamItem, void, undefined> {
    if (options.signal?.aborted) throw agentChatError('AGENT_CHAT_ABORTED');
    const configuration = validateAgentGatewayConfiguration(options.configuration, {selfPort: options.selfPort, readTools: options.readTools});
    if (configuration.protocol === 'anthropic_messages') {yield* anthropic({...options, configuration}); return;}
    yield* (configuration.protocol === 'responses' ? responses : chat)({...options, configuration});
  };
}
export const streamAgentResponse = createAgentGateway();

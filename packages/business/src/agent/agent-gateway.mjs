import {createChatCompletionGateway, validateAgentChatConfiguration} from './chat-completions.mjs';
import {createResponsesGateway, validateAgentResponsesConfiguration} from './responses.mjs';
import {agentChatError} from './chat-errors.mjs';

/** Pure preflight, called before acquiring a credential or opening a socket. */
export function validateAgentGatewayConfiguration(configuration, options = {}) {
  if (configuration?.protocol === 'chat_completions') return validateAgentChatConfiguration(configuration, options);
  if (configuration?.protocol === 'responses') return validateAgentResponsesConfiguration(configuration, options);
  throw agentChatError('AGENT_CHAT_VALIDATION');
}
/** Explicit, single dispatch. Never probe, retry or fall back to another API. */
export function createAgentGateway(dependencies = {}) {
  const chat = createChatCompletionGateway(dependencies), responses = createResponsesGateway(dependencies);
  return async function* streamAgentResponse(options) {
    if (options.signal?.aborted) throw agentChatError('AGENT_CHAT_ABORTED');
    const configuration = validateAgentGatewayConfiguration(options.configuration, {selfPort: options.selfPort});
    yield* (configuration.protocol === 'responses' ? responses : chat)({...options, configuration});
  };
}
export const streamAgentResponse = createAgentGateway();

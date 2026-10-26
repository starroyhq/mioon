import type {AnthropicNativeStreamEvent} from '../../packages/business/src/agent/anthropic-sdk-transport.ts';

/** Full SDK response shapes, including its required nullable metadata. Keeping
 * these fixtures typed prevents a minimal hand-written wire subset from hiding
 * incompatibilities with the installed official SDK's native event contract. */
export function nativeAnthropicEvents({model = 'synthetic-text-model', text = '你好，Mio 🙂', toolName, argumentsJson = '{ }'}:
  {model?: string; text?: string; toolName?: string; argumentsJson?: string} = {}): AnthropicNativeStreamEvent[] {
  const start: Extract<AnthropicNativeStreamEvent, {type: 'message_start'}> = {
    type: 'message_start',
    message: {id: 'msg_native_fixture', type: 'message', role: 'assistant', model, content: [], container: null, diagnostics: null,
      stop_details: null, stop_reason: null, stop_sequence: null,
      usage: {input_tokens: 3, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null,
        cache_creation: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null, speed: null}},
  };
  const block: Extract<AnthropicNativeStreamEvent, {type: 'content_block_start'}> = {
    type: 'content_block_start', index: 0, content_block: toolName
      ? {type: 'tool_use', id: 'tool_native_fixture', name: toolName, input: {}, caller: {type: 'direct'}, toolset_name: null}
      : {type: 'text', text: '', citations: null},
  };
  const delta: Extract<AnthropicNativeStreamEvent, {type: 'content_block_delta'}> = {
    type: 'content_block_delta', index: 0, delta: toolName ? {type: 'input_json_delta', partial_json: argumentsJson} : {type: 'text_delta', text},
  };
  const finish: Extract<AnthropicNativeStreamEvent, {type: 'message_delta'}> = {
    type: 'message_delta', delta: {stop_reason: toolName ? 'tool_use' : 'end_turn', stop_sequence: null, container: null, stop_details: null},
    usage: {input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens: 3, output_tokens_details: null, server_tool_use: null},
  };
  return [start, block, delta, {type: 'content_block_stop', index: 0}, finish, {type: 'message_stop'}];
}

export function nativeAnthropicSse(events: readonly AnthropicNativeStreamEvent[]): string {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

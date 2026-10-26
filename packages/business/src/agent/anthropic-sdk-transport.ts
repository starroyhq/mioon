import Anthropic from '@anthropic-ai/sdk';
import {deriveAgentEndpoint} from '@mioon/contracts';
import {parseAgentConfiguration, MAX_AGENT_SECRET_BYTES} from './config.ts';
import {agentChatError, agentChatStreamError} from './chat-errors.ts';
import {createAgentTransport, AGENT_NETWORK_LIMITS} from './network-policy.ts';
import {ANTHROPIC_MESSAGES_API_VERSION} from './anthropic-protocol.ts';
import type {AgentTransport, AgentTransportDependencies, AgentTransportStream} from './network-policy.ts';
export type {RawMessageStreamEvent as AnthropicNativeStreamEvent} from '@anthropic-ai/sdk/resources/messages';

/** The real SDK builds/serializes the call, while the host owns credentials,
 * endpoint authorization, DNS/TLS, timeouts, redirects and safe errors. SDK
 * middleware/tool runners and its environment credential chain are not used. */
export function createAnthropicSdkTransport(dependencies: AgentTransportDependencies = {}): AgentTransport {
  const open = createAgentTransport(dependencies);
  return async function request(options): Promise<AgentTransportStream> {
    // Bind the caller's intent and credential before the SDK's async hooks.
    options = {...options};
    const configuration = parseAgentConfiguration(options.configuration, {selfPort: options.selfPort});
    if (configuration.protocol !== 'anthropic_messages') throw agentChatError('AGENT_CHAT_VALIDATION');
    if (configuration.presetId !== 'ollama' && (typeof options.apiKey !== 'string' || !options.apiKey)) throw agentChatError('AGENT_CHAT_KEY_REQUIRED');
    if (options.apiKey != null && options.apiKey !== '' && (typeof options.apiKey !== 'string' || Buffer.byteLength(options.apiKey) > MAX_AGENT_SECRET_BYTES || !/^[\x21-\x7e]+$/.test(options.apiKey))) throw agentChatError('AGENT_CHAT_VALIDATION');
    const endpoint = deriveAgentEndpoint(configuration);
    let body: unknown;
    try { body = JSON.parse(options.body); } catch { throw agentChatError('AGENT_CHAT_VALIDATION'); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || (body as {stream?: unknown}).stream !== true ||
      (body as {model?: unknown}).model !== configuration.model) throw agentChatError('AGENT_CHAT_VALIDATION');
    let transport: AgentTransportStream | undefined, transportFailure: unknown;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, used = false;
    const close = () => { transport?.close(); void reader?.cancel().catch(() => undefined); };
    const sdk = new Anthropic({
      // The SDK-only placeholder is never used by the host's keyless local
      // request. Remote requests still require an explicitly bound credential.
      baseURL: configuration.baseUrl, apiKey: options.apiKey || 'mioon-local-sdk-placeholder',
      authToken: null, credentials: null, config: null, profile: null, webhookKey: null,
      maxRetries: 0, logLevel: 'off', openTelemetry: false,
      // The pinned host transport's earlier deadline owns timeout classification.
      timeout: AGENT_NETWORK_LIMITS.totalTimeoutMs + 1000,
      defaultHeaders: {'anthropic-version': ANTHROPIC_MESSAGES_API_VERSION},
      fetch: async (input, init) => {
        try {
          // Any SDK transformation or second fetch fails before host dispatch.
          // SDK/environment headers never cross this boundary; the host creates
          // only this protocol's approved authentication and version headers.
          if (used || String(input) !== endpoint || init?.method !== 'POST' || init.body !== options.body) throw agentChatError('AGENT_CHAT_VALIDATION');
          used = true;
          const signals = [options.signal, init.signal].filter((signal): signal is AbortSignal => signal != null);
          transport = await open({...options, configuration, signal: signals.length ? AbortSignal.any(signals) : undefined});
          const incoming = transport, iterator = incoming.body[Symbol.asyncIterator]();
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); }
              catch (error) { controller.error(error); }
            },
            cancel() { incoming.close(); void iterator.return?.().catch(() => undefined); },
          }, {highWaterMark: 0});
          return new Response(stream, {status: 200, headers: {'Content-Type': 'text/event-stream'}});
        } catch (error) { transportFailure = error; throw error; }
      },
    });
    try {
      const response = await sdk.messages.create(body as Anthropic.Messages.MessageCreateParamsStreaming, {signal: options.signal}).asResponse();
      if (!transport || !response.body) throw agentChatError('AGENT_CHAT_PROTOCOL_ERROR');
      const incoming = transport, responseReader = response.body.getReader(); reader = responseReader;
      const bodyStream = async function* (): AsyncGenerator<Uint8Array, void, undefined> {
        try {
          for (;;) { const next = await responseReader.read(); if (next.done) return; yield next.value; }
        } catch {
          if (options.signal?.aborted) throw agentChatError('AGENT_CHAT_ABORTED');
          const failure = incoming.error();
          throw failure && failure.code !== 'AGENT_CHAT_TRUNCATED' ? failure : agentChatStreamError('read_failed');
        } finally { close(); }
      };
      return {body: bodyStream(), close, error: () => incoming.error()};
    } catch {
      close();
      if (transportFailure !== undefined) throw transportFailure;
      throw agentChatError(options.signal?.aborted ? 'AGENT_CHAT_ABORTED' : 'AGENT_CHAT_PROTOCOL_ERROR');
    }
  };
}

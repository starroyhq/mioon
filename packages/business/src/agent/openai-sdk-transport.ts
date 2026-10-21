import OpenAI from 'openai';
import {deriveAgentEndpoint} from '@mioon/contracts';
import {parseAgentConfiguration} from './config.ts';
import {agentChatError} from './chat-errors.ts';
import {createAgentTransport, AGENT_NETWORK_LIMITS} from './network-policy.ts';
import type {AgentTransport, AgentTransportDependencies, AgentTransportStream} from './network-policy.ts';

/** The SDK owns the API call and JSON serialization. Its fetch boundary stays
 * inside Mioon's pinned transport; SDK headers, environment credentials, retries
 * and redirects cannot create another network path. Raw responses deliberately
 * retain the harness's bounded UTF-8/SSE and terminal-evidence validation. */
export function createOpenAiSdkTransport(dependencies: AgentTransportDependencies = {}): AgentTransport {
  const open = createAgentTransport(dependencies);
  return async function request(options): Promise<AgentTransportStream> {
    const configuration = parseAgentConfiguration(options.configuration, {selfPort: options.selfPort});
    const endpoint = deriveAgentEndpoint(configuration);
    const body: unknown = JSON.parse(options.body);
    if (!body || typeof body !== 'object' || Array.isArray(body) || (body as {stream?: unknown}).stream !== true) throw agentChatError('AGENT_CHAT_VALIDATION');
    let transport: AgentTransportStream | undefined, transportFailure: unknown;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, used = false;
    const close = () => {
      transport?.close();
      void reader?.cancel().catch(() => undefined);
    };
    const sdk = new OpenAI({
      baseURL: configuration.baseUrl,
      // A fixed SDK-only placeholder supports keyless local Ollama. Only the
      // host's bound options.apiKey reaches the actual HTTP transport.
      apiKey: options.apiKey || 'mioon-local-sdk-placeholder',
      adminAPIKey: null, organization: null, project: null,
      maxRetries: 0, timeout: AGENT_NETWORK_LIMITS.totalTimeoutMs, logLevel: 'off',
      fetch: async (input, init) => {
        try {
          // Compare exact serialized bytes with the request already journaled.
          // A future SDK transformation must fail before any HTTP dispatch.
          if (used || String(input) !== endpoint || init?.method !== 'POST' || init.body !== options.body) throw agentChatError('AGENT_CHAT_VALIDATION');
          used = true;
          const signals = [options.signal, init.signal].filter((signal): signal is AbortSignal => signal != null);
          transport = await open({...options, configuration, signal: signals.length ? AbortSignal.any(signals) : undefined});
          const incoming = transport;
          const iterator = incoming.body[Symbol.asyncIterator]();
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const next = await iterator.next();
                if (next.done) controller.close();
                else controller.enqueue(next.value);
              } catch (error) { controller.error(error); }
            },
            cancel() {
              incoming.close();
              void iterator.return?.().catch(() => undefined);
            },
          }, {highWaterMark: 0});
          return new Response(stream, {status: 200, headers: {'Content-Type': 'text/event-stream'}});
        } catch (error) {
          // SDK connection errors wrap fetch failures. Keep the original trusted
          // object, including Mioon's private no-dispatch and safe HTTP evidence.
          transportFailure = error;
          throw error;
        }
      },
    });
    try {
      // These casts adapt validated, journaled JSON (including explicit vendor
      // extensions) to the SDK's OpenAI-only request types; no fields are added.
      const response = configuration.protocol === 'chat_completions'
        ? await sdk.chat.completions.create(body as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, {signal: options.signal}).asResponse()
        : await sdk.responses.create(body as OpenAI.Responses.ResponseCreateParamsStreaming, {signal: options.signal}).asResponse();
      if (!transport || !response.body) throw agentChatError('AGENT_CHAT_PROTOCOL_ERROR');
      const incoming = transport, responseReader = response.body.getReader();
      reader = responseReader;
      const bodyStream = async function* (): AsyncGenerator<Uint8Array, void, undefined> {
        try {
          for (;;) {
            const next = await responseReader.read();
            if (next.done) return;
            yield next.value;
          }
        } catch {
          if (options.signal?.aborted) throw agentChatError('AGENT_CHAT_ABORTED');
          throw incoming.error() || agentChatError('AGENT_CHAT_TRUNCATED');
        } finally { close(); }
      };
      return {body: bodyStream(), close, error: () => incoming.error()};
    } catch {
      close();
      if (transportFailure !== undefined) throw transportFailure;
      // Never expose SDK error messages, headers or provider response bodies.
      throw agentChatError(options.signal?.aborted ? 'AGENT_CHAT_ABORTED' : 'AGENT_CHAT_PROTOCOL_ERROR');
    }
  };
}

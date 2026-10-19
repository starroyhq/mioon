import {agentChatError} from './chat-errors.ts';

export const AGENT_SSE_LIMITS = Object.freeze({maxBytes: 1024 * 1024, maxEventBytes: 64 * 1024, maxEvents: 8192});
export interface AgentSseOptions {
  maxBytes?: number;
  maxEventBytes?: number;
  maxEvents?: number;
  includeEventName?: boolean;
  signal?: AbortSignal;
}
export interface AgentSseEvent {
  event: string;
  data: string;
  eventName?: string | null;
}
type AgentSseLimits = Required<Pick<AgentSseOptions, 'maxBytes' | 'maxEventBytes' | 'maxEvents'>>;

/** Bounded UTF-8 SSE framing. No reconnect, event-id execution or URL handling.
 * A final unterminated data frame is truncated, never implicitly dispatched.
 * Opt-in eventName preserves explicit naming (including empty names), so native
 * protocol validation can distinguish it from default data-only framing. */
export async function* parseAgentSse(source: AsyncIterable<Uint8Array>, options: AgentSseOptions = {}): AsyncGenerator<AgentSseEvent, void, undefined> {
  const limits: AgentSseLimits = {maxBytes: options.maxBytes ?? AGENT_SSE_LIMITS.maxBytes, maxEventBytes: options.maxEventBytes ?? AGENT_SSE_LIMITS.maxEventBytes, maxEvents: options.maxEvents ?? AGENT_SSE_LIMITS.maxEvents};
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let line = '', lineBytes = 0, skipLF = false, bytes = 0, eventBytes = 0, events = 0;
  let event = '', eventNamed = false;
  const data: string[] = [];
  let hasData = false;
  function acceptLine(value: string): AgentSseEvent | null {
    eventBytes += Buffer.byteLength(value, 'utf8') + 1;
    if (eventBytes > limits.maxEventBytes) throw agentChatError('AGENT_CHAT_LIMIT');
    if (!value) {
      const result: AgentSseEvent | null = hasData ? {event: event || 'message', data: data.join('\n'), ...(options.includeEventName ? {eventName: eventNamed ? event : null} : {})} : null;
      event = ''; eventNamed = false; data.length = 0; hasData = false; eventBytes = 0;
      if (result && ++events > limits.maxEvents) throw agentChatError('AGENT_CHAT_LIMIT');
      return result;
    }
    if (value.startsWith(':')) return null;
    const colon = value.indexOf(':');
    const name = colon === -1 ? value : value.slice(0, colon);
    let field = colon === -1 ? '' : value.slice(colon + 1);
    if (field.startsWith(' ')) field = field.slice(1);
    if (name === 'data') { hasData = true; data.push(field); }
    else if (name === 'event') { event = field; eventNamed = true; }
    return null;
  }
  function* consume(text: string): Generator<AgentSseEvent, void, undefined> {
    if (skipLF && text) { if (text[0] === '\n') text = text.slice(1); skipLF = false; }
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== '\r' && text[i] !== '\n') continue;
      const segment = text.slice(start, i);
      line += segment; lineBytes += Buffer.byteLength(segment, 'utf8');
      if (lineBytes + eventBytes > limits.maxEventBytes) throw agentChatError('AGENT_CHAT_LIMIT');
      const framed = acceptLine(line); line = ''; lineBytes = 0;
      if (framed) yield framed;
      if (text[i] === '\r') {
        if (text[i + 1] === '\n') i++;
        else if (i === text.length - 1) skipLF = true;
      }
      start = i + 1;
    }
    const segment = text.slice(start);
    line += segment; lineBytes += Buffer.byteLength(segment, 'utf8');
    if (lineBytes + eventBytes > limits.maxEventBytes) throw agentChatError('AGENT_CHAT_LIMIT');
  }
  for await (const chunk of source) {
    if (options.signal?.aborted) throw agentChatError('AGENT_CHAT_ABORTED');
    if (!(chunk instanceof Uint8Array)) throw agentChatError('AGENT_CHAT_PROTOCOL_ERROR');
    bytes += chunk.byteLength;
    if (bytes > limits.maxBytes) throw agentChatError('AGENT_CHAT_LIMIT');
    let text: string;
    try { text = decoder.decode(chunk, {stream: true}); } catch { throw agentChatError('AGENT_CHAT_PROTOCOL_ERROR'); }
    yield* consume(text);
  }
  let last = '';
  try { last = decoder.decode(); } catch { throw agentChatError('AGENT_CHAT_PROTOCOL_ERROR'); }
  yield* consume(last);
  if (hasData || (line && !line.startsWith(':'))) throw agentChatError('AGENT_CHAT_TRUNCATED');
}

import {agentChatError} from './chat-errors.mjs';

export const AGENT_SSE_LIMITS = Object.freeze({maxBytes: 1024 * 1024, maxEventBytes: 64 * 1024, maxEvents: 8192});

/** Bounded UTF-8 SSE framing. No reconnect, event-id execution or URL handling.
 * A final unterminated data frame is truncated, never implicitly dispatched. */
export async function* parseAgentSse(source, options = {}) {
  const limits = {...AGENT_SSE_LIMITS, ...options};
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let line = '', lineBytes = 0, skipLF = false, bytes = 0, eventBytes = 0, events = 0;
  let event = '', data = [], hasData = false;
  function acceptLine(value) {
    eventBytes += Buffer.byteLength(value, 'utf8') + 1;
    if (eventBytes > limits.maxEventBytes) throw agentChatError('AGENT_CHAT_LIMIT');
    if (!value) {
      const result = hasData ? {event: event || 'message', data: data.join('\n')} : null;
      event = ''; data = []; hasData = false; eventBytes = 0;
      if (result && ++events > limits.maxEvents) throw agentChatError('AGENT_CHAT_LIMIT');
      return result;
    }
    if (value.startsWith(':')) return null;
    const colon = value.indexOf(':');
    const name = colon === -1 ? value : value.slice(0, colon);
    let field = colon === -1 ? '' : value.slice(colon + 1);
    if (field.startsWith(' ')) field = field.slice(1);
    if (name === 'data') { hasData = true; data.push(field); }
    else if (name === 'event') event = field;
    return null;
  }
  function* consume(text) {
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
    let text;
    try { text = decoder.decode(chunk, {stream: true}); } catch { throw agentChatError('AGENT_CHAT_PROTOCOL_ERROR'); }
    yield* consume(text);
  }
  let last;
  try { last = decoder.decode(); } catch { throw agentChatError('AGENT_CHAT_PROTOCOL_ERROR'); }
  yield* consume(last);
  if (hasData || (line && !line.startsWith(':'))) throw agentChatError('AGENT_CHAT_TRUNCATED');
}

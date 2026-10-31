export interface AgentChatFrame { id: string; type: string; data: unknown }

const bytes = (value: string): number => new TextEncoder().encode(value).length;
const MAX_FRAME = 1024 * 1024;
const failure = (code: 'INVALID_RESPONSE'): Error => Object.assign(new Error('Agent chat request did not complete.'), { code });

// EventSource cannot surface HTTP failures reliably. This parser uses a bounded,
// authenticated fetch stream and treats every reconnect as a read, never a POST.
export async function readAgentChatSSE(body: ReadableStream<Uint8Array> | null | undefined, onFrame: (frame: AgentChatFrame) => void, signal?: AbortSignal): Promise<void> {
  if (!body || typeof body.getReader !== 'function') throw failure('INVALID_RESPONSE');
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', frame = { id: '', type: '', data: [] as string[] }, frameBytes = 0;
  const line = (value: string): void => {
    frameBytes += bytes(value);
    if (frameBytes > MAX_FRAME) throw failure('INVALID_RESPONSE');
    if (value === '') {
      if (frame.data.length) { const data = JSON.parse(frame.data.join('\n')); onFrame({ id: frame.id, type: frame.type || 'message', data }); }
      frame = { id: '', type: '', data: [] }; frameBytes = 0; return;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':'), name = colon < 0 ? value : value.slice(0, colon), content = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '');
    if (name === 'id') frame.id = content; else if (name === 'event') frame.type = content; else if (name === 'data') frame.data.push(content);
  };
  try {
    while (!signal?.aborted) {
      const part = await reader.read();
      if (part.done) { buffer += decoder.decode(); if (buffer || frame.data.length) throw failure('INVALID_RESPONSE'); return; }
      buffer += decoder.decode(part.value, { stream: true });
      if (bytes(buffer) > MAX_FRAME) throw failure('INVALID_RESPONSE');
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        // A CR at a chunk boundary might be half of CRLF.
        if (match[0] === '\r' && match.index === buffer.length - 1) break;
        line(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length);
        if (signal?.aborted) return;
      }
    }
  } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}

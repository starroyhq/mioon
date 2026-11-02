import type {IncomingMessage, ServerResponse} from 'node:http';

export function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(data));
}
export async function body(req: IncomingMessage, max = 42 * 1024 * 1024): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(Error('Request too large'), {status: 413});
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw Object.assign(Error('Invalid JSON'), {status: 400}); }
}
export const field = (value: unknown, name: string): unknown => value !== null && typeof value === 'object' && name in value ? (value as Record<string, unknown>)[name] : undefined;

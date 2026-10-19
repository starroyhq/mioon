/** Local-only browser failure fixture; not part of production startup.
 * Uses the real authenticated HTTP/SQLite/worker stack behind a strict loopback
 * proxy. fault.json can consume ONE exact operation response after backend
 * acceptance (drop or hold until fault-release exists). No domain responses
 * are fabricated. UI interactions still use the supported CUA browser APIs.
 */
import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile, access, unlink } from 'node:fs/promises';
import { startServer } from '../apps/server/src/index.ts';
const runtime = path.resolve(process.env.MIOON_QA_RUNTIME || 'evidence/timeline-snapping/runtime');
if (!runtime.endsWith('/evidence/timeline-snapping/runtime')) throw Error('Disposable timeline-snapping runtime required');
process.env.MIOON_ENABLE_LIVE_PROVIDER = '0';
for (const key of Object.keys(process.env)) if (/^(RUNWAY|RUNWAYML|ARK_|VEO_|GEMINI_|MINIMAX_|HAILUO_|VIDU_)/.test(key)) delete process.env[key];
await import('./timeline-snapping-qa-seed.mjs');
const backend = await startServer({ dataDir: path.join(runtime, 'workspace'), port: 0, token: 'timeline-snapping-local-synthetic-token', distDir: path.resolve('apps/web/dist') });
const port = Number(process.env.MIOON_QA_PORT || 4878), host = `127.0.0.1:${port}`, origin = `http://${host}`;
const faultPath = path.join(runtime, 'fault.json'), releasePath = path.join(runtime, 'fault-release');
let seq = 0;
const server = http.createServer(async (req, res) => {
  if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin)) return res.writeHead(403).end('QA origin rejected');
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  let operation = null, input = null;
  try { ({operation,input} = JSON.parse(body)); } catch {}
  let fault;
  try { const candidate = JSON.parse(await readFile(faultPath, 'utf8')); if (candidate.operation === operation) { fault = candidate; await unlink(faultPath); } } catch {}
  const headers = { ...req.headers, host: new URL(backend.url).host };
  if (headers.origin) headers.origin = backend.url;
  const upstream = http.request(backend.url + req.url, { method: req.method, headers }, async response => {
    if (fault) {
      const parts = []; for await (const chunk of response) parts.push(chunk);
      const bytes = Buffer.concat(parts), id = ++seq;
      await writeFile(path.join(runtime, `fault-observed-${id}.json`), JSON.stringify({ operation, input, fault: fault.kind, status: response.statusCode, body: JSON.parse(bytes), acceptedAt: new Date().toISOString() }, null, 2));
      if (fault.kind === 'drop') { res.writeHead(200, { 'content-type': 'application/json', 'content-length': 1 }); res.end(bytes.subarray(0, 1)); return; }
      if (fault.kind === 'hold') {
        // Test orchestration releases this real accepted response explicitly.
        for (;;) { try { await access(releasePath); await unlink(releasePath); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); } }
      }
      res.writeHead(response.statusCode, response.headers); res.end(bytes); return;
    }
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  upstream.end(body);
});
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
await writeFile(path.join(runtime, 'server.json'), JSON.stringify({ url: origin, backend: backend.url, dataDir: backend.dataDir }, null, 2));
console.log(`Synthetic timeline-snapping browser fixture listening at ${origin}`);
let closing;
async function close() { if (closing) return; closing = true; await writeFile(releasePath, 'release'); await new Promise(resolve => server.close(resolve)); await backend.close(); }
process.on('SIGINT', close); process.on('SIGTERM', close);

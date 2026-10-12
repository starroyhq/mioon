import http from 'node:http';
import {readFile, writeFile, stat} from 'node:fs/promises';
import {createReadStream, existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {openStore, createServices, startWorker, safePath, createProviderRegistry} from '@video-workbench/business';

const directory = path.dirname(fileURLToPath(import.meta.url));
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const json = (res, status, data) => {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(data));
};
async function body(req, max = 42 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(Error('Request too large'), {status: 413});
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw Object.assign(Error('Invalid JSON'), {status: 400}); }
}

/** Transport lifecycle shared by the CLI and the Electron utility process.
 * No signal handlers, process exits, UI imports or host-runtime spawning here.
 */
export async function startServer({
  dataDir = path.resolve(directory, '../../../data'),
  port = 4318,
  distDir = path.resolve(directory, '../../web/dist'),
  token: suppliedToken,
} = {}) {
  if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) throw Error('Invalid PORT');
  const root = path.resolve(dataDir), dist = path.resolve(distDir);
  if (suppliedToken !== undefined && (typeof suppliedToken !== 'string' || suppliedToken.length < 20)) throw Error('WB_TOKEN must contain at least 20 characters');
  const store = openStore(root);
  let token = suppliedToken;
  const tokenFile = path.join(root, 'access-token');
  let worker, server;
  try {
    if (!token) {
      if (existsSync(tokenFile)) token = (await readFile(tokenFile, 'utf8')).trim();
      else {
        token = randomBytes(32).toString('hex');
        await writeFile(tokenFile, token, {mode: 0o600, flag: 'wx'});
      }
    }
    if (token.length < 20) throw Error('WB_TOKEN must contain at least 20 characters');
    const providers = createProviderRegistry({db: store.db, root});
    const services = createServices(store, providers);
    const origins = new Set(), hosts = new Set();
    const auth = req => {
      const bearer = req.headers.authorization?.replace(/^Bearer /, '');
      const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('wb_session='))?.slice(11);
      return equal(bearer, token) || equal(cookie, token);
    };
    server = http.createServer(async (req, res) => {
      try {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'");
        if (!hosts.has(req.headers.host) || (req.headers.origin && !origins.has(req.headers.origin))) return json(res, 403, {ok: false, error: {code: 'ORIGIN_REJECTED', message: '本地来源校验失败'}});
        const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
        if (url.pathname === '/health') return json(res, 200, {ok: true, service: 'video-workbench', version: '0.4.0', sqlite: store.db.prepare('select sqlite_version() v').get().v});
        if (url.pathname === '/api/login' && req.method === 'POST') {
          const input = await body(req, 4096);
          if (!equal(input.token, token)) return json(res, 401, {ok: false, error: {code: 'UNAUTHORIZED', message: '访问令牌无效'}});
          res.setHeader('Set-Cookie', `wb_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
          return json(res, 200, {ok: true});
        }
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) {
          if (!auth(req)) return json(res, 401, {ok: false, error: {code: 'UNAUTHORIZED', message: '请使用本地访问令牌登录'}});
        }
        if (url.pathname === '/api/rpc' && req.method === 'POST') {
          const input = await body(req);
          if (typeof input.operation !== 'string') return json(res, 400, {ok: false, error: {code: 'VALIDATION_ERROR', message: '缺少 operation'}});
          return json(res, 200, {ok: true, data: await services.call(input.operation, input.input || {})});
        }
        if (url.pathname.startsWith('/media/') && ['GET', 'HEAD'].includes(req.method)) {
          const asset = store.get('assets', url.pathname.slice(7));
          if (!asset) return json(res, 404, {ok: false, error: {code: 'NOT_FOUND', message: '素材不存在'}});
          const file = await safePath(root, asset.relativePath), metadata = await stat(file);
          const headers = {'Content-Type': asset.mimeType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600'};
          if (url.searchParams.has('download')) headers['Content-Disposition'] = `attachment; filename="video-workbench.${asset.mimeType === 'video/mp4' ? 'mp4' : 'bin'}"`;
          const range = req.headers.range;
          if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (!match || (!match[1] && !match[2])) return res.writeHead(416).end();
            const start = match[1] ? Number(match[1]) : Math.max(0, metadata.size - Number(match[2]));
            const end = Math.min(match[1] ? (match[2] ? Number(match[2]) : metadata.size - 1) : metadata.size - 1, metadata.size - 1);
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= metadata.size) return res.writeHead(416).end();
            res.writeHead(206, {...headers, 'Content-Range': `bytes ${start}-${end}/${metadata.size}`, 'Content-Length': end - start + 1});
            return req.method === 'HEAD' ? res.end() : createReadStream(file, {start, end}).pipe(res);
          }
          res.writeHead(200, {...headers, 'Content-Length': metadata.size});
          return req.method === 'HEAD' ? res.end() : createReadStream(file).pipe(res);
        }
        if (url.pathname.startsWith('/api/') || req.method !== 'GET') return json(res, 404, {ok: false, error: {code: 'NOT_FOUND', message: '接口不存在'}});
        const requested = decodeURIComponent(url.pathname);
        if (requested.includes('..') || requested.includes('\\')) return res.writeHead(400).end();
        let file = path.join(dist, requested === '/' ? 'index.html' : requested);
        if (!file.startsWith(dist + path.sep) && file !== dist) return res.writeHead(403).end();
        if (!existsSync(file) || !(await stat(file)).isFile()) file = path.join(dist, 'index.html');
        if (!existsSync(file)) return json(res, 503, {ok: false, error: {code: 'BUILD_REQUIRED', message: '请先运行 pnpm build'}});
        const mime = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png'}[path.extname(file)] || 'application/octet-stream';
        res.writeHead(200, {'Content-Type': mime, 'Cache-Control': 'no-cache'});
        createReadStream(file).pipe(res);
      } catch (error) {
        if (res.headersSent) return res.destroy();
        json(res, error.status || 500, {ok: false, error: {code: error.code || 'INTERNAL_ERROR', message: error.status ? error.message : '操作失败，请检查输入或后端状态', details: error.details || {}, retryable: false}});
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    const actualPort = server.address().port;
    for (const hostname of ['127.0.0.1', 'localhost']) {
      hosts.add(`${hostname}:${actualPort}`);
      origins.add(`http://${hostname}:${actualPort}`);
    }
    worker = startWorker(store, services, providers);
    let closing;
    const close = () => closing ??= (async () => {
      // Stop accepting and drain active HTTP requests before closing their store.
      const drain = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await worker.stop({interruptMedia:true});
      await drain;
      store.close();
    })();
    return {url: `http://127.0.0.1:${actualPort}`, port: actualPort, token, tokenFile, dataDir: root, close};
  } catch (error) {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (worker) await worker.stop();
    store.close();
    throw error;
  }
}

/** Real-RPC headless acceptance for a lost format-5 commit response. Starts a
 * real format-5 kernel and the real project service over HTTP, mounts the
 * production session/notice/unconfirmed bar plus the production
 * `createRequestOutcomeClient`, then drives the page with Playwright. The only
 * failure injection lives in the fixture acceptance script
 * (`tests/fixtures/format5-lost-response/acceptance.py`, browser network layer):
 * `lost-after-write` forwards the real commit via `route.fetch()` and then
 * aborts the browser response, `lost-before-write` aborts without forwarding.
 * The receipt route always uses the production request-outcome handler. */
import {createServer} from 'node:http';
import {mkdtemp, readdir, rm, stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createRequire} from 'node:module';
import {join, relative, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createEditUiWireFixture} from './helpers/edit-ui-wire-fixture.ts';
import {testEnv} from './helpers/test-env.ts';
import {createRequestOutcomeHttp} from '../apps/server/src/request-outcome-http.ts';
import {readRequestOutcome} from '../packages/business/src/request-outcome.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const value = name => {const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1];};
const screens = value('--screens');
const outcomeDelayMs = Number(value('--outcome-delay-ms') ?? 800);
const scratch = await mkdtemp(join(root, '.wire-browser-'));
const {store, services, library, projectId} = await createEditUiWireFixture();
const outcomeHttp = createRequestOutcomeHttp({db: store.db});
const control = {commits: [], lastRequestId: null};
const json = (response, status, body) => {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'});
  response.end(JSON.stringify(body));
};
const readBody = async request => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  return raw;
};
const contentTypes = {'.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2'};
const require = createRequire(join(root, 'apps/web/package.json'));
const {build} = await import(pathToFileURL(require.resolve('vite')).href);
const tailwind = (await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href)).default;
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
const outDir = join(scratch, 'bundle');
await build({configFile: false, root: join(root, 'apps/web'), logLevel: 'warn', plugins: [tailwind()],
  resolve: {alias: {react: join(root, 'apps/web/node_modules/react'), 'react-dom': join(root, 'apps/web/node_modules/react-dom')}},
  build: {outDir, emptyOutDir: true, minify: false, cssCodeSplit: true, copyPublicDir: false,
    rollupOptions: {input: join(root, 'tests/fixtures/format5-lost-response/entry.tsx'),
      output: {entryFileNames: 'wire.js', chunkFileNames: 'wire-[name].js', assetFileNames: '[name][extname]'}}}});
const files = new Map();
let stylesheet;
for (const path of await walk(outDir)) {
  const url = `/${relative(outDir, path).split(sep).join('/')}`;
  if (!(await stat(path)).isFile()) continue;
  const extension = path.slice(path.lastIndexOf('.'));
  files.set(url, {path, type: contentTypes[extension] ?? 'application/octet-stream'});
  if (extension === '.css' && !stylesheet) stylesheet = url;
}
const html = `<!doctype html><html lang="zh-Hans"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>format-5 lost response</title>${stylesheet ? `<link rel="stylesheet" href="${stylesheet}">` : ''}<div id="root"></div><script type="module" src="/wire.js"></script></html>`;
files.set('/index.html', {path: null, body: Buffer.from(html), type: 'text/html'});
let server;
try {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    if (url.pathname === '/rpc' && request.method === 'POST') {
      let operation, input;
      try {({operation, input} = JSON.parse(await readBody(request)));}
      catch {json(response, 400, {ok: false, error: {code: 'BAD_REQUEST', message: 'bad body'}}); return;}
      if (operation === 'sequence.commit') {
        const requestId = input?.envelope?.requestId ?? null;
        control.commits.push({requestId});
        control.lastRequestId = requestId;
      }
      try {
        const data = await services.call(operation, input ?? {});
        const body = operation === 'project.get' && data && typeof data === 'object'
          ? {...data, projectFormatVersion: 5} : data;
        json(response, 200, {ok: true, data: body});
      } catch (error) {
        json(response, 200, {ok: false, error: {code: error?.code ?? 'RPC_FAILED', message: String(error?.message ?? error)}});
      }
      return;
    }
    const outcomeMatch = /^\/api\/projects\/([0-9a-f-]{36})\/request-outcome$/u.exec(url.pathname);
    if (outcomeMatch && request.method === 'GET') {
      await new Promise(resolve => setTimeout(resolve, outcomeDelayMs));
      request.url = `/api/request-outcome?requestId=${encodeURIComponent(url.searchParams.get('requestId') ?? '')}`;
      await outcomeHttp(request, response, new URL(request.url, 'http://fixture.invalid'), {projectId: outcomeMatch[1]});
      return;
    }
    if (url.pathname === '/debug/state') {
      const receipts = store.db.prepare('SELECT requestId,operation,response FROM main.editor_requests').all().map(row => {
        let receipt = null;
        try {receipt = JSON.parse(String(row.response));} catch {receipt = null;}
        return {requestId: String(row.requestId), operation: String(row.operation),
          status: receipt?.status ?? null, code: receipt?.code ?? null};
      });
      const requested = url.searchParams.get('requestId') ?? control.lastRequestId;
      let outcome = null;
      try {outcome = requested ? readRequestOutcome(store.db, projectId, requested) : null;} catch (error) {outcome = {error: String(error?.code ?? error)};}
      const history = await services.call('sequence.history.get', {projectId});
      const project = await services.call('project.get', {projectId});
      json(response, 200, {commits: control.commits, receipts, outcome,
        historyPosition: history.position, historyRevision: history.revision,
        trackCount: Array.isArray(project?.timeline?.tracks) ? project.timeline.tracks.length : null});
      return;
    }
    const file = files.get(url.pathname === '/' ? '/index.html' : url.pathname);
    if (!file) {response.writeHead(404); response.end(); return;}
    response.writeHead(200, {'content-type': file.type, 'cache-control': 'no-store'});
    if (file.path) createReadStream(file.path).pipe(response);
    else response.end(file.body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(value('--python') ?? 'python3', [join(root, 'tests/fixtures/format5-lost-response/acceptance.py'),
    '--url', `${base}/index.html`, '--base', base, ...(screens ? ['--screens', screens] : [])],
    {cwd: root, env: {...testEnv(), PYTHONPATH: ''}, stdio: 'inherit'});
  const code = await new Promise(resolve => child.on('close', resolve));
  process.exitCode = code ?? 1;
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await services.drain();
  store.close();
  library.close();
  await rm(scratch, {recursive: true, force: true});
}

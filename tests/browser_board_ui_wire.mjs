/** Real-RPC headless UI-B2 acceptance. Boots a real format-5 kernel and the
 * real project service over HTTP, bundles the production board components, then
 * drives them with Playwright. No board command is mocked. */
import {createServer} from 'node:http';
import {mkdtemp, readFile, readdir, rm, stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {join, relative, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFileSync, spawn} from 'node:child_process';
import {copyFileSync} from 'node:fs';
import {createBoardUiWireFixture} from './helpers/board-ui-wire-fixture.ts';
import {createProviderRegistry, registerInputProfileWrapper} from '../packages/business/src/provider-registry.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {testEnv} from './helpers/test-env.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const value = name => {const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1];};
const screens = value('--screens');
const stress = args.includes('--stress');
const scratch = await mkdtemp(join(root, '.board-wire-browser-'));
const fixture = stress ? await import('./helpers/board-ui-wire-fixture.ts').then(module => module.createBoardUiWireStressFixture())
  : await createBoardUiWireFixture();
const {store, services, library, projectId} = fixture;
const settings = fixture.settings;
// The default FFmpeg on some walkthrough machines lacks drawtext, which the Mock
// renderer needs. Keep the real worker/publication path but download a small
// pre-rendered synthetic clip instead.
const syntheticVideo = join(fixture.root, 'synthetic-generation.mp4');
const fixtureEnv = testEnv();
execFileSync(fixtureEnv.MIOON_FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
  'color=c=black:s=360x640:d=4:r=30', '-pix_fmt', 'yuv420p', '-y', syntheticVideo], {env: fixtureEnv});
const baseMock = createProviderRegistry({db: store.db, root: fixture.root, env: {}}).get('mock');
const mockProvider = registerInputProfileWrapper({
  id: 'mock', capabilities: baseMock.capabilities, validate: baseMock.validate?.bind(baseMock),
  async submit() { return {providerJobId: `synthetic-${Date.now()}`}; },
  async reconcile() { return null; },
  async poll() { return {status: 'succeeded', progress: 100}; },
  async download(_id, destination) { copyFileSync(syntheticVideo, destination); return {}; },
  async cancel() { return {}; },
}, baseMock);
fixture.providers.set('mock', mockProvider);
let mockWorker = null;
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
    rollupOptions: {input: join(root, 'tests/fixtures/board-ui-wire/entry.tsx'),
      output: {entryFileNames: 'board.js', chunkFileNames: 'board-[name].js', assetFileNames: '[name][extname]'}}}});
const files = new Map();
let stylesheet;
for (const path of await walk(outDir)) {
  const url = `/${relative(outDir, path).split(sep).join('/')}`;
  if (!(await stat(path)).isFile()) continue;
  const extension = path.slice(path.lastIndexOf('.'));
  files.set(url, {path, type: contentTypes[extension] ?? 'application/octet-stream'});
  if (extension === '.css' && !stylesheet) stylesheet = url;
}
const html = `<!doctype html><html lang="zh-Hans"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>UI-B2 board wire</title>${stylesheet ? `<link rel="stylesheet" href="${stylesheet}">` : ''}<div id="root"></div><script type="module" src="/board.js"></script></html>`;
files.set('/index.html', {path: null, body: Buffer.from(html), type: 'text/html'});
let server;
try {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    if (url.pathname === '/test/mock-shot-references' && request.method === 'POST') {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const {shotId} = JSON.parse(raw);
      const row = store.get('shots', shotId);
      if (row) store.put('shots', {...row, referenceAssetIds: [], referenceBindings: []});
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({ok: Boolean(row)}));
      return;
    }
    if (url.pathname === '/test/start-mock-worker' && request.method === 'POST') {
      mockWorker ??= startWorker(store, services, fixture.providers);
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({ok: true}));
      return;
    }
    if (url.pathname === '/rpc' && request.method === 'POST') {
      let raw = '', operation = '';
      for await (const chunk of request) raw += chunk;
      try {
        const parsed = JSON.parse(raw); operation = parsed.operation; const input = parsed.input;
        const data = await services.call(operation, input ?? {});
        const body = operation === 'project.get' && data && typeof data === 'object'
          ? {...data, projectFormatVersion: 5} : data;
        response.writeHead(200, {'content-type': 'application/json'});
        response.end(JSON.stringify({ok: true, data: body}));
      } catch (error) {
        console.error('RPC_FAILED', operation, error?.code, error?.message);
        response.writeHead(200, {'content-type': 'application/json'});
        response.end(JSON.stringify({ok: false, error: {code: error?.code ?? 'RPC_FAILED', message: String(error?.message ?? error)}}));
      }
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
  const pageUrl = `http://127.0.0.1:${port}/index.html`;
  const child = spawn(value('--python') ?? 'python3', [join(root, 'tests/fixtures/board-ui-wire/acceptance.py'),
    '--url', pageUrl, ...(screens ? ['--screens', screens] : []), ...(stress ? ['--stress'] : [])],
  {cwd: root, env: {...testEnv(), PYTHONPATH: ''}, stdio: 'inherit'});
  const code = await new Promise(resolve => child.on('close', resolve));
  process.exitCode = code ?? 1;
} finally {
  if (mockWorker) await mockWorker.stop();
  if (server) await new Promise(resolve => server.close(resolve));
  await services.drain();
  if (settings) await settings.close();
  store.close();
  library.close();
  await rm(scratch, {recursive: true, force: true});
}

/** Real-RPC headless previs-editor acceptance. Boots a real format-5 kernel and
 * the real project service over HTTP, bundles the production Previs components
 * (with the production format-5 RPC adapter), then drives them with Playwright.
 * No previs write path is mocked. */
import {createServer} from 'node:http';
import {mkdtemp, readdir, rm, stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {join, relative, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createPrevisUiWireFixture} from './helpers/previs-ui-wire-fixture.ts';
import {testEnv} from './helpers/test-env.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const value = name => {const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1];};
const screens = value('--screens');
const scratch = await mkdtemp(join(root, '.previs-wire-browser-'));
const fixture = await createPrevisUiWireFixture();
const {store, services, library} = fixture;
const contentTypes = {'.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.jpg': 'image/jpeg'};
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
    rollupOptions: {input: join(root, 'tests/fixtures/previs-ui-wire/entry.tsx'),
      output: {entryFileNames: 'previs.js', chunkFileNames: 'previs-[name].js', assetFileNames: '[name][extname]'}}}});
const files = new Map();
const stylesheets = [];
for (const path of await walk(outDir)) {
  const url = `/${relative(outDir, path).split(sep).join('/')}`;
  if (!(await stat(path)).isFile()) continue;
  const extension = path.slice(path.lastIndexOf('.'));
  files.set(url, {path, type: contentTypes[extension] ?? 'application/octet-stream'});
  if (extension === '.css') stylesheets.push(url);
}
const html = `<!doctype html><html lang="zh-Hans"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>格式 5 预演接线</title>${stylesheets.map(url => `<link rel="stylesheet" href="${url}">`).join('')}<div id="root"></div><script type="module" src="/previs.js"></script></html>`;
files.set('/index.html', {path: null, body: Buffer.from(html), type: 'text/html'});
let server;
try {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
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
        response.end(JSON.stringify({ok: false, error: {code: error?.code ?? 'RPC_FAILED',
          message: String(error?.message ?? error), details: error?.details ?? null}}));
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
  const child = spawn(value('--python') ?? 'python3', [join(root, 'tests/fixtures/previs-ui-wire/acceptance.py'),
    '--url', pageUrl, ...(screens ? ['--screens', screens] : [])],
  {cwd: root, env: {...testEnv(), PYTHONPATH: ''}, stdio: 'inherit'});
  const code = await new Promise(resolve => child.on('close', resolve));
  process.exitCode = code ?? 1;
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await services.drain();
  store.close();
  library.close();
  await rm(scratch, {recursive: true, force: true});
  await rm(fixture.root, {recursive: true, force: true});
}

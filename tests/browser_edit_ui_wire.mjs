/** Real-RPC headless UI-E2 acceptance. Starts a real format-5 kernel and the
 * real project service over HTTP, bundles the production editing components
 * with Vite, then drives the page with Playwright. No RPC is mocked. */
import {createServer} from 'node:http';
import {mkdtemp, readFile, readdir, rm, stat} from 'node:fs/promises';
import {createReadStream, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {join, relative, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createEditUiWireFixture} from './helpers/edit-ui-wire-fixture.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const value = name => {const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1];};
const screens = value('--screens');
const scratch = await mkdtemp(join(root, '.wire-browser-'));
const {store, services, library, projectId} = await createEditUiWireFixture();
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
    rollupOptions: {input: join(root, 'tests/fixtures/edit-ui-wire/entry.tsx'),
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
const html = `<!doctype html><html lang="zh-Hans"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>UI-E2 wire</title>${stylesheet ? `<link rel="stylesheet" href="${stylesheet}">` : ''}<div id="root"></div><script type="module" src="/wire.js"></script></html>`;
files.set('/index.html', {path: null, body: Buffer.from(html), type: 'text/html'});
let server;
try {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    if (url.pathname === '/rpc' && request.method === 'POST') {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      try {
        const {operation, input} = JSON.parse(raw);
        const data = await services.call(operation, input ?? {});
        const body = operation === 'project.get' && data && typeof data === 'object'
          ? {...data, projectFormatVersion: 5} : data;
        response.writeHead(200, {'content-type': 'application/json'});
        response.end(JSON.stringify({ok: true, data: body}));
      } catch (error) {
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
  const url = `http://127.0.0.1:${port}/index.html`;
  const child = spawn(value('--python') ?? 'python3', [join(root, 'tests/fixtures/edit-ui-wire/acceptance.py'), '--url', url,
    ...(screens ? ['--screens', screens] : [])], {cwd: root, env: {...process.env, PYTHONPATH: ''}, stdio: 'inherit'});
  const code = await new Promise(resolve => child.on('close', resolve));
  process.exitCode = code ?? 1;
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await services.drain();
  store.close();
  library.close();
  await rm(scratch, {recursive: true, force: true});
}

/** Real-RPC headless acceptance for the format-5 scene-split success path.
 * Starts a real format-5 kernel and the real project service over HTTP,
 * synthesizes and imports three verified video assets with real hard cuts
 * through the production import/detection entries (see
 * `tests/helpers/scene-split-wire-fixture.ts`), bundles the production editing
 * components with Vite, then drives the page with Playwright. No detection
 * result, RPC or envelope is mocked. */
import {createServer} from 'node:http';
import {mkdtemp, readdir, rm, stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createRequire} from 'node:module';
import {join, relative, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createSceneSplitWireFixture} from './helpers/scene-split-wire-fixture.ts';
import {testEnv} from './helpers/test-env.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const value = name => {const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1];};
const screens = value('--screens');
const scratch = await mkdtemp(join(root, '.wire-browser-'));
const contentTypes = {'.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.mp4': 'video/mp4'};
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
const json = (response, status, body) => {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'});
  response.end(JSON.stringify(body));
};
const outDir = join(scratch, 'bundle');
try {
await build({configFile: false, root: join(root, 'apps/web'), logLevel: 'warn', plugins: [tailwind()],
  resolve: {alias: {react: join(root, 'apps/web/node_modules/react'), 'react-dom': join(root, 'apps/web/node_modules/react-dom')}},
  build: {outDir, emptyOutDir: true, minify: false, cssCodeSplit: true, copyPublicDir: false,
    rollupOptions: {input: join(root, 'tests/fixtures/format5-scene-split/entry.tsx'),
      output: {entryFileNames: 'wire.js', chunkFileNames: 'wire-[name].js', assetFileNames: '[name][extname]'}}}});
} catch (error) {
  await rm(scratch, {recursive: true, force: true});
  throw error;
}
const files = new Map();
let stylesheet;
for (const path of await walk(outDir)) {
  const url = `/${relative(outDir, path).split(sep).join('/')}`;
  if (!(await stat(path)).isFile()) continue;
  const extension = path.slice(path.lastIndexOf('.'));
  files.set(url, {path, type: contentTypes[extension] ?? 'application/octet-stream'});
  if (extension === '.css' && !stylesheet) stylesheet = url;
}
const html = `<!doctype html><html lang="zh-Hans"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>format-5 scene split</title>${stylesheet ? `<link rel="stylesheet" href="${stylesheet}">` : ''}<div id="root"></div><script type="module" src="/wire.js"></script></html>`;
files.set('/index.html', {path: null, body: Buffer.from(html), type: 'text/html'});
/** The real service state the acceptance compares before and after a refused
 * write: revisions, the unified history cursor and the stored clips. */
const debugState = async () => {
  const project = await services.call('project.get', {projectId});
  const history = await services.call('sequence.history.get', {projectId});
  const assets = Array.isArray(project?.assets) ? project.assets : [];
  const scene = {};
  for (const asset of assets) {
    const view = await services.call('scene.result.get', {projectId, assetId: asset.id});
    scene[asset.id] = {latestResultId: view?.result?.id ?? null, cuts: (view?.result?.cuts ?? []).map(cut => cut.frame),
      frameCount: view?.result?.frameCount ?? null, current: view?.current ?? null, staleReason: view?.staleReason ?? null};
  }
  const sync = store.db.prepare('SELECT revision FROM project.sequence_sync_state').get();
  return {projectId, projectRevision: project?.project?.revision ?? null,
    timelineRevision: project?.timeline?.revision ?? null, syncRevision: Number(sync?.revision ?? 0),
    history: {position: history?.position ?? null, revision: history?.revision ?? null,
      undo: history?.undo ?? null, redo: history?.redo ?? null},
    clips: project?.timeline?.clips ?? [], tracks: project?.timeline?.tracks ?? [],
    assets: assets.map(asset => ({id: asset.id, name: asset.name, mimeType: asset.mimeType, sha256: asset.sha256,
      duration: asset.duration, sizeBytes: asset.sizeBytes, width: asset.width, height: asset.height})),
    scene};
};
const fixture = await createSceneSplitWireFixture();
const {store, services, library, projectId, mediaFiles} = fixture;
const mediaMatch = /^\/api\/projects\/([0-9a-f-]{36})\/media\/([0-9a-f-]{36})$/u;
const serveMedia = async (request, response, assetId, file) => {
  const info = await stat(file);
  const range = request.headers.range;
  const headers = {'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'no-store'};
  if (typeof range === 'string') {
    const match = /^bytes=(\d*)-(\d*)$/u.exec(range.trim());
    const start = match && match[1] ? Number(match[1]) : 0;
    const end = match && match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if (!match || start > end) {response.writeHead(416, {'content-range': `bytes */${info.size}`}); response.end(); return;}
    response.writeHead(206, {...headers, 'content-range': `bytes ${start}-${end}/${info.size}`, 'content-length': end - start + 1});
    createReadStream(file, {start, end}).pipe(response);
    return;
  }
  response.writeHead(200, {...headers, 'content-length': info.size});
  createReadStream(file).pipe(response);
};
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
        json(response, 200, {ok: true, data: body});
      } catch (error) {
        json(response, 200, {ok: false, error: {code: error?.code ?? 'RPC_FAILED', message: String(error?.message ?? error)}});
      }
      return;
    }
    if (url.pathname === '/debug/state') {
      try {json(response, 200, await debugState());}
      catch (error) {json(response, 500, {error: String(error?.message ?? error)});}
      return;
    }
    const media = mediaMatch.exec(url.pathname);
    if (media && media[1] === projectId && mediaFiles[media[2]]) {
      try {await serveMedia(request, response, media[2], mediaFiles[media[2]]);}
      catch {if (!response.writableEnded) {response.writeHead(404); response.end();}}
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
  const child = spawn(value('--python') ?? 'python3', [join(root, 'tests/fixtures/format5-scene-split/acceptance.py'),
    '--url', `${base}/index.html`, '--base', base, ...(screens ? ['--screens', screens] : [])],
    {cwd: root, env: {...testEnv(), PYTHONPATH: ''}, stdio: 'inherit'});
  const code = await new Promise(resolve => child.on('close', resolve));
  process.exitCode = code ?? 1;
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  try {await services.drain();}
  finally {
    store.close();
    library.close();
    await rm(scratch, {recursive: true, force: true});
    fixture.cleanup();
  }
}

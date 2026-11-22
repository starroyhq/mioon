/** Real-RPC headless acceptance for «video clip sound: mute / separate / save
 * as audio asset» (format 5). Starts a real format-5 kernel, the real project
 * service and the real background worker over HTTP, mounts the production
 * Timeline, TimelineInspector, clip context menu, notice bar and save-audio
 * card, then drives the page with Playwright. Only the surrounding shell in
 * tests/fixtures/format5-clip-sound/entry.tsx is a fixture; media import,
 * preview/commit, the export task and its publication are all production code.
 */
import {createServer} from 'node:http';
import {createReadStream, readFileSync} from 'node:fs';
import {mkdir, mkdtemp, readdir, rm, stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join, relative, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createClipSoundWireFixture, projectId} from './helpers/clip-sound-wire-fixture.ts';
import {testEnv} from './helpers/test-env.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const value = name => {const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1];};
const screens = value('--screens');
const scratch = await mkdtemp(join(root, '.clip-sound-wire-'));
const fixture = await createClipSoundWireFixture();
const {store, services, mediaFiles} = fixture;
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
await build({configFile: false, root: join(root, 'apps/web'), logLevel: 'error', plugins: [tailwind()],
  resolve: {alias: {react: join(root, 'apps/web/node_modules/react'), 'react-dom': join(root, 'apps/web/node_modules/react-dom')}},
  build: {outDir, emptyOutDir: true, minify: false, cssCodeSplit: true, copyPublicDir: false,
    rollupOptions: {input: join(root, 'tests/fixtures/format5-clip-sound/entry.tsx'),
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
const html = `<!doctype html><html lang="zh-Hans"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>format-5 clip sound</title>${stylesheet ? `<link rel="stylesheet" href="${stylesheet}">` : ''}<div id="root"></div><script type="module" src="/wire.js"></script></html>`;
files.set('/index.html', {path: null, body: Buffer.from(html), type: 'text/html'});
const rpcLog = [];
const readExportRow = exportId => {
  const row = store.db.prepare('SELECT data FROM exports WHERE id=? AND projectId=?').get(exportId, projectId);
  if (!row || typeof row.data !== 'string') return null;
  try {return JSON.parse(row.data);} catch {return null;}
};
const debugState = async () => {
  let project, history;
  try {project = await services.call('project.get', {projectId});}
  catch (error) {throw Object.assign(new Error(`project.get: ${error?.message} ${JSON.stringify(error?.details ?? null)}`), {code: error?.code});}
  try {history = await services.call('sequence.history.get', {projectId});}
  catch (error) {throw Object.assign(new Error(`sequence.history.get: ${error?.message}`), {code: error?.code});}
  const exports = store.db.prepare('SELECT id,data FROM exports WHERE projectId=? ORDER BY id')
    .all(projectId).flatMap(row => {try {return [JSON.parse(String(row.data))];} catch {return [];}});
  return {projectFormatVersion: 5, project, history, exports,
    timeline: project?.timeline ?? null, assets: project?.assets ?? [], shots: project?.shots ?? []};
};
let server;
try {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    if (url.pathname === '/rpc' && request.method === 'POST') {
      let operation, input;
      try {({operation, input} = JSON.parse(await readBody(request)));}
      catch {json(response, 400, {ok: false, error: {code: 'BAD_REQUEST', message: 'bad body'}}); return;}
      rpcLog.push({operation, input: operation.startsWith('sequence.') || operation.startsWith('clip.') || operation === 'project.get' ? input : undefined});
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
    const mediaMatch = /^\/api\/projects\/([0-9a-f-]{36})\/media\/([0-9a-f-]{36})$/u.exec(url.pathname);
    if (mediaMatch && request.method === 'GET') {
      const file = mediaFiles.get(mediaMatch[2]);
      if (!file) {response.writeHead(404); response.end(); return;}
      const info = await stat(file);
      const asset = store.get('assets', mediaMatch[2]);
      response.writeHead(200, {'content-type': String(asset?.mimeType ?? 'application/octet-stream'),
        'content-length': String(info.size), 'cache-control': 'no-store'});
      createReadStream(file).pipe(response);
      return;
    }
    if (url.pathname === '/debug/state') {
      try {
        const state = await debugState();
        json(response, 200, {...state, rpc: rpcLog.slice(-120),
          clipAudio: state.exports.filter(item => item?.mode === 'clip-audio')});
      } catch (error) {
        json(response, 200, {ok: false, error: {code: error?.code ?? 'STATE_FAILED', message: String(error?.message ?? error)}});
      }
      return;
    }
    if (url.pathname === '/debug/break-source' || url.pathname === '/debug/restore-source') {
      const assetId = url.searchParams.get('assetId') ?? '';
      const file = mediaFiles.get(assetId);
      if (!file) {json(response, 404, {ok: false, message: 'not a managed fixture asset'}); return;}
      const saved = `${file}.saved`;
      if (url.pathname === '/debug/break-source') {
        if (!(await stat(saved).catch(() => null))) await import('node:fs/promises').then(fs => fs.rename(file, saved));
        await import('node:fs/promises').then(fs => fs.writeFile(file, Buffer.from('broken source')));
      } else {
        await import('node:fs/promises').then(fs => fs.rm(file, {force: true}));
        await import('node:fs/promises').then(fs => fs.rename(saved, file));
      }
      json(response, 200, {ok: true});
      return;
    }
    if (url.pathname === '/debug/assert-media') {
      const assetId = url.searchParams.get('assetId') ?? '';
      const row = store.get('assets', assetId);
      const reference = row?.reference;
      const file = reference?.path ? join(store.projectDir, String(reference.path)) : null;
      let probe = null;
      if (file) {
        try {
          const {run} = await import('../packages/business/src/media-runtime.ts');
          const raw = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
            {timeout: 30000, maxStdoutBytes: 131072, maxStderrBytes: 65536});
          probe = JSON.parse(raw);
        } catch (error) {probe = {error: String(error?.message ?? error)};}
      }
      json(response, 200, {asset: row ?? null, fileExists: file ? true : false, probe,
        shaMatches: row && file ? readFileSync(file).length === row.sizeBytes : false});
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
  const child = spawn(value('--python') ?? 'python3', [join(root, 'tests/fixtures/format5-clip-sound/acceptance.py'),
    '--url', `${base}/index.html`, '--base', base, ...(screens ? ['--screens', screens] : [])],
    {cwd: root, env: {...testEnv(), PYTHONPATH: ''}, stdio: 'inherit'});
  const code = await new Promise(resolve => child.on('close', resolve));
  process.exitCode = code ?? 1;
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await fixture.close();
  await rm(scratch, {recursive: true, force: true});
}

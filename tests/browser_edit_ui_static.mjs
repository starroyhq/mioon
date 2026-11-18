/** Standalone synthetic UI-E1 acceptance. No application or project host starts.
 * It builds the fixture entries with the app's own Vite + Tailwind pipeline,
 * serves only those built assets and repository media examples from a loopback
 * server, then runs the Python Playwright checks. */
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile, readdir, rm, stat} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {join, relative, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {FIXTURE_IMAGE_MEDIA, FIXTURE_MEDIA, FIXTURE_PROJECT_ID} from './fixtures/edit-ui-static/scenes.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = join(root, 'tests/fixtures/edit-ui-static');
const args = process.argv.slice(2);
const value = name => {const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1];};
const mode = value('--mode') ?? 'design';
const scratch = await mkdtemp(join(tmpdir(), 'mioon-edit-ui-'));
const media = mode === 'baseline' ? FIXTURE_IMAGE_MEDIA : FIXTURE_MEDIA;
const entries = {
  baseline: {file: 'baseline-entry.tsx', title: 'Edit UI baseline'},
  design: {file: 'entry.tsx', title: 'Edit UI fixture'},
};
const contentTypes = {'.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff'};
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

async function bundle(name) {
  const entry = entries[name];
  const source = join(fixture, entry.file);
  if (!existsSync(source)) throw new Error(`Missing fixture entry ${entry.file}`);
  const outDir = join(scratch, name);
  await build({
    configFile: false, root: join(root, 'apps/web'), logLevel: 'warn',
    plugins: [tailwind()],
    resolve: {alias: {react: join(root, 'apps/web/node_modules/react'), 'react-dom': join(root, 'apps/web/node_modules/react-dom')}},
    build: {outDir, emptyOutDir: true, minify: false, cssCodeSplit: true, copyPublicDir: false,
      rollupOptions: {input: source,
        output: {entryFileNames: `${name}.js`, chunkFileNames: `${name}-[name].js`, assetFileNames: '[name][extname]'}}},
  });
  const files = new Map();
  let stylesheet;
  for (const path of await walk(outDir)) {
    const url = `/${relative(outDir, path).split(sep).join('/')}`;
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) continue;
    const extension = path.slice(path.lastIndexOf('.'));
    files.set(url, {body: await readFile(path), type: contentTypes[extension] ?? 'application/octet-stream'});
    if (extension === '.css' && !stylesheet) stylesheet = url;
  }
  const html = `<!doctype html><html lang="zh-Hans"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${entry.title}</title>${stylesheet ? `<link rel="stylesheet" href="${stylesheet}">` : ''}<div id="root"></div><script type="module" src="/${name}.js"></script></html>`;
  files.set(`/${name}.html`, {body: Buffer.from(html), type: 'text/html'});
  return files;
}

let server;
try {
  const files = new Map();
  for (const name of Object.keys(entries).filter(name => name === mode)) {
    for (const [path, file] of await bundle(name)) files.set(path, file);
  }
  const mediaPrefix = `/api/projects/${FIXTURE_PROJECT_ID}/media/`;
  server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://fixture.invalid').pathname);
    if (pathname === '/favicon.ico') {response.writeHead(204); response.end(); return;}
    if (pathname.startsWith(mediaPrefix)) {
      const asset = media[pathname.slice(mediaPrefix.length)];
      if (asset) {
        try {
          const body = await readFile(join(root, asset.path));
          response.writeHead(200, {'Content-Type': asset.contentType, 'Cache-Control': 'no-store'});
          response.end(body); return;
        } catch { /* fall through to 404 */ }
      }
    }
    const file = files.get(pathname);
    response.writeHead(file ? 200 : 404, {'Content-Type': file?.type ?? 'text/plain', 'Cache-Control': 'no-store'});
    response.end(file?.body ?? 'Not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  const url = `http://127.0.0.1:${port}/${mode}.html`;
  if (args.includes('--serve')) {
    process.stdout.write(`${url}\n`);
    await new Promise(resolve => {process.once('SIGINT', resolve); process.once('SIGTERM', resolve);});
  } else {
    const command = [join(fixture, 'acceptance.py'), '--url', url, '--mode', mode];
    for (const name of ['--screens', '--report', '--out', '--compare', '--browser', '--python']) if (value(name)) command.push(name, value(name));
    const allowed = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'];
    const env = Object.fromEntries(allowed.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
    const child = spawn(value('--python') ?? 'python3', command, {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
    const sanitize = line => line.split(root).join('<repo>/').split(scratch).join('<scratch>').split(homedir()).join('<home>');
    for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      createInterface({input: stream}).on('line', line => destination.write(`${sanitize(line)}\n`));
    }
    const exitCode = await new Promise((resolve, reject) => {child.on('error', reject); child.on('close', code => resolve(code ?? 1));});
    process.exitCode = exitCode;
  }
} catch (error) {
  const detail = String(error?.message ?? error).split(root).join('<repo>/').split(scratch).join('<scratch>').split(homedir()).join('<home>');
  process.stderr.write(`Edit UI fixture failed: ${detail}\n`); process.exitCode = 1;
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(scratch, {recursive: true, force: true});
}

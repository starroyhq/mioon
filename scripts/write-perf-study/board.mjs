/** Browser-only study of a format-5 canvas pan using the existing real-RPC stress fixture. */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {createBoardUiWireStressFixture} from '../../tests/helpers/board-ui-wire-fixture.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runs = Number(process.env.MIOON_BOARD_STUDY_RUNS ?? 3);
assert.ok(Number.isInteger(runs) && runs >= 1 && runs <= 10, 'MIOON_BOARD_STUDY_RUNS must be 1–10');
const trace = process.env.MIOON_BOARD_STUDY_TRACE !== '0';
const selectableModes = ['baseline', 'pause-edge-motion', 'small-scale-edge-detail', 'overview-static-edges', 'overview-composited'];
const modes = (process.env.MIOON_BOARD_STUDY_MODES ?? selectableModes.slice(0, 3).join(',')).split(',');
assert.ok(modes.includes('baseline') && new Set(modes).size === modes.length && modes.every(mode => selectableModes.includes(mode)),
  'MIOON_BOARD_STUDY_MODES must include baseline and distinct known trial modes');
const focus = process.env.MIOON_BOARD_STUDY_FOCUS ?? 'both';
assert.ok(['stock', 'requested', 'both'].includes(focus), 'MIOON_BOARD_STUDY_FOCUS must be stock, requested or both');
const scratch = await mkdtemp(join(await realpath(tmpdir()), 'mioon-board-study-'));
const session = `bws-${randomBytes(4).toString('hex')}`;
const servers = [];
const fixtures = [];
const execute = promisify(execFile);
const cli = (...args) => execute(process.env.MIOON_BOARD_PLAYWRIGHT_CLI ?? 'playwright-cli',
  ['--session', session, ...args], {cwd: scratch, timeout: 300_000, maxBuffer: 8 * 1024 ** 2});
const at = '2026-01-01T00:00:00.000Z';
const id = (prefix, index) => `${prefix}-0000-4000-8000-${String(index).padStart(12, '0')}`;

function extendTo900Edges({store, projectId}) {
  // A format-5 sequence cannot give the same clip two successors. Add a
  // distinct film with 200 synthetic media nodes, leaving the original
  // 500-shot timeline, its clips and its sync baseline untouched.
  const assetId = id('77000000', 1);
  const filmId = id('78000000', 1);
  store.tx(() => {
    store.put('assets', {id: assetId, projectId, name: 'Synthetic study still.png', mimeType: 'image/png', duration: null,
      sha256: 'd'.repeat(64), sizeBytes: 10});
    store.put('nodes', {id: filmId, projectId, type: 'sequence_root', revision: 1, name: 'Study film',
      position: {x: -120, y: 20}, createdAt: at});
    for (let index = 1; index <= 200; index++) {
      const nodeId = id('79000000', index);
      store.put('nodes', {id: nodeId, projectId, type: 'image', assetId, revision: 1, label: `Study still ${index}`,
        position: {x: ((index - 1) % 20) * 294 + 100, y: Math.floor((index - 1) / 20) * 345 + 40}, createdAt: at});
      store.put('edges', {id: id('7a000000', index), projectId, kind: 'sequence',
        source: index === 1 ? filmId : id('79000000', index - 1), target: nodeId, createdAt: at});
    }
  });
}

async function buildFixture() {
  const require = createRequire(join(root, 'apps/web/package.json'));
  const resolvePackage = name => import(pathToFileURL(require.resolve(name)).href);
  const {build} = await resolvePackage('vite');
  const {default: tailwind} = await resolvePackage('@tailwindcss/vite');
  const outDir = join(scratch, 'bundle');
  await build({configFile: false, root: join(root, 'apps/web'), logLevel: 'warn', plugins: [tailwind()],
    resolve: {alias: {react: join(root, 'apps/web/node_modules/react'), 'react-dom': join(root, 'apps/web/node_modules/react-dom')}},
    build: {outDir, emptyOutDir: true, minify: false, cssCodeSplit: true, copyPublicDir: false,
      rollupOptions: {input: join(root, 'tests/fixtures/board-ui-wire/entry.tsx'),
        onwarn(warning, warn) { if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning); },
        output: {entryFileNames: 'board.js', chunkFileNames: 'board-[name].js', assetFileNames: '[name][extname]'}}}});
  const types = {'.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2'};
  const files = new Map();
  const styles = [];
  for (const file of await readdir(outDir, {recursive: true, withFileTypes: true})) {
    if (!file.isFile()) continue;
    const fullPath = join(file.parentPath, file.name);
    const url = `/${relative(outDir, fullPath).split('\\').join('/')}`;
    const extension = file.name.slice(file.name.lastIndexOf('.'));
    files.set(url, {type: types[extension] ?? 'application/octet-stream', bytes: await readFile(fullPath)});
    if (extension === '.css') styles.push(`<link rel="stylesheet" href="${url}">`);
  }
  const html = `<!doctype html><html lang="zh-Hans"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Board pan study</title>${styles.join('')}<div id="root"></div><script type="module" src="/board.js"></script></html>`;
  files.set('/', {type: 'text/html', bytes: Buffer.from(html)});
  return files;
}

async function serve(files, fixture) {
  let rpcCount = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    if (url.pathname === '/rpc' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      try {
        const {operation, input} = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        rpcCount++;
        const data = await fixture.services.call(operation, input ?? {});
        response.writeHead(200, {'content-type': 'application/json'});
        response.end(JSON.stringify({ok: true, data: operation === 'project.get' ? {...data, projectFormatVersion: 5} : data}));
      } catch (error) {
        response.writeHead(200, {'content-type': 'application/json'});
        response.end(JSON.stringify({ok: false, error: {code: error.code ?? 'STUDY_RPC_FAILED'}}));
      }
      return;
    }
    if (url.pathname === '/study/rpc-count') {
      response.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'});
      response.end(JSON.stringify({rpcCount}));
      return;
    }
    const file = files.get(url.pathname);
    if (!file) {response.writeHead(404); response.end(); return;}
    response.writeHead(200, {'content-type': file.type, 'cache-control': 'no-store'});
    response.end(file.bytes);
  });
  servers.push(server);
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}/`;
}

let failed = false;
try {
  const files = await buildFixture();
  const scenarios = {};
  for (const name of (focus === 'both' ? ['stock', 'requested'] : [focus])) {
    const fixture = await createBoardUiWireStressFixture();
    fixtures.push(fixture);
    if (name === 'requested') extendTo900Edges(fixture);
    scenarios[name] = {url: await serve(files, fixture), shots: 500,
      sequenceEdges: name === 'requested' ? 700 : 500, referenceEdges: 200};
  }
  const config = join(scratch, 'playwright-cli.json');
  await writeFile(config, JSON.stringify({browser: {
    launchOptions: {headless: true, chromiumSandbox: true},
    contextOptions: {viewport: {width: 1440, height: 900}, locale: 'zh-Hans', reducedMotion: 'no-preference'},
  }}));
  await cli('open', Object.values(scenarios)[0].url, '--browser', 'chrome', '--config', config);
  const browser = (await readFile(new URL('./board-browser.js', import.meta.url), 'utf8')).trim();
  const {stdout} = await cli('run-code', `async page => (${browser})(page, ${JSON.stringify({runs, trace, scenarios, modes})})`);
  const marker = 'BOARD_STUDY_JSON:';
  const line = stdout.split('\n').find(value => value.startsWith(marker) || value.startsWith(`"${marker}`));
  assert.ok(line, `Browser did not return study results. ${stdout.slice(0, 2000)}`);
  const serialized = (line.startsWith('"') ? JSON.parse(line) : line).slice(marker.length);
  process.stdout.write(`${JSON.stringify(JSON.parse(serialized))}\n`);
} catch (error) {
  failed = true;
  console.error(error.stderr || error.message);
} finally {
  await cli('close').catch(() => {});
  for (const server of servers) await new Promise(resolve => server.close(resolve));
  for (const fixture of fixtures) {
    await fixture.services.drain();
    fixture.store.close();
    fixture.library.close();
    await rm(fixture.root, {recursive: true, force: true});
  }
  await rm(scratch, {recursive: true, force: true});
}
process.exitCode = failed ? 1 : 0;

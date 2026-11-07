/** Optional real Chromium component regression; no browser dependency is added.
 * Start: node tests/browser_timeline_media_read_gate.mjs --serve --out /private/tmp/q01-browser
 * Execute runTimelineMediaReadGateAcceptance({page,url}) using an existing
 * Playwright page, or pass --print-run-code to emit a CLI run-code function.
 * Assert the returned report.passed. Use a fresh fixture server for each run.
 * Stop only this server with SIGTERM. Its final metadata records normal close.
 * --baseline-dir may load the three archived pre-fix sources without touching
 * the checkout. It is only for a causal red run; ordinary runs use current code.
 */
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname, join, resolve, sep} from 'node:path';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createServer as createHttpServer} from 'node:http';
import {waveformSchemas, waveformResponseSchema, WAVEFORM_ALGORITHM} from '../packages/contracts/src/waveforms.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectId = '11111111-1111-4111-8111-111111111111';
const assetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export async function startTimelineMediaReadGateFixture({outDir, baselineDir} = {}) {
  if (!outDir) throw new Error('An explicit disposable --out directory is required');
  const output = resolve(outDir);
  if (output === root || output.startsWith(root + sep)) throw new Error('Fixture output must be outside the checkout');
  await mkdir(output, {recursive: true});
  const web = createRequire(join(root, 'apps/web/package.json'));
  const {createServer} = await import(web.resolve('vite'));
  const calls = [];
  const overrides = new Map();
  if (baselineDir) for (const name of ['Timeline.tsx', 'use-timeline-waveforms.ts', 'waveform-state.ts']) {
    overrides.set(join(root, 'apps/web/src', name), await readFile(join(resolve(baselineDir), name), 'utf8'));
  }
  const http = createHttpServer();
  const server = await createServer({configFile: false, root: join(root, 'tests/fixtures/timeline-media-read-gate'),
    cacheDir: join(output, 'vite-cache'), mode: 'development', logLevel: 'warn',
    define: {'process.env.NODE_ENV': '"development"'},
    resolve: {alias: {react: join(root, 'apps/web/node_modules/react'), 'react-dom': join(root, 'apps/web/node_modules/react-dom')}, dedupe: ['react', 'react-dom']},
    // An owned HTTP server supplies true port:0 and normal, observable shutdown.
    // Middleware mode also avoids Vite's own SIGTERM/process.exit handler.
    server: {middlewareMode: true, hmr: {server: http}, fs: {allow: [root]}},
    plugins: [{name: 'timeline-media-read-gate-fixture', enforce: 'pre',
      load(id) {return overrides.get(id.split('?')[0]);},
      configureServer(vite) {vite.middlewares.use(async (request, response, next) => {
        const send = (status, body) => {response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body));};
        if (request.url === '/__fixture/rpc-log' && request.method === 'GET') {send(200, {calls}); return;}
        if (!request.url?.startsWith('/api/')) {next(); return;}
        try {
          if (request.url !== `/api/projects/${projectId}/rpc` || request.method !== 'POST') throw new Error('Unexpected fixture API route');
          let text = ''; for await (const chunk of request) {text += chunk.toString(); if (text.length > 4096) throw new Error('Fixture request too large');}
          const body = JSON.parse(text);
          if (!body || Object.keys(body).sort().join(',') !== 'input,operation' || body.operation !== 'asset.waveform.get') throw new Error('Unexpected fixture operation');
          const input = waveformSchemas['asset.waveform.get'].parse(body.input);
          if (input.projectId !== projectId || input.assetId !== assetId) throw new Error('Foreign fixture identity');
          calls.push({operation: body.operation, input});
          const data = waveformResponseSchema.parse({projectId, assetId, algorithm: WAVEFORM_ALGORITHM, binsPerSecond: 100, status: 'ready',
            attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', duration: 10, sourceFrames: 300, decodedSampleFrames: 480000, clipped: false,
            sourceStartFrame: input.sourceStartFrame, sourceEndFrame: input.sourceEndFrame ?? 300, peaks: [0, 0.5, 1].slice(0, input.points)});
          send(200, {ok: true, data});
        } catch (error) {calls.push({rejected: String(error)}); send(400, {ok: false, error: {code: 'VALIDATION_ERROR', message: 'Unexpected synthetic fixture request'}});}
      });},
    }],
  });
  http.on('request', server.middlewares);
  await new Promise((accept, reject) => {http.once('error', reject); http.listen(0, '127.0.0.1', accept);});
  const address = http.address();
  if (!address || typeof address === 'string') {await server.close(); throw new Error('Missing fixture loopback address');}
  const metadata = {pid: process.pid, url: `http://127.0.0.1:${address.port}`, baseline: baselineDir ? resolve(baselineDir) : null,
    fixtureOnly: true, reactMode: 'development', closed: false};
  await writeFile(join(output, 'server.json'), JSON.stringify(metadata, null, 2) + '\n');
  return {url: metadata.url, async close() {
    const closing = new Promise((accept, reject) => http.close(error => error ? reject(error) : accept()));
    http.closeAllConnections(); await Promise.all([closing, server.close()]);
    metadata.closed = true; await writeFile(join(output, 'server.json'), JSON.stringify(metadata, null, 2) + '\n');
  }};
}

// This function is self-contained so playwright-cli can execute its printed
// source without dynamic importing Node modules inside its browser-command VM.
export async function runTimelineMediaReadGateAcceptance({page, url}) {
  const result = {fixtureOnly: true, react: 'real createRoot/Profiler', checks: [], errors: [], report: null, passed: false};
  const check = (condition, message) => {if (!condition) throw new Error(message); result.checks.push(message);};
  const onError = error => result.errors.push(String(error));
  const onConsole = message => {if (message.type() === 'error') result.errors.push(message.text());};
  page.on('pageerror', onError); page.on('console', onConsole);
  const settle = () => page.evaluate(async () => {await document.fonts.ready; for (let i = 0; i < 8; i++) await new Promise(resolve => requestAnimationFrame(resolve));});
  const report = async () => JSON.parse(await page.getByTestId('fixture-report').innerText());
  const bounded = async stage => {const value = await report(); check(value.commitsByStage[stage] > 0 && value.commitsByStage[stage] < 20, `${stage}: fewer than 20 real React commits`); result.report = value;};
  const requests = () => page.evaluate(async () => (await (await fetch('/__fixture/rpc-log')).json()).calls);
  try {
    await page.goto(url); await page.waitForLoadState('networkidle'); await settle();
    await bounded('empty'); check(await page.getByTestId('timeline-panel').isVisible(), 'Empty Timeline stays visible with a non-null read gate');
    check((await requests()).length === 0, 'Empty Timeline performs no waveform request');
    await page.getByTestId('fixture-add-clip').click(); await settle(); await bounded('clip');
    await page.getByTestId('timeline-waveform-toggle').click();
    await page.getByTestId('timeline-waveform-clip-one').filter({has: page.locator('svg path')}).waitFor({state: 'visible'});
    await settle(); await bounded('clip');
    const before = await requests(); result.waveformReads = before;
    check(before.length > 0 && before.every(call => call.operation === 'asset.waveform.get'), 'Readable audio obtains a real HTTP waveform result');
    await page.getByTestId('fixture-deny').click(); await settle(); await bounded('denied');
    check(await page.getByTestId('timeline-clip-clip-one').isVisible(), 'Revoking reads preserves the timeline clip row');
    check(await page.getByTestId('timeline-waveform-clip-one').count() === 0, 'Revoking reads removes the waveform');
    await page.getByTestId('timeline-scroll').evaluate(element => {element.scrollLeft = 40; element.dispatchEvent(new Event('scroll'));});
    await page.getByTestId('timeline-waveform-toggle').click(); await page.getByTestId('timeline-waveform-toggle').click();
    await page.getByTestId('fixture-parent-render').click(); await settle(); await bounded('denied-parent-render');
    result.afterDeniedReads = await requests();
    check(JSON.stringify(result.afterDeniedReads) === JSON.stringify(before), 'Denied media causes no new waveform read after scroll, toggles and a parent render');
    await page.getByTestId('fixture-allow').click();
    await page.getByTestId('timeline-waveform-clip-one').filter({has: page.locator('svg path')}).waitFor({state: 'visible'});
    await settle(); await bounded('allowed');
    check(result.errors.length === 0, 'No console error, page error, #185 or maximum update depth'); result.passed = true;
  } catch (error) {result.failure = String(error); result.report = await report().catch(() => null);}
  finally {page.off('pageerror', onError); page.off('console', onConsole);}
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = key => {const index = process.argv.indexOf(key); return index < 0 ? undefined : process.argv[index + 1];};
  if (process.argv.includes('--print-run-code')) {
    const url = argument('--url'); if (!url) throw new Error('--url is required');
    // Return the failure evidence even when React destroys its root. The CLI
    // caller must assert result.passed; throwing first would discard the report.
    console.log(`async (page) => (${runTimelineMediaReadGateAcceptance.toString()})({page,url:${JSON.stringify(url)}})`);
  } else if (process.argv.includes('--serve')) {
    const fixture = await startTimelineMediaReadGateFixture({outDir: argument('--out'), baselineDir: argument('--baseline-dir')});
    console.log(JSON.stringify({url: fixture.url, pid: process.pid, fixtureOnly: true}));
    let stopping = false;
    const stop = async () => {if (stopping) return; stopping = true; await fixture.close();};
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } else throw new Error('Use --serve or --print-run-code; this optional browser group is not a node:test suite');
}

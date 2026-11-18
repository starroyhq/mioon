/** Standalone SP-M cross-runtime check. It bundles only the pure mapping fixture
 * with esbuild, serves it from a loopback server and compares the Chromium
 * integer tables and stable hash with the committed Node fixture. No application
 * or project host starts. */
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = join(root, 'tests/fixtures/timeline-time-map');
const args = process.argv.slice(2);
const value = name => {const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1];};
const scratch = await mkdtemp(join(tmpdir(), 'mioon-time-map-'));
let server;
try {
  await build({entryPoints: [join(fixture, 'entry.ts')], bundle: true, format: 'esm', platform: 'browser',
    outfile: join(scratch, 'fixture.js'), define: {'process.env.NODE_ENV': '"production"'}, logLevel: 'silent'});
  const files = new Map([['/fixture.js', {body: await readFile(join(scratch, 'fixture.js')), type: 'text/javascript'}]]);
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
    if (pathname === '/favicon.ico') {response.writeHead(204); response.end(); return;}
    if (pathname === '/') {
      response.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
      response.end('<!doctype html><html lang="en"><meta charset="utf-8"><body><script type="module" src="/fixture.js"></script></body></html>');
      return;
    }
    const file = files.get(pathname);
    response.writeHead(file ? 200 : 404, {'Content-Type': file?.type ?? 'text/plain', 'Cache-Control': 'no-store'});
    response.end(file?.body ?? 'Not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  const url = `http://127.0.0.1:${port}/`;
  if (args.includes('--serve')) {
    process.stdout.write(`${url}\n`);
    await new Promise(resolve => {process.once('SIGINT', resolve); process.once('SIGTERM', resolve);});
  } else {
    const command = [join(fixture, 'acceptance.py'), '--url', url,
      '--fixture', join(fixture, 'cross-runtime-v1.json')];
    for (const name of ['--report', '--browser', '--python']) if (value(name)) command.push(name, value(name));
    const allowed = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'];
    const env = Object.fromEntries(allowed.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
    const child = spawn(value('--python') ?? 'python3', command, {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
    const sanitize = line => line.split(root).join('<repo>/').split(scratch).join('<scratch>').split(homedir()).join('<home>');
    for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      createInterface({input: stream}).on('line', line => destination.write(`${sanitize(line)}\n`));
    }
    process.exitCode = await new Promise((resolve, reject) => {child.on('error', reject); child.on('close', code => resolve(code ?? 1));});
  }
} catch (error) {
  const detail = String(error?.message ?? error).split(root).join('<repo>/').split(scratch).join('<scratch>').split(homedir()).join('<home>');
  process.stderr.write(`Time-map fixture failed: ${detail}\n`);
  process.exitCode = 1;
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(scratch, {recursive: true, force: true});
}

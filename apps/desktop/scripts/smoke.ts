import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrateData } from './migrate-data.ts';
import {providerEnvironmentKeys} from '@mioon/business';
const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(path.join(tmpdir(), 'mioon-electron-smoke-'));
const output = process.env.MIOON_DESKTOP_SMOKE_OUTPUT || path.join(directory, 'report.json');
await mkdir(path.dirname(output), { recursive: true });
// Only the repository's original geometric/tonal synthetic example is seeded.
// Migration deliberately excludes tokens, locks and Chromium state.
await migrateData(path.resolve(desktop, '../../examples/multitrack-project'), path.join(directory, 'user-data/workspace'));
const env: NodeJS.ProcessEnv = { ...process.env, MIOON_DESKTOP_USER_DATA: path.join(directory, 'user-data'), MIOON_DESKTOP_SMOKE_OUTPUT: output,
  MIOON_ENABLE_LIVE_PROVIDER: '0' };
for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', ...providerEnvironmentKeys.filter(key=>key!=='MIOON_ENABLE_LIVE_PROVIDER')]) delete env[name];
const args = [path.join(desktop, 'build')];
if (process.env.MIOON_DESKTOP_HEADLESS === '1') args.unshift('--ozone-platform=headless');
const child = spawn(require('electron'), args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
let tail = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { tail = (tail + data).slice(-12000); });
const timer = setTimeout(() => child.kill('SIGTERM'), 180000);
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
const code = await new Promise(resolve => child.once('close', resolve));
clearTimeout(timer);
try {
  const report = JSON.parse(await readFile(output, 'utf8'));
  console.log(JSON.stringify({ ...report, reportFile: output }, null, 2));
  if (!report.ok || code !== 0) { console.error(tail); process.exitCode = 1; }
} catch {
  console.error(`Electron smoke did not finish (exit ${code}). A sandbox-capable graphical Linux session is required. No sandbox bypass is used.\n${tail}`);
  process.exitCode = 1;
}

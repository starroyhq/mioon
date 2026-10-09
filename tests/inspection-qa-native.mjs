/** Ordinary sandboxed desktop regression fixture; no model fixture or UI hooks. */
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {access, appendFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {migrateData} from '../apps/desktop/scripts/migrate-data.mjs';

const root = path.resolve('evidence/agent-inspection/native-runtime');
const userData = path.join(root, 'user-data'), workspace = path.join(userData, 'workspace');
await mkdir(root, {recursive: true});
try { await access(path.join(workspace, 'workbench.sqlite')); }
catch { await migrateData(path.resolve('examples/multitrack-project'), workspace); }
if (process.argv.includes('--prepare')) { console.log(workspace); process.exit(0); }

const require = createRequire(import.meta.url);
const env = {...process.env, MIOON_DESKTOP_USER_DATA: userData,
  MIOON_FFMPEG_PATH: '/usr/bin/ffmpeg', MIOON_FFPROBE_PATH: '/usr/bin/ffprobe',
  MIOON_ENABLE_LIVE_PROVIDER: '0'};
for (const name of Object.keys(env)) {
  if (/^(RUNWAY|RUNWAYML|ARK_|VEO_|GEMINI_|MINIMAX_|HAILUO_|VIDU_|OPENAI_|DEEPSEEK_|DASHSCOPE_|MOONSHOT_)/.test(name) ||
      ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'MIOON_DESKTOP_SMOKE_OUTPUT'].includes(name)) delete env[name];
}
const startedAt = new Date().toISOString();
const child = spawn(require('electron'), [path.resolve('apps/desktop/build')],
  {env, stdio: ['ignore', 'pipe', 'pipe']});
await writeFile(path.join(root, 'launch.json'), JSON.stringify({startedAt, pid: child.pid,
  binary: require('electron'), sandboxUnchanged: true, remoteDebugging: false,
  smokeHooks: false, liveProvidersDisabled: true, modelFixture: false}, null, 2));
for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
  void appendFile(path.join(root, 'electron.log'), bytes);
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', async (code, signal) => {
  await writeFile(path.join(root, 'exit.json'), JSON.stringify({startedAt,
    endedAt: new Date().toISOString(), code, signal}, null, 2));
  process.exitCode = code || 0;
});

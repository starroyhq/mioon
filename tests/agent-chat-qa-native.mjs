/** Ordinary sandboxed Electron plus a synthetic local HTTP model-shaped fixture.
 * No remote debugging, renderer hooks, real keys, live providers or media uploads. */
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir, writeFile, readFile, access, appendFile} from 'node:fs/promises';
import path from 'node:path';
import {migrateData} from '../apps/desktop/scripts/migrate-data.mjs';
import {startChatQaMock} from './agent-chat-qa-mock.mjs';
const root = path.resolve(process.argv.includes('--responses') ? 'evidence/agent-responses/native-runtime' : 'evidence/agent-chat/native-runtime'), userData = path.join(root, 'user-data'), workspace = path.join(userData, 'workspace');
await mkdir(root, {recursive: true});
try { await access(path.join(workspace, 'workbench.sqlite')); } catch { await migrateData(path.resolve('examples/multitrack-project'), workspace); }
if (process.argv.includes('--prepare')) { console.log(workspace); process.exit(0); }
let mockPort = 0;
try { const previous = new URL(JSON.parse(await readFile(path.join(root, 'mock/mock.json'), 'utf8')).baseUrl); if (previous.hostname !== '127.0.0.1' || previous.pathname !== '/v1') throw Error('Invalid synthetic endpoint'); mockPort = Number(previous.port); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const mock = await startChatQaMock({directory: path.join(root, 'mock'), port: mockPort});
const require = createRequire(import.meta.url), env = {...process.env, MIOON_DESKTOP_USER_DATA: userData, MIOON_FFMPEG_PATH: '/usr/bin/ffmpeg', MIOON_FFPROBE_PATH: '/usr/bin/ffprobe', MIOON_ENABLE_LIVE_PROVIDER: '0'};
for (const name of Object.keys(env)) if (/^(RUNWAY|RUNWAYML|ARK_|VEO_|GEMINI_|MINIMAX_|HAILUO_|VIDU_|OPENAI_|DEEPSEEK_|DASHSCOPE_|MOONSHOT_)/.test(name) || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'MIOON_DESKTOP_SMOKE_OUTPUT'].includes(name)) delete env[name];
const startedAt = new Date().toISOString(), child = spawn(require('electron'), [path.resolve('apps/desktop/build')], {env, stdio: ['ignore', 'pipe', 'pipe']});
await writeFile(path.join(root, 'launch.json'), JSON.stringify({startedAt, pid: child.pid, binary: require('electron'), mockBaseUrl: mock.baseUrl, simulated: true, sandboxUnchanged: true, remoteDebugging: false, smokeHooks: false}, null, 2));
for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => appendFile(path.join(root, 'electron.log'), bytes));
child.on('error', async error => { console.error(error.message); await mock.close(); process.exitCode = 1; });
child.on('exit', async (code, signal) => { await writeFile(path.join(root, 'exit.json'), JSON.stringify({startedAt, endedAt: new Date().toISOString(), code, signal, mock: mock.snapshot()})); await mock.close(); process.exitCode = code || 0; });

/** Bounded audit/setup/fault injection for this exact disposable native fixture.
 * No renderer hooks, remote debugging, real keys, arbitrary targets or resume. */
import {readFile, writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {resolveConnection} from '@mioon/client/connection';
import {readToolsQaAudit} from './agent-tools-qa-audit.mjs';

const root = path.resolve('evidence/agent-tools/native-runtime');
const read = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'));
const launch = await read('launch.json');
if (process.platform !== 'linux' || launch.simulated !== true || launch.sandboxUnchanged !== true ||
  launch.remoteDebugging !== false || !Number.isSafeInteger(launch.pid) || launch.pid <= 1) throw Error('Not the isolated Linux tools fixture');
const name = process.argv.find(value => value.startsWith('--name='))?.slice(7) || 'snapshot';
if (!/^[a-z0-9-]{1,60}$/.test(name)) throw Error('Unsafe audit name');
const configure = process.argv.includes('--configure'), crash = process.argv.includes('--crash');
if (configure && crash) throw Error('Choose one bounded action');
let connection;
if (configure || crash) {
  connection = await read('user-data/mcp-connection.json');
  if (!Number.isSafeInteger(connection.pid) || connection.pid <= 1 || connection.pid === launch.pid) throw Error('Invalid fixture PID');
  const [status, command] = await Promise.all([readFile(`/proc/${connection.pid}/status`, 'utf8'), readFile(`/proc/${connection.pid}/cmdline`, 'utf8')]);
  if (Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1]) !== launch.pid || !command.split('\0').includes('--type=utility') || !command.includes('node.mojom.NodeService')) throw Error('Not the launched fixture backend');
  const local = new URL(connection.url), mock = new URL(launch.mockBaseUrl);
  if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || mock.protocol !== 'http:' || mock.hostname !== '127.0.0.1' || mock.pathname !== '/v1') throw Error('Only synthetic loopback fixture endpoints are allowed');
}
if (configure) {
  const resolved = await resolveConnection({MIOON_CONNECTION_FILE: path.join(root, 'user-data/mcp-connection.json')});
  if (resolved.base !== connection.url) throw Error('Connection changed during fixture validation');
  const request = async (method, input) => {
    const response = await fetch(resolved.base + '/api/agent/settings', {method, headers: {authorization: `Bearer ${resolved.token}`, 'content-type': 'application/json'},
      ...(input ? {body: JSON.stringify(input)} : {}), signal: AbortSignal.timeout(10000)});
    const value = await response.json(); if (!response.ok || !value.ok) throw Error(`Synthetic settings failed: ${response.status}`); return value.data;
  };
  const settings = await request('GET');
  await request('PUT', {expectedRevision: settings.revision, configuration: {presetId: 'ollama', platformId: 'local',
    protocol: process.argv.includes('--responses') ? 'responses' : 'chat_completions', baseUrl: launch.mockBaseUrl, model: 'qwen3:8b'}, secret: {action: 'remove'}});
}
const db = new DatabaseSync(path.join(root, 'user-data/workspace/workbench.sqlite'), {readOnly: true});
let domain, runs, agent;
try {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'agent_chat_%' AND name!='workspace_preferences' ORDER BY name").all().map(row => row.name);
  domain = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]));
  runs = db.prepare('SELECT data FROM agent_chat_runs ORDER BY rowid LIMIT 64').all().map(row => JSON.parse(row.data));
  agent = readToolsQaAudit(db);
} finally { db.close(); }
const hash = value => createHash('sha256').update(value).digest('hex');
let mock = [];
try {mock = (await readFile(path.join(root, 'mock/mock-requests.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);} catch (error) {if (error.code !== 'ENOENT') throw error;}
const report = {at: new Date().toISOString(), baseline: '8341029', simulated: true, configured: configure,
  domainHash: hash(JSON.stringify(domain)), runs, agent, mock};
await writeFile(path.join(root, `${name}.json`), JSON.stringify(report, null, 2));
if (crash) {
  const active = runs.filter(run => run.status === 'running');
  if (active.length !== 1 || !active[0].userText.includes('mock:slowanswer') || active[0].contextMode !== 'project_inspection' ||
      active[0].configuration.presetId !== 'ollama' || active[0].configuration.baseUrl !== launch.mockBaseUrl ||
      !active[0].activity.some(step => step.kind === 'tool' && step.status === 'completed') ||
      !active[0].activity.some(step => step.kind === 'model' && step.ordinal === 2 && step.status === 'dispatch_started')) throw Error('Expected exact synthetic tool-completed/answer-active run');
  await writeFile(path.join(root, 'forced-crash-before.json'), JSON.stringify({at: report.at, mainPid: launch.pid, utilityPid: connection.pid,
    run: active[0], modelRequests: mock.filter(record => record.event === 'request').length}, null, 2));
  process.kill(connection.pid, 'SIGKILL');
}
console.log(JSON.stringify({saved: `${name}.json`, configured: configure, crashed: crash, runs: runs.length,
  durableToolObservations: agent.runs.flatMap(run => run.steps).filter(step => step.kind === 'tool' && step.status === 'completed').length,
  modelRequests: mock.filter(record => record.event === 'request').length, domainHash: report.domainHash}));

/** Actual CLI reads against the exact isolated desktop fixture, never UI hooks. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import assert from 'node:assert/strict';

if (process.platform !== 'linux') throw Error('This acceptance fixture verifies Linux only');
const root = path.resolve('evidence/agent-inspection/native-runtime');
const read = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'));
const launch = await read('launch.json');
const connectionFile = path.join(root, 'user-data/mcp-connection.json');
const connection = await read('user-data/mcp-connection.json');
if (!launch.sandboxUnchanged || launch.remoteDebugging || launch.smokeHooks ||
    !Number.isSafeInteger(launch.pid) || launch.pid <= 1 ||
    !Number.isSafeInteger(connection.pid) || connection.pid <= 1) throw Error('Invalid fixture identity');
const processStatus = await readFile(`/proc/${connection.pid}/status`, 'utf8');
if (Number(/^PPid:\s+(\d+)$/m.exec(processStatus)?.[1]) !== launch.pid)
  throw Error('The connection is not owned by the launched fixture');

const db = new DatabaseSync(path.join(root, 'user-data/workspace/workbench.sqlite'), {readOnly: true});
const rows = () => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all().map(({name}) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
  const before = rows(), versionBefore = db.prepare('PRAGMA data_version').get().data_version;
  const projectId = db.prepare('SELECT id FROM projects ORDER BY id LIMIT 1').get()?.id;
  if (!projectId) throw Error('Prepared synthetic workspace has no project');
  const exec = promisify(execFile), results = [];
  const env = {PATH: process.env.PATH || '', HOME: root,
    MIOON_CONNECTION_FILE: connectionFile, MIOON_ENABLE_LIVE_PROVIDER: '0'};
  for (const operation of ['project.inspect', 'asset.inspect', 'shot.inspect', 'timeline.inspect']) {
    const input = {projectId, ...(['asset.inspect', 'shot.inspect'].includes(operation) ? {limit: 2} : {})};
    const {stdout} = await exec(process.execPath, [path.resolve('apps/cli/src/index.ts'),
      ...operation.split('.'), '--input', JSON.stringify(input)], {env, timeout: 10000, maxBuffer: 256 * 1024});
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true, operation);
    results.push({operation, input, result});
  }
  const after = rows(), versionAfter = db.prepare('PRAGMA data_version').get().data_version;
  assert.deepEqual(after, before, 'Inspection changed stored records');
  assert.equal(versionAfter, versionBefore, 'Another database connection committed during inspection');
  const report = {at: new Date().toISOString(), baseline: 'ce60c97',
    runtime: 'Ordinary sandboxed Linux Electron, inspected through actual CLI HTTP calls',
    mainPid: launch.pid, utilityPid: connection.pid, allTablesUnchanged: true,
    dataVersionBefore: versionBefore, dataVersionAfter: versionAfter,
    databaseHashBefore: hash(before), databaseHashAfter: hash(after),
    noModelToolExecution: true, results};
  await writeFile(path.join(root, 'inspection-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({passed: true, operations: results.length,
    allTablesUnchanged: true, databaseHash: report.databaseHashAfter}));
} finally { db.close(); }

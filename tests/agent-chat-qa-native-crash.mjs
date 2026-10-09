/** One-shot fault injection for the exact isolated Linux Electron fixture.
 * Never imported by production, never a server/renderer capability. */
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

if (process.platform !== 'linux' || !process.argv.includes('--durable')) throw Error('Only the isolated durable Linux acceptance fixture is supported');
const root = path.resolve('evidence/agent-durable/native-runtime');
const launch = JSON.parse(await readFile(path.join(root, 'launch.json'), 'utf8'));
const connection = JSON.parse(await readFile(path.join(root, 'user-data/mcp-connection.json'), 'utf8'));
if (launch.simulated !== true || launch.sandboxUnchanged !== true || launch.remoteDebugging !== false ||
    !Number.isSafeInteger(launch.pid) || launch.pid <= 1 || !Number.isSafeInteger(connection.pid) || connection.pid <= 1 || connection.pid === launch.pid) throw Error('Invalid isolated fixture ownership');
const [status, command] = await Promise.all([
  readFile(`/proc/${connection.pid}/status`, 'utf8'), readFile(`/proc/${connection.pid}/cmdline`, 'utf8'),
]);
if (Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1]) !== launch.pid ||
    !command.split('\0').includes('--type=utility') || !command.includes('node.mojom.NodeService')) throw Error('Refusing to affect a process outside the launched fixture backend');
const db = new DatabaseSync(path.join(root, 'user-data/workspace/workbench.sqlite'), {readOnly: true});
let run;
try {
  const rows = db.prepare("SELECT data FROM agent_chat_runs WHERE status='running' LIMIT 2").all();
  if (rows.length !== 1) throw Error('Expected one active synthetic acceptance run');
  run = JSON.parse(rows[0].data);
  if (!run.assistantText || !run.userText.startsWith('mock:slow ') || run.configuration.presetId !== 'ollama' ||
      run.configuration.baseUrl !== launch.mockBaseUrl || run.modelRequestState !== 'dispatch_started') throw Error('Expected committed prefix from the isolated local mock');
} finally { db.close(); }
const record = {at: new Date().toISOString(), mainPid: launch.pid, utilityPid: connection.pid,
  runId: run.id, requestId: run.requestId, threadId: run.threadId, protocol: run.configuration.protocol,
  committedText: run.assistantText, lastEventId: run.lastEventId, signal: 'SIGKILL', simulated: true};
await writeFile(path.join(root, 'forced-crash-before.json'), JSON.stringify(record, null, 2));
process.kill(connection.pid, 'SIGKILL');
console.log(JSON.stringify({injected: true, utilityPid: connection.pid, runId: run.id, simulated: true}));

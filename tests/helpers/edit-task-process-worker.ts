// Disposable IPC worker: real store ownership and services, synthetic metadata only.
// Faults kill this worker before its reply, without closing SQLite or removing its lock.
import {openStore} from '../../packages/business/src/db.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {createEditTasks} from '../../packages/business/src/edit-tasks.ts';

const taskMethods = new Set(['prepare', 'get', 'list', 'execute', 'reconcile', 'acknowledge', 'reconcileStartup']);
const localOperations = new Set(['subject.create', 'subject.version.add', 'subject.binding.set', 'subject.list',
  'subject.version.list', 'subject.binding.list', 'node.create', 'asset.range.set', 'asset.disposition.set']);
const crashPhases = new Set(['afterPreparePersist', 'afterClaim', 'afterBusinessCommit',
  'beforeOutcomePersist', 'afterOutcomePersist', 'afterAcknowledge']);
interface WorkerMessage {readonly id: string; readonly method: string; readonly input: Record<string, unknown> & {operation?: string; input?: unknown; [key: string]: unknown}}
type TaskWorker = ReturnType<typeof createEditTasks>
let store: ReturnType<typeof openStore>|undefined, tasks: TaskWorker|undefined, armed: string|null, closing: Promise<void>|undefined;
const dispatches: {operation: string; input: unknown}[] = [], phases: string[] = [];
const report = (message: unknown): void => { if (process.connected) process.send?.(message); };
// WORKER_STARTUP_DIAGNOSTIC: fixed phase labels and numeric counters only, never fixture inputs or paths.
const startupEntered = process.hrtime.bigint();
const startupResourceKeys = ['userCPUTime', 'systemCPUTime', 'maxRSS', 'fsRead', 'fsWrite',
  'voluntaryContextSwitches', 'involuntaryContextSwitches'] as const;
const startupPhase = (phase: string): void => {
  const usage = process.resourceUsage() as unknown as Record<string, unknown>;
  report({type: 'startup-phase', phase,
    elapsedMs: Math.round(Number(process.hrtime.bigint() - startupEntered) / 1000) / 1000,
    resourceUsage: Object.fromEntries(startupResourceKeys
      .filter(key => typeof usage[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0)
      .map(key => [key, usage[key]]))});
};
startupPhase('entry-after-imports');
const crashAt = (phase: string): void => {
  phases.push(phase);
  if (armed === phase) process.kill(process.pid, 'SIGKILL');
};
const close = () => closing ??= (async () => {
  await tasks?.drain();
  store?.close();
  if (process.connected) process.disconnect();
})();

try {
  startupPhase('open-store-start');
  store = openStore(process.argv[2]);
  startupPhase('open-store-end');
  startupPhase('services-start');
  const services = createServices(store, new Map());
  startupPhase('services-end');
  startupPhase('tasks-start');
  tasks = createEditTasks({store, services: {call(operation: string, input: never) {
    dispatches.push({operation, input});
    return services.call(operation, input);
  }}, fault: crashAt} as never);
  startupPhase('tasks-end');
  startupPhase('reconcile-start');
  const startup = tasks.reconcileStartup();
  startupPhase('reconcile-end');
  process.on('message', async (raw: unknown) => {
    const message = raw as WorkerMessage;
    try {
      if (message.method === 'close') { await close(); return; }
      let data: unknown;
      if (message.method === 'arm') {
        if (typeof message.input !== 'string' || !crashPhases.has(message.input)) throw Error('Unsupported fixture crash phase');
        armed = message.input;
        data = {armed};
      } else if (message.method === 'observe') {
        data = {dispatches, phases};
      } else if (message.method === 'snapshot') {
        // The worker holds the project, so the test reads these tables on this connection.
        const tables: unknown = message.input;
        if (!Array.isArray(tables) || !tables.every(name => typeof name === 'string' && /^[a-z_]+$/.test(name))) throw Error('Unsupported fixture snapshot');
        data = Object.fromEntries((tables as string[]).map(table => [table, store!.db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all().map(row => ({...row}))]));
      } else if (message.method === 'rpc') {
        if (!localOperations.has(String(message.input.operation))) throw Error('Unsupported fixture operation');
        data = await services.call(String(message.input.operation), message.input.input as never);
      } else {
        if (!taskMethods.has(message.method)) throw Error('Unsupported fixture task method');
        const taskMethod = (tasks as unknown as Record<string, (input: unknown) => Promise<unknown>>)[message.method];
        data = await taskMethod(message.input);
        if (message.method === 'acknowledge') crashAt('afterAcknowledge');
      }
      report({type: 'reply', id: message.id, data});
    } catch (error) {
      const failure = error as {code?: string; message?: string};
      report({type: 'reply', id: message.id, error: {code: failure.code, message: failure.message ?? String(error)}});
    }
  });
  report({type: 'ready', pid: process.pid, startup});
} catch (error) {
  process.exitCode = 1;
  report({type: 'fatal', message: (error as {stack?: string}).stack || String(error)});
  await close();
}
process.once('disconnect', () => { close().catch(() => { process.exitCode = 1; }); });

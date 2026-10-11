// Disposable IPC worker: real store ownership and services, synthetic metadata only.
// Faults kill this worker before its reply, without closing SQLite or removing its lock.
import {openStore} from '../../packages/business/src/db.mjs';
import {createServices} from '../../packages/business/src/services.mjs';
import {createEditTasks} from '../../packages/business/src/edit-tasks.mjs';

const taskMethods = new Set(['prepare', 'get', 'list', 'execute', 'reconcile', 'acknowledge', 'reconcileStartup']);
const localOperations = new Set(['subject.create', 'subject.version.add', 'subject.binding.set', 'subject.list',
  'subject.version.list', 'subject.binding.list', 'node.create', 'asset.range.set', 'asset.disposition.set']);
const crashPhases = new Set(['afterPreparePersist', 'afterClaim', 'afterBusinessCommit',
  'beforeOutcomePersist', 'afterOutcomePersist', 'afterAcknowledge']);
let store, tasks, armed, closing;
const dispatches = [], phases = [];
const report = message => { if (process.connected) process.send(message); };
const crashAt = phase => {
  phases.push(phase);
  if (armed === phase) process.kill(process.pid, 'SIGKILL');
};
const close = () => closing ??= (async () => {
  await tasks?.drain();
  store?.close();
  if (process.connected) process.disconnect();
})();

try {
  store = openStore(process.argv[2]);
  const services = createServices(store, new Map());
  tasks = createEditTasks({store, services: {call(operation, input) {
    dispatches.push({operation, input});
    return services.call(operation, input);
  }}, fault: crashAt});
  const startup = tasks.reconcileStartup();
  process.on('message', async message => {
    try {
      if (message.method === 'close') { await close(); return; }
      let data;
      if (message.method === 'arm') {
        if (!crashPhases.has(message.input)) throw Error('Unsupported fixture crash phase');
        armed = message.input;
        data = {armed};
      } else if (message.method === 'observe') {
        data = {dispatches, phases};
      } else if (message.method === 'rpc') {
        if (!localOperations.has(message.input.operation)) throw Error('Unsupported fixture operation');
        data = await services.call(message.input.operation, message.input.input);
      } else {
        if (!taskMethods.has(message.method)) throw Error('Unsupported fixture task method');
        data = await tasks[message.method](message.input);
        if (message.method === 'acknowledge') crashAt('afterAcknowledge');
      }
      report({type: 'reply', id: message.id, data});
    } catch (error) {
      report({type: 'reply', id: message.id, error: {code: error.code, message: error.message}});
    }
  });
  report({type: 'ready', pid: process.pid, startup});
} catch (error) {
  process.exitCode = 1;
  report({type: 'fatal', message: error.stack || String(error)});
  await close();
}
process.once('disconnect', () => { close().catch(() => { process.exitCode = 1; }); });

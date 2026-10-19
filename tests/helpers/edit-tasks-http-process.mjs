/** Disposable backend crash harness. Only trusted fixture IPC can arm a phase;
 * production HTTP and environment variables cannot configure task faults. */
import {startServer} from '../../apps/server/src/index.ts';

let server, armed, started = false, closing;
const phases = [];
const report = message => { if (process.connected) process.send(message); };
const close = () => closing ??= (async () => {
  await server?.close();
  if (process.connected) process.disconnect();
})();
process.on('message', async message => {
  try {
    if (message.type === 'start' && !started) {
      started = true;
      server = await startServer({dataDir: message.dataDir, port: 0, token: message.token,
        taskFault(phase) {
          phases.push(phase);
          if (phase === armed) process.kill(process.pid, 'SIGKILL');
        }});
      report({type: 'ready', pid: process.pid, url: server.url});
    } else if (message.type === 'arm') {
      armed = message.phase;
      report({type: 'reply', requestId: message.requestId, data: {armed}});
    } else if (message.type === 'observe') report({type: 'reply', requestId: message.requestId, data: {phases}});
    else if (message.type === 'close') await close();
  } catch (error) {
    report({type: 'error', message: error.stack || String(error)});
    process.exitCode = 1;
    await close().catch(() => {});
  }
});
process.once('disconnect', () => { close().catch(() => { process.exitCode = 1; }); });

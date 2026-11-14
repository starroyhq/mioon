import {serveProjectCatalog} from './project-catalog-worker.ts';

if (!process.send || !process.connected) throw new Error('Project catalog requires an owned Node IPC channel');
serveProjectCatalog({
  postMessage(value) {
    if (!process.connected) return;
    process.send!(value as Parameters<NonNullable<typeof process.send>>[0], error => {
      if (error && process.connected) process.disconnect!();
    });
  },
  onMessage(listener) { process.on('message', listener); },
  onClose(listener) { process.once('disconnect', listener); },
  close() {
    if (process.connected) process.disconnect!();
    process.removeAllListeners('message');
  },
});

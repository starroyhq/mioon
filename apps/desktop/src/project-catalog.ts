import {serveProjectCatalog} from '../../server/src/project-catalog-worker.ts';
import {initializeDesktopPrivateStorage} from '../../../packages/node-host/src/private-storage-bootstrap.ts';
import {desktopProjectCatalogPort} from './project-catalog-port.ts';

if (!process.parentPort || !process.versions.electron) {
  throw new Error('Project catalog must run in Electron utilityProcess');
}
initializeDesktopPrivateStorage(process.env.MIOON_DESKTOP_PRIVATE_STORAGE_HELPER ?? '');

const parent = process.parentPort;
let bound = false;
// Keep the native parent port referenced. It supplies exactly one private
// channel; only the backend peer can issue scan requests after that transfer.
parent.on('message', ({data, ports}) => {
  if (bound) {
    for (const port of ports) port.close();
    return;
  }
  if (data !== 'start-project-catalog' || ports.length !== 1) {
    process.exit(1);
  }
  bound = true;
  const [port] = ports;
  const transport = desktopProjectCatalogPort(port);
  transport.onClose(() => setImmediate(() => process.exit(0)));
  serveProjectCatalog(transport);
  port.start();
  parent.postMessage('project-catalog-ready');
});

import type {ProjectCatalogMessagePort} from './project-catalog-client.ts';
import {catalogObject, isCatalogScanBatch, scanProjectCatalogFile} from './project-catalog-scan.ts';

/** Only a fixed owned IPC endpoint can admit probes. No filenames or kernel
 * errors are logged or returned in the worker's messages. */
export function serveProjectCatalog(port: ProjectCatalogMessagePort): void {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    port.close();
  };
  port.onClose(close);
  port.onMessage(value => {
    if (closed) return;
    const message = catalogObject(value);
    if (!message || Object.keys(message).length !== 3 || message.type !== 'project-catalog:scan'
      || typeof message.id !== 'number' || !Number.isSafeInteger(message.id) || message.id <= 0 || !isCatalogScanBatch(message.inputs)) {
      close();
      return;
    }
    try {
      const results = message.inputs.map(scanProjectCatalogFile);
      port.postMessage({type: 'project-catalog:result', id: message.id, results});
    } catch { close(); }
  });
}

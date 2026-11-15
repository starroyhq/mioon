import type {MessagePortMain} from 'electron';
import {createProjectCatalogClient, projectCatalogUnavailable} from '../../server/src/project-catalog-client.ts';
import type {ProjectCatalogClient, ProjectCatalogMessagePort} from '../../server/src/project-catalog-client.ts';

export function desktopProjectCatalogPort(port: MessagePortMain): ProjectCatalogMessagePort {
  return {
    postMessage: value => port.postMessage(value),
    onMessage: listener => port.on('message', ({data}) => listener(data)),
    onClose: listener => port.on('close', listener),
    close: () => port.close(),
  };
}

/** A backend keeps this client for its entire lifetime. A scan reads through
 * one owned port, and closing that port retires only its generation. */
export function createDesktopProjectCatalogClient(backendId: string, send: (message: unknown) => void):
ProjectCatalogClient & {attach(message: unknown, ports: readonly MessagePortMain[]): void} {
  let stopped = false;
  let generation = 0;
  let current: ProjectCatalogClient | undefined;
  return {
    attach(message, ports) {
      const input = message as {type?: unknown; backendId?: unknown; generation?: unknown} | null;
      if (stopped || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 3 ||
          input.type !== 'project-catalog:attach' || input.backendId !== backendId || typeof input.generation !== 'number' ||
          !Number.isSafeInteger(input.generation) || input.generation <= generation || ports.length !== 1) {
        for (const port of ports) port.close();
        return;
      }
      const received = input.generation;
      const previous = current;
      generation = received;
      const port = ports[0]!;
      const transport = desktopProjectCatalogPort(port);
      current = createProjectCatalogClient({...transport, close() {
        try {transport.close();} catch { /* The owner still needs to reap its utility. */ }
        if (!stopped && generation === received) {
          current = undefined;
          try {send({type: 'project-catalog:retire', backendId, generation: received});}
          catch { /* A lost parent channel cannot attach a replacement. */ }
        }
      }});
      previous?.close();
      try {port.start();} catch {current?.close();}
    },
    scan(inputs, signal) {
      return current?.scan(inputs, signal) ?? Promise.reject(projectCatalogUnavailable());
    },
    close() {
      stopped = true;
      current?.close();
      current = undefined;
    },
  };
}

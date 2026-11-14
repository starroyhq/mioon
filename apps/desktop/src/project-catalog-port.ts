import type {MessagePortMain} from 'electron';
import type {ProjectCatalogMessagePort} from '../../server/src/project-catalog-client.ts';

export function desktopProjectCatalogPort(port: MessagePortMain): ProjectCatalogMessagePort {
  return {
    postMessage: value => port.postMessage(value),
    onMessage: listener => port.on('message', ({data}) => listener(data)),
    onClose: listener => port.on('close', listener),
    close: () => port.close(),
  };
}

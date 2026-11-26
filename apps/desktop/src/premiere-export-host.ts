import {
  premiereCompletedBundleControlResultSchema, premiereCompletedXmlControlResultSchema,
  type NativePremiereExportControlPort,
} from '../../../packages/contracts/src/project-entry-control.ts';
import {premiereNativeWire} from '../../../packages/contracts/src/project-entry-premiere-bridge.ts';
import {createNativeEditingExportHost, type NativeEditingExportOwner, type NativeEditingExportPresentation} from './native-editing-export-host.ts';

interface Options<Event, Owner extends NativeEditingExportOwner> extends NativeEditingExportPresentation<Event, Owner> {
  backend: NativePremiereExportControlPort;
  openInPremiere(xml: string, beforeOpen: () => boolean): Promise<boolean>;
  premiereInstalled(): Promise<boolean>;
}

export function createPremiereExportHost<Event, Owner extends NativeEditingExportOwner>(options: Options<Event, Owner>) {
  return createNativeEditingExportHost({
    ...options, wire: premiereNativeWire, open: options.openInPremiere, installed: options.premiereInstalled,
    async resolveTarget(input, action) {
      const request = {signal: options.signal};
      if (action === 'reveal') {
        const bundle = premiereCompletedBundleControlResultSchema.parse(await options.backend.completedBundle(input, request));
        return bundle && {...bundle, kind: 'directory'};
      }
      const xml = premiereCompletedXmlControlResultSchema.parse(await options.backend.completedXml(input, request));
      return xml && {...xml, kind: 'file'};
    },
  });
}

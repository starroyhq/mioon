import {fcpCompletedBundleControlResultSchema, type NativeFcpExportControlPort} from '../../../packages/contracts/src/project-entry-control.ts';
import {fcpNativeWire} from '../../../packages/contracts/src/project-entry-fcp-bridge.ts';
import {createNativeEditingExportHost, type NativeEditingExportOwner, type NativeEditingExportPresentation} from './native-editing-export-host.ts';

export type FcpExportOwner = NativeEditingExportOwner;
interface Options<Event, Owner extends FcpExportOwner> extends NativeEditingExportPresentation<Event, Owner> {
  backend: NativeFcpExportControlPort;
  openInFinalCut(bundle: string, beforeOpen: () => boolean): Promise<boolean>;
  finalCutInstalled(): Promise<boolean>;
}

export function createFcpExportHost<Event, Owner extends FcpExportOwner>(options: Options<Event, Owner>) {
  return createNativeEditingExportHost({
    ...options, wire: fcpNativeWire, open: options.openInFinalCut, installed: options.finalCutInstalled,
    async resolveTarget(input) {
      const bundle = fcpCompletedBundleControlResultSchema.parse(await options.backend.completedBundle(input, {signal: options.signal}));
      return bundle && {...bundle, kind: 'directory', marker: 'Info.fcpxml'};
    },
  });
}

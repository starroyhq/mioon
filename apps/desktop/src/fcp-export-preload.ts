import {FCP_EXPORT_NATIVE_CHANNEL, type FcpExportNativeBridge} from '../../../packages/contracts/src/fcp-export-native.ts';
import {fcpNativeWire} from '../../../packages/contracts/src/project-entry-fcp-bridge.ts';
import {createNativeEditingExportPreload} from './native-editing-export-preload.ts';

export function createFcpExportBridge(invoke: (channel: string, request: unknown) => Promise<unknown>): FcpExportNativeBridge {
  const {chooseDestination, reveal, open, installed} = createNativeEditingExportPreload(
    invoke, FCP_EXPORT_NATIVE_CHANNEL, fcpNativeWire, 'openInFinalCut', 'finalCutInstalled',
  );
  return Object.freeze({chooseDestination, reveal, openInFinalCut: open, finalCutInstalled: installed});
}

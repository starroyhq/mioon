import {PREMIERE_EXPORT_NATIVE_CHANNEL, type PremiereExportNativeBridge} from '../../../packages/contracts/src/premiere-export-native.ts';
import {premiereNativeWire} from '../../../packages/contracts/src/project-entry-premiere-bridge.ts';
import {createNativeEditingExportPreload} from './native-editing-export-preload.ts';

export function createPremiereExportBridge(invoke: (channel: string, request: unknown) => Promise<unknown>): PremiereExportNativeBridge {
  const {chooseDestination, reveal, open, installed} = createNativeEditingExportPreload(
    invoke, PREMIERE_EXPORT_NATIVE_CHANNEL, premiereNativeWire, 'openInPremiere', 'premiereInstalled',
  );
  return Object.freeze({chooseDestination, reveal, openInPremiere: open, premiereInstalled: installed});
}

import {createNativeExportWire} from './project-entry-export-bridge.ts';
export {nativeExportDestination as fcpNativeDestination} from './project-entry-export-bridge.ts';

export const fcpNativeWire = createNativeExportWire('openInFinalCut', 'finalCutInstalled', 'FCP_EXPORT_NATIVE');
export const {
  request: fcpNativeRequest, reply: fcpNativeReply, invalid: fcpNativeInvalid, unavailable: fcpNativeUnavailable,
} = fcpNativeWire;

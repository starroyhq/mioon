import {createNativeExportWire} from './project-entry-export-bridge.ts';

export const premiereNativeWire = createNativeExportWire('openInPremiere', 'premiereInstalled', 'PREMIERE_EXPORT_NATIVE');
export const {invalid: premiereNativeInvalid, unavailable: premiereNativeUnavailable} = premiereNativeWire;

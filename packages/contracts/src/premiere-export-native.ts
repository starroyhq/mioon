import type {FcpExportNativeBridge, FcpExportNativeIdentity} from './fcp-export-native.ts';

export const PREMIERE_EXPORT_NATIVE_GLOBAL = '__mioonPremiereExport' as const;
export const PREMIERE_EXPORT_NATIVE_CHANNEL = 'mioon:premiere-export' as const;

/** Desktop-only bridge. Rejections carry a plain {code, status} object. */
export interface PremiereExportNativeBridge extends Pick<FcpExportNativeBridge, 'chooseDestination' | 'reveal'> {
  openInPremiere(identity: FcpExportNativeIdentity): Promise<boolean>;
  premiereInstalled(): Promise<boolean>;
}

import {FCP_EXPORT_NATIVE_GLOBAL} from '../../../packages/contracts/src/fcp-export-native.ts';
import type {
  FcpExportNativeBridge,
  FcpExportNativeChosenDestination,
} from '../../../packages/contracts/src/fcp-export-native.ts';

const callable = (value: unknown, key: string): boolean =>
  typeof (value as Record<string, unknown>)[key] === 'function';

/** Reads the desktop-only `window.__mioonFcpExport` bridge. Returns `null` in
 * browser sessions or when the bridge is missing/malformed so the FCP export
 * menu entries stay hidden outside the desktop app. */
export function readFcpExportBridge(
  source: unknown = typeof window === 'undefined' ? undefined : window,
): FcpExportNativeBridge | null {
  const bridge = source && typeof source === 'object'
    ? (source as Record<string, unknown>)[FCP_EXPORT_NATIVE_GLOBAL]
    : undefined;
  if (
    !bridge
    || typeof bridge !== 'object'
    || !['chooseDestination', 'reveal', 'openInFinalCut', 'finalCutInstalled'].every(key => callable(bridge, key))
  ) {
    return null;
  }
  return bridge as FcpExportNativeBridge;
}

export function isFcpExportChosenDestination(value: unknown): value is FcpExportNativeChosenDestination {
  return Boolean(value)
    && typeof value === 'object'
    && typeof (value as FcpExportNativeChosenDestination).token === 'string'
    && (value as FcpExportNativeChosenDestination).token.length > 0
    && typeof (value as FcpExportNativeChosenDestination).displayPath === 'string'
    && (value as FcpExportNativeChosenDestination).displayPath.length > 0;
}

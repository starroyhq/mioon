import {z} from 'zod';

/** Desktop-only preload bridge contract for Final Cut Pro export.
 *
 * Exposed on `window.__mioonFcpExport` in the Electron desktop app only.
 * Browser sessions do not expose this bridge and hide the FCP export entry.
 * Failures throw a plain `{code, status}` object because `contextBridge`
 * strips custom properties from `Error` instances.
 */
export const FCP_EXPORT_NATIVE_GLOBAL = '__mioonFcpExport' as const;
export const FCP_EXPORT_NATIVE_CHANNEL = 'mioon:fcp-export' as const;

export const fcpExportNativeIdentitySchema = z.object({
  projectId: z.string().min(1),
  exportId: z.string().min(1),
}).strict();
export type FcpExportNativeIdentity = z.infer<typeof fcpExportNativeIdentitySchema>;

export const fcpExportNativeChosenDestinationSchema = z.object({
  token: z.string().min(1),
  displayPath: z.string().min(1),
}).strict();
export type FcpExportNativeChosenDestination = z.infer<typeof fcpExportNativeChosenDestinationSchema>;

export const fcpExportNativeErrorSchema = z.object({
  code: z.string().min(1),
  status: z.number().int().optional(),
}).strict();
export type FcpExportNativeError = z.infer<typeof fcpExportNativeErrorSchema>;

export interface FcpExportNativeBridge {
  /** Opens the system folder picker; returns `null` when cancelled. */
  chooseDestination(): Promise<{token: string; displayPath: string} | null>;
  /** Reveals the exported `.fcpxmld` bundle in Finder. */
  reveal(identity: {projectId: string; exportId: string}): Promise<boolean>;
  /** Opens the exported `.fcpxmld` bundle in Final Cut Pro. */
  openInFinalCut(identity: {projectId: string; exportId: string}): Promise<boolean>;
  /** Checks whether Final Cut Pro is installed (by macOS bundle id). */
  finalCutInstalled(): Promise<boolean>;
}

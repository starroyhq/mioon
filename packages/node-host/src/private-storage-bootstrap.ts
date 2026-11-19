import path from 'node:path';
import {createRequire} from 'node:module';
import {PrivateStorageError,registerWindowsPrivateStorageBackend} from '@mioon/contracts/private-storage';
import {createWindowsPrivateStorageBackend} from './windows-private-storage.ts';
import type {WindowsStorageNative} from './windows-private-storage.ts';
let initialized=false;
/** Explicit standalone Node entry-point composition. Clients initialize file
 * protection only; no credential-store reads. Electron uses the desktop entry. */
export async function initializeNodePrivateStorage():Promise<void> {
  if(process.platform!=='win32'||initialized)return;
  if(process.versions.electron)throw new PrivateStorageError('WINDOWS_ACL_UNIMPLEMENTED','The headless Windows storage helper is not enabled in Electron.','STORAGE_PRIVACY_UNAVAILABLE');
  let native:WindowsStorageNative;
  try {native=createRequire(import.meta.url)('../build/Release/mioon_private_storage.node') as WindowsStorageNative;}
  catch {throw new PrivateStorageError('WINDOWS_ACL_UNIMPLEMENTED','Build the complete Windows private storage helper with the supported Node and Windows SDK before using this entry point.','STORAGE_PRIVACY_UNAVAILABLE');}
  registerWindowsPrivateStorageBackend(createWindowsPrivateStorageBackend(native));initialized=true;
}
/** Explicit Electron composition for the desktop main process and its backend
 * utilityProcess. The host names the exact helper it ships; nothing is searched
 * for. The same Node-API binary serves Node and Electron. A missing, relative
 * or incompatible helper fails closed before any storage is touched. */
export function initializeDesktopPrivateStorage(helperFile:string):void {
  if(process.platform!=='win32'||initialized)return;
  if(!process.versions.electron||typeof helperFile!=='string'||!path.isAbsolute(helperFile)||path.extname(helperFile)!=='.node')
    throw new PrivateStorageError('WINDOWS_HELPER_UNAVAILABLE','The desktop Windows storage helper must be an absolute path inside Electron.','STORAGE_PRIVACY_UNAVAILABLE');
  let native:WindowsStorageNative;
  try {native=createRequire(import.meta.url)(helperFile) as WindowsStorageNative;}
  catch {throw new PrivateStorageError('WINDOWS_HELPER_UNAVAILABLE','The Windows private storage helper shipped with this app is missing or incompatible.','STORAGE_PRIVACY_UNAVAILABLE');}
  registerWindowsPrivateStorageBackend(createWindowsPrivateStorageBackend(native));initialized=true;
}

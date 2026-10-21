import {createRequire} from 'node:module';
import {PrivateStorageError,registerWindowsPrivateStorageBackend} from '@mioon/contracts/private-storage';
import {createWindowsPrivateStorageBackend} from './windows-private-storage.ts';
import type {WindowsStorageNative} from './windows-private-storage.ts';
let initialized=false;
/** Explicit standalone Node entry-point composition, never imported by desktop
 * assembly. Clients initialize file protection only; no credential-store reads. */
export async function initializeNodePrivateStorage():Promise<void> {
  if(process.platform!=='win32'||initialized)return;
  if(process.versions.electron)throw new PrivateStorageError('WINDOWS_ACL_UNIMPLEMENTED','The headless Windows storage helper is not enabled in Electron.','STORAGE_PRIVACY_UNAVAILABLE');
  let native:WindowsStorageNative;
  try {native=createRequire(import.meta.url)('../build/Release/mioon_private_storage.node') as WindowsStorageNative;}
  catch {throw new PrivateStorageError('WINDOWS_ACL_UNIMPLEMENTED','Build the complete Windows private storage helper with the supported Node and Windows SDK before using this entry point.','STORAGE_PRIVACY_UNAVAILABLE');}
  registerWindowsPrivateStorageBackend(createWindowsPrivateStorageBackend(native));initialized=true;
}

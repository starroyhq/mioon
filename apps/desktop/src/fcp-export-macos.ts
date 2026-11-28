import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);
const appIds = ['com.apple.FinalCut', 'com.apple.FinalCutApp'] as const;
const options = {timeout: 8_000, maxBuffer: 16 * 1024};
// AppKit asks Launch Services for the bundle ID and never opens an app.
const installedScript = `ObjC.import("AppKit"); ${JSON.stringify(appIds)}.find(id =>
  !$.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(id).isNil()) || "";`;

async function installedBundleId(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return;
  const {stdout} = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', installedScript], options);
  return appIds.find(id => id === stdout.trim());
}

export async function finalCutInstalled(): Promise<boolean> {
  return (await installedBundleId()) !== undefined;
}

export async function openInFinalCut(bundle: string, beforeOpen: () => boolean): Promise<boolean> {
  try {
    const appId = await installedBundleId();
    if (!appId || !beforeOpen()) return false;
    await run('/usr/bin/open', ['-b', appId, bundle], options);
    return true;
  } catch {return false;}
}

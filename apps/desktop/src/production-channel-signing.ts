import {execFileSync} from 'node:child_process';
import type {ExecFileSyncOptions} from 'node:child_process';
import {identityForChannel} from '../identity.ts';

// Apple Developer ID Application chain, restricted to the signed identifier and team.
const productionRequirement = [
  `identifier "${identityForChannel('production').appId}"`,
  'anchor apple generic',
  'certificate 1[field.1.2.840.113635.100.6.2.6] exists',
  'certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
  'certificate leaf[subject.OU] = "A7C3K354YP"',
].join(' and ');

type RunSignatureCheck = (command: string, args: readonly string[], options: ExecFileSyncOptions) => void;

/** Verify the running main process and signed Info.plist by PID. Electron uses
 * the signed ASAR hash from Info.plist, so startup need not rescan resources. */
export function verifyOfficialMacDesktopProcess(run: RunSignatureCheck = execFileSync): boolean {
  try {
    run('/usr/bin/codesign', ['--verify', '--ignore-resources', `-R=${productionRequirement}`, String(process.pid)],
      {env: {}, stdio: 'ignore', timeout: 2000, killSignal: 'SIGKILL'});
    return true;
  } catch {
    return false;
  }
}

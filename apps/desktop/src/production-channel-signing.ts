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
type SignatureResult = 'verified' | 'rejected' | 'timeout' | 'spawn' | `exit:${number}`;

/** Verify the running main process and signed Info.plist by PID. Electron uses
 * the signed ASAR hash from Info.plist, so startup need not rescan resources. */
export function verifyOfficialMacDesktopProcess(run: RunSignatureCheck = execFileSync): SignatureResult {
  try {
    run('/usr/bin/codesign', ['--verify', '--ignore-resources', `-R=${productionRequirement}`, String(process.pid)],
      {env: {}, stdio: 'ignore', timeout: 10_000, killSignal: 'SIGKILL'});
    return 'verified';
  } catch (error) {
    const failure = error as {code?: unknown; status?: unknown} | null | undefined;
    if (failure?.code === 'ETIMEDOUT') return 'timeout';
    const status = failure?.status;
    // codesign(1) uses 1 for verification failure and 3 for a failed requirement.
    if (status === 1 || status === 3) return 'rejected';
    if (typeof status === 'number' && Number.isInteger(status) && status >= 0 && status <= 255) return `exit:${status}`;
    return 'spawn';
  }
}

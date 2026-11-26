import {lstat} from 'node:fs/promises';
import type {DesktopIdentity} from './identity.ts';

export const MAC_CLI_LAUNCHER_MAX_BYTES = 300_000;
export const MAC_CLI_LAUNCHER_ARCHITECTURES = ['arm64', 'x86_64'] as const;
export const MAC_CLI_LAUNCHER_STAGE = 'cli-launcher';
export const MAC_CLI_LAUNCHER_HELPERS = 'Helpers';

export function macCliLauncherBundleEntry(identity: DesktopIdentity): string {
  return `Contents/${MAC_CLI_LAUNCHER_HELPERS}/${identity.executableName}`;
}

export function macCliLauncherIdentifier(identity: DesktopIdentity): string {
  return `${identity.appId}.cli-launcher`;
}

export async function verifyMacCliLauncherFile(file: string): Promise<void> {
  const info = await lstat(file);
  if (!info.isFile() || (info.mode & 0o111) !== 0o111 || info.size <= 0 || info.size >= MAC_CLI_LAUNCHER_MAX_BYTES) {
    throw new Error('The macOS CLI launcher must be a regular executable under 300 KB.');
  }
}

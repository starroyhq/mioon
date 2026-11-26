import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {identityForChannel, type DesktopChannel} from '../identity.ts';
import {macCliLauncherIdentifier} from '../cli-launcher-binary.ts';

export interface CliInstallPlatform {
  verifyLauncher(file: string): Promise<void>;
  copyLauncher(source: string, destination: string, appPath: string): Promise<void>;
  assessCopy(file: string): Promise<'accepted' | 'rejected'>;
}

const run = promisify(execFile);
const options = {env: {LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin'}, timeout: 15_000, maxBuffer: 64 * 1024};
const quarantine = 'com.apple.quarantine';

async function quarantineHex(file: string): Promise<string | undefined> {
  const {stdout} = await run('/usr/bin/xattr', [file], options);
  if (!stdout.split(/\r?\n/u).includes(quarantine)) return undefined;
  const value = await run('/usr/bin/xattr', ['-px', quarantine, file], options);
  const hex = value.stdout.replace(/\s/gu, '');
  if (!/^(?:[a-f0-9]{2})+$/iu.test(hex)) throw new Error('Invalid quarantine attribute');
  return hex.toUpperCase();
}

export function createMacCliInstallPlatform(channel: DesktopChannel): CliInstallPlatform {
  const helperId = macCliLauncherIdentifier(identityForChannel(channel));
  const requirement = [`identifier "${helperId}"`, ...(channel === 'production' ? [
    'anchor apple generic',
    'certificate 1[field.1.2.840.113635.100.6.2.6] exists',
    'certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
    'certificate leaf[subject.OU] = "A7C3K354YP"',
  ] : [])].join(' and ');
  return {
    async verifyLauncher(file) {
      await run('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', `-R=${requirement}`, file], options);
    },
    async copyLauncher(source, destination, appPath) {
      // Finder may mark the bundle root while the nested Mach-O has no xattr.
      // A standalone copy must retain the inherited quarantine in that case.
      const mark = await quarantineHex(source) ?? await quarantineHex(appPath);
      await run('/usr/bin/ditto', ['--extattr', '--qtn', '--noacl', source, destination], options);
      if (mark !== undefined && await quarantineHex(destination) !== mark) {
        await run('/usr/bin/xattr', ['-wx', quarantine, mark, destination], options);
        if (await quarantineHex(destination) !== mark) throw new Error('Could not preserve quarantine');
      }
    },
    async assessCopy(file) {
      try {
        await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--ignore-cache', '--no-cache', '--raw', file], options);
        return 'accepted';
      } catch (error) {
        const result = error as {code?: unknown; stdout?: unknown; stderr?: unknown};
        const verdict = [result.stdout, result.stderr].filter(value => typeof value === 'string').join('\n');
        if (result.code === 3 && /<key>assessment:verdict<\/key>\s*<false\s*\/>/u.test(verdict)) return 'rejected';
        throw error;
      }
    },
  };
}

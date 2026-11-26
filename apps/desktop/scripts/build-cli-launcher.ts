import {execFile} from 'node:child_process';
import {chmod, mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {MAC_CLI_LAUNCHER_ARCHITECTURES, MAC_CLI_LAUNCHER_STAGE, macCliLauncherIdentifier, verifyMacCliLauncherFile} from '../cli-launcher-binary.ts';
import type {DesktopIdentity} from '../identity.ts';

const exec = promisify(execFile);

export async function buildMacCliLauncher(input: {desktop: string; output: string; appVersion: string; identity: DesktopIdentity}): Promise<void> {
  const {desktop, output, appVersion, identity} = input;
  const directory = path.join(output, MAC_CLI_LAUNCHER_STAGE);
  await mkdir(directory);
  const binary = path.join(directory, identity.executableName);
  const scratch = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-cli-launcher-'));
  try {
    const plist = path.join(scratch, 'Info.plist');
    // codesign uses the embedded identifier for this standalone Mach-O.
    await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n` +
      `<key>CFBundleIdentifier</key><string>${macCliLauncherIdentifier(identity)}</string>\n</dict></plist>\n`);
    const values = {VERSION: appVersion, CHANNEL: identity.channel, APP_ID: identity.appId, COMMAND: identity.executableName};
    const definitions = Object.entries(values).map(([name, value]) => `-DMIOON_LAUNCHER_${name}=${JSON.stringify(value)}`);
    const architectures = MAC_CLI_LAUNCHER_ARCHITECTURES.flatMap(architecture => ['-arch', architecture]);
    await exec('/usr/bin/xcrun', ['clang', ...architectures, '-mmacosx-version-min=11.0', '-Os', '-fobjc-arc',
      '-framework', 'Foundation', '-Wl,-dead_strip', '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist',
      '-Xlinker', plist, ...definitions, path.join(desktop, 'native/cli-launcher/main.m'), '-o', binary]);
    await chmod(binary, 0o755);
    const {stdout} = await exec('/usr/bin/xcrun', ['lipo', '-archs', binary], {encoding: 'utf8'});
    if (stdout.trim().split(/\s+/).sort().join(' ') !== MAC_CLI_LAUNCHER_ARCHITECTURES.join(' ')) {
      throw new Error('The macOS CLI launcher must contain both arm64 and x86_64.');
    }
    await verifyMacCliLauncherFile(binary);
  } finally {
    await rm(scratch, {recursive: true, force: true});
  }
}

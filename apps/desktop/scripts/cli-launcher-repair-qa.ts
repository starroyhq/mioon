import {mkdir, mkdtemp, readlink, realpath, rename, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {command, fail, safeFailure} from '../../../.github/scripts/media-environment.ts';
import {macCliLauncherBundleEntry, macCliLauncherIdentifier, verifyMacCliLauncherFile} from '../cli-launcher-binary.ts';
import {identityForChannel} from '../identity.ts';
import {appVersionPattern} from '../src/cli-install-storage.ts';
import {createCliInstaller} from '../src/cli-install.ts';

const identity = identityForChannel('development');

function requireCheck(condition: unknown, code: string): asserts condition {
  if (!condition) fail(code);
}

async function runRepairQa(args: readonly string[]): Promise<void> {
  requireCheck(process.platform === 'darwin', 'REPAIR_QA_REQUIRES_MACOS');
  requireCheck(args.length === 1, 'REPAIR_QA_REQUIRES_DEVELOPMENT_APP_PATH');
  const source = await realpath(args[0]!);
  requireCheck(source.endsWith('.app'), 'REPAIR_QA_REQUIRES_APP_BUNDLE');
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-cli-repair-'));
  try {
    const homeDir = path.join(root, 'home'), userData = path.join(homeDir, 'profile');
    await mkdir(homeDir, {mode: 0o700});
    const env = {HOME: homeDir, CFFIXED_USER_HOME: homeDir, TMPDIR: root, LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      MIOON_DESKTOP_USER_DATA: userData};
    const plist = path.join(source, 'Contents', 'Info.plist');
    const field = async (key: string) => (await command('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist],
      'REPAIR_QA_INVALID_APP_METADATA', {env})).trim();
    requireCheck(await field('CFBundleIdentifier') === identity.appId && await field('CFBundleExecutable') === identity.executableName,
      'REPAIR_QA_REQUIRES_DEVELOPMENT_CHANNEL');
    const appVersion = await field('CFBundleShortVersionString');
    requireCheck(appVersionPattern.test(appVersion), 'REPAIR_QA_INVALID_APP_VERSION');

    const original = path.join(root, 'Mioon Dev original.app'), moved = path.join(root, 'Mioon Dev moved.app');
    const incomplete = path.join(root, 'Mioon Dev incomplete.app');
    await command('/usr/bin/ditto', ['--extattr', '--qtn', '--noacl', source, original], 'REPAIR_QA_COPY_FAILED', {env, timeout: 120_000});
    const launcherEntry = macCliLauncherBundleEntry(identity);
    const originalLauncher = path.join(original, launcherEntry), movedLauncher = path.join(moved, launcherEntry);
    const incompleteLauncher = path.join(incomplete, launcherEntry);
    requireCheck(await realpath(originalLauncher) === originalLauncher, 'REPAIR_QA_LAUNCHER_ESCAPED_BUNDLE');
    await verifyMacCliLauncherFile(originalLauncher);
    await command('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', macCliLauncherIdentifier(identity), originalLauncher],
      'REPAIR_QA_LAUNCHER_SIGN_FAILED', {env});
    const installerAt = (appPath: string) => createCliInstaller({homeDir, userData, appPath, appVersion, channel: identity.channel, shell: null});
    const installer = installerAt(original);
    const installed = await installer.install();
    requireCheck(installed.cli.state === 'installed' && installed.managed, 'REPAIR_QA_INSTALL_FAILED');
    // The real ad hoc Gatekeeper rejection exercises the bundle-link fallback.
    // A versioned copy remains usable after this same-version move.
    requireCheck(installed.installationKind === 'bundle-link', 'REPAIR_QA_EXPECTED_NATIVE_BUNDLE_LINK');
    const installedCommand = path.join(homeDir, '.local', 'bin', identity.executableName);
    requireCheck(installed.cli.commandPath === installedCommand && await readlink(installedCommand) === originalLauncher,
      'REPAIR_QA_INITIAL_LINK_INCORRECT');

    await rename(original, moved);
    const movedInstaller = installerAt(moved);
    const stale = await movedInstaller.status();
    requireCheck(stale.cli.state === 'needs-repair' && stale.cli.reason === 'CLI_TARGET_MISSING', 'REPAIR_QA_MOVE_NOT_DETECTED');
    const repairedMove = await movedInstaller.autoRepair();
    requireCheck(repairedMove.cli.state === 'installed' && repairedMove.managed && repairedMove.installationKind === 'bundle-link'
      && await readlink(installedCommand) === movedLauncher, 'REPAIR_QA_MOVED_BUNDLE_NOT_REPAIRED');

    // Remove the launcher temporarily to reproduce a partial application copy.
    await rename(moved, incomplete);
    const parkedLauncher = path.join(root, 'launcher-held-for-test');
    await rename(incompleteLauncher, parkedLauncher);
    const failed = await installerAt(incomplete).autoRepair();
    requireCheck(failed.cli.state === 'needs-repair' && failed.cli.reason === 'CLI_AUTO_UPDATE_FAILED', 'REPAIR_QA_FAILURE_NOT_REPORTED');
    const reopened = await installerAt(incomplete).status();
    requireCheck(reopened.cli.state === 'needs-repair' && reopened.cli.reason === failed.cli.reason
      && await readlink(installedCommand) === movedLauncher, 'REPAIR_QA_FAILURE_NOT_PRESERVED');

    await rename(parkedLauncher, incompleteLauncher);
    const repaired = await installerAt(incomplete).autoRepair();
    requireCheck(repaired.cli.state === 'installed' && repaired.managed && repaired.installationKind === 'bundle-link'
      && repaired.cli.version === appVersion && await readlink(installedCommand) === incompleteLauncher, 'REPAIR_QA_AUTO_REPAIR_FAILED');
    const versionOutput = JSON.parse(await command(installedCommand, ['--version'], 'REPAIR_QA_REPAIRED_LAUNCHER_FAILED', {env})) as
      {ok?: unknown; data?: {name?: unknown; version?: unknown}} | null;
    requireCheck(versionOutput?.ok === true && versionOutput.data?.name === 'mioon' && versionOutput.data?.version === appVersion,
      'REPAIR_QA_REPAIRED_VERSION_INCORRECT');
    console.log(JSON.stringify({ok: true, channel: identity.channel, arch: process.arch, appVersion,
      installationKind: installed.installationKind, beforeMove: installed.cli.state,
      afterMove: {state: stale.cli.state, reason: stale.cli.reason},
      automaticMoveRepair: {state: repairedMove.cli.state, linkPointsToMovedApp: true},
      blockedRepair: {state: failed.cli.state, reason: failed.cli.reason, persistedOnRead: true, previousLinkPreserved: true},
      afterAutomaticRetry: {state: repaired.cli.state, linkPointsToMovedApp: true, launcherVersionVerified: true}}));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

try {await runRepairQa(process.argv.slice(2));}
catch (error) {console.error(JSON.stringify({ok: false, error: safeFailure(error)})); process.exitCode = 1;}

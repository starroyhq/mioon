import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {type TestContext} from 'node:test';
import {createCliInstaller, type CliInstallerOptions} from '../apps/desktop/src/cli-install.ts';
import {createMacCliInstallPlatform, type CliInstallPlatform} from '../apps/desktop/src/cli-install-mac.ts';

const packageBytes = 'synthetic development launcher';
const nativeMock = (overrides: Partial<CliInstallPlatform> = {}): CliInstallPlatform => ({
  async verifyLauncher() {},
  async copyLauncher(source, destination) {await copyFile(source, destination);},
  async assessCopy() {return 'accepted';},
  ...overrides,
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-cli-install-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const homeDir = path.join(root, 'home');
  const userData = path.join(homeDir, 'application-data');
  const appPath = path.join(root, 'Mioon Dev.app');
  const helper = path.join(appPath, 'Contents', 'Helpers', 'mioon-dev');
  const bin = path.join(homeDir, '.local', 'bin');
  const command = path.join(bin, 'mioon-dev');
  const manifest = path.join(userData, 'cli-install.json');
  await mkdir(path.dirname(helper), {recursive: true});
  await mkdir(homeDir);
  await writeFile(helper, packageBytes, {mode: 0o700});
  const options: CliInstallerOptions = {homeDir, userData, appPath, appVersion: '0.4.0', channel: 'development',
    shell: '/bin/zsh', platform: nativeMock(), pathLookup: async () => null};
  return {root, homeDir, appPath, helper, userData, bin, command, manifest, options};
}

test('installs a private versioned copy and uninstalls only owned artifacts', async t => {
  const f = await fixture(t);
  const installer = createCliInstaller(f.options);
  const before = await installer.status();
  assert.deepEqual(before.cli, {state: 'not-installed', onPath: 'unknown', displayPath: '~/.local/bin/mioon-dev'});
  assert.match(before.mcpCommands.claudeCode, /^claude mcp add -s user mioon-dev -- /u);
  await assert.rejects(access(f.userData), {code: 'ENOENT'});
  const result = await installer.install();
  assert.deepEqual(result.cli, {state: 'installed', commandPath: f.command, displayPath: '~/.local/bin/mioon-dev', version: '0.4.0',
    onPath: 'no', pathHint: {line: 'export PATH="$HOME/.local/bin:$PATH"', rcFile: '~/.zshrc'}});
  assert.equal(result.installationKind, 'versioned-copy');
  assert.equal(result.managed, true);
  assert.equal(result.mcpCommands.codex, `codex mcp add mioon-dev -- "${f.command}" mcp`);
  const copy = await readlink(f.command);
  assert.equal(path.relative(f.userData, copy).split(path.sep).slice(0, 2).join('/'), 'cli/0.4.0');
  assert.equal(await readFile(copy, 'utf8'), packageBytes);
  assert.equal((await lstat(copy)).mode & 0o777, 0o700);
  assert.equal((await lstat(f.manifest)).mode & 0o777, 0o600);
  const unrelated = path.join(f.bin, 'personal');
  await writeFile(unrelated, 'keep');
  assert.equal((await installer.uninstall()).cli.state, 'not-installed');
  for (const file of [f.command, copy, f.manifest]) await assert.rejects(lstat(file), {code: 'ENOENT'});
  assert.equal(await readFile(unrelated, 'utf8'), 'keep');
});

test('refuses an existing command, supports a selected directory, and consumes its ticket once', async t => {
  const f = await fixture(t);
  await mkdir(f.bin, {recursive: true});
  await writeFile(f.command, 'other program');
  const selected = path.join(f.homeDir, "selected ('new')");
  await mkdir(selected);
  const installer = createCliInstaller({...f.options, shell: '/bin/bash'});
  const rejected = await installer.install();
  assert.equal(rejected.cli.state, 'install-failed');
  assert.equal(rejected.cli.reason, 'CLI_INSTALL_TARGET_EXISTS');
  assert.deepEqual(rejected.cli.reasonValues, {directory: '~/.local/bin'});
  assert.equal((await createCliInstaller(f.options).status()).cli.reason, 'CLI_INSTALL_TARGET_EXISTS');
  assert.equal(await readFile(f.command, 'utf8'), 'other program');
  const ticket = installer.issueDirectoryTicket(selected);
  const installed = await installer.install(ticket);
  assert.equal(installed.cli.state, 'installed');
  assert.equal(installed.cli.commandPath, path.join(selected, 'mioon-dev'));
  assert.equal(installed.cli.pathHint?.rcFile, '~/.bash_profile');
  assert.match(installed.cli.pathHint?.line ?? '', /'"'"'/u);
  assert.equal((await installer.install(ticket)).cli.reason, 'CLI_INSTALL_NOT_WRITABLE');
  await installer.uninstall();
  assert.equal(await readFile(f.command, 'utf8'), 'other program');
});

test('tickets expire and a re-created selected directory cannot redeem an old ticket', async t => {
  const f = await fixture(t);
  const selected = path.join(f.homeDir, 'chosen');
  await mkdir(selected);
  let now = 1;
  const installer = createCliInstaller({...f.options, now: () => now});
  const expired = installer.issueDirectoryTicket(selected);
  now += 60_000;
  assert.equal((await installer.install(expired)).cli.reason, 'CLI_INSTALL_NOT_WRITABLE');
  const moved = installer.issueDirectoryTicket(selected);
  await rename(selected, selected + '-old');
  await mkdir(selected);
  assert.equal((await installer.install(moved)).cli.reason, 'CLI_INSTALL_NOT_WRITABLE');
  await assert.rejects(lstat(path.join(selected, 'mioon-dev')), {code: 'ENOENT'});
  await assert.rejects(lstat(f.command), {code: 'ENOENT'});
  await symlink(selected, selected + '-alias');
  assert.throws(() => installer.issueDirectoryTicket(selected + '-alias'), /CLI_INSTALL_NOT_WRITABLE/u);
});

test('selected directory without write permission returns a specific status', {skip: process.getuid?.() === 0}, async t => {
  const f = await fixture(t);
  const selected = path.join(f.homeDir, 'no-write');
  await mkdir(selected, {mode: 0o500});
  const installer = createCliInstaller(f.options);
  try {
    const result = await installer.install(installer.issueDirectoryTicket(selected));
    assert.equal(result.cli.reason, 'CLI_INSTALL_NOT_WRITABLE');
    assert.deepEqual(result.cli.reasonValues, {directory: '~/no-write'});
    await assert.rejects(lstat(path.join(selected, 'mioon-dev')), {code: 'ENOENT'});
  } finally {await chmod(selected, 0o700);}
});

test('reports removed commands and targets and repairs through the persisted installation', async t => {
  const f = await fixture(t);
  const installer = createCliInstaller(f.options);
  assert.equal((await installer.install()).cli.state, 'installed');
  await unlink(f.command);
  assert.equal((await installer.status()).cli.reason, 'CLI_FILE_MISSING');
  assert.equal((await installer.autoRepair()).cli.reason, 'CLI_FILE_MISSING');
  assert.equal((await installer.repair()).cli.state, 'installed');
  const copy = await readlink(f.command);
  await unlink(copy);
  assert.equal((await installer.status()).cli.reason, 'CLI_TARGET_MISSING');
  const restarted = createCliInstaller(f.options);
  assert.equal((await restarted.repair()).cli.state, 'installed');
  assert.notEqual(await readlink(f.command), copy);
});

test('replaces the managed link on upgrade and persists failed automatic repair', async t => {
  const f = await fixture(t);
  await createCliInstaller(f.options).install();
  const old = await readlink(f.command);
  const newer = {...f.options, appVersion: '0.4.1'};
  const failing = createCliInstaller({...newer, platform: nativeMock({
    async verifyLauncher() {throw new Error('signature denied');},
  })});
  const stale = await failing.status();
  assert.equal(stale.cli.reason, 'CLI_VERSION_MISMATCH');
  assert.deepEqual(stale.cli.reasonValues, {installedVersion: '0.4.0'});
  const failed = await failing.autoRepair();
  assert.equal(failed.cli.state, 'needs-repair');
  assert.equal(failed.cli.reason, 'CLI_AUTO_UPDATE_FAILED');
  assert.equal(await readlink(f.command), old);
  const restarted = createCliInstaller(newer);
  assert.equal((await restarted.status()).cli.reason, 'CLI_AUTO_UPDATE_FAILED');
  assert.equal((await restarted.autoRepair()).cli.version, '0.4.1');
  const updated = await readlink(f.command);
  assert.match(updated, /[/]cli[/]0\.4\.1[/]/u);
  await assert.rejects(lstat(old), {code: 'ENOENT'});
});

test('falls back only on a rejected assessment and repairs the link after the bundle moves', async t => {
  const f = await fixture(t);
  let attempts = 0;
  const denied = nativeMock({async assessCopy() {attempts++; return 'rejected';}});
  const installer = createCliInstaller({...f.options, platform: denied});
  const result = await installer.install();
  assert.equal(result.cli.state, 'installed');
  assert.equal(result.installationKind, 'bundle-link');
  assert.equal(await readlink(f.command), f.helper);
  const movedPath = path.join(f.root, 'Mioon Dev moved.app');
  await rename(f.appPath, movedPath);
  const moved = createCliInstaller({...f.options, appPath: movedPath, platform: denied});
  assert.equal((await moved.status()).cli.reason, 'CLI_TARGET_MISSING');
  assert.equal((await moved.autoRepair()).cli.state, 'installed');
  assert.equal(await readlink(f.command), path.join(movedPath, 'Contents', 'Helpers', 'mioon-dev'));
  assert.equal(attempts, 2);
  await moved.uninstall();
  assert.equal(await readFile(path.join(movedPath, 'Contents', 'Helpers', 'mioon-dev'), 'utf8'), packageBytes);
});

test('assessment execution errors and translocated apps leave no installed command', async t => {
  const f = await fixture(t);
  const broken = createCliInstaller({...f.options, platform: nativeMock({
    async assessCopy() {throw Object.assign(new Error('unrecognized assessment'), {code: 3});},
  })});
  assert.equal((await broken.install()).cli.reason, 'CLI_INSTALL_FAILED');
  await assert.rejects(lstat(f.command), {code: 'ENOENT'});
  const translocation = path.join(f.root, 'AppTranslocation', 'opaque', 'd');
  await mkdir(translocation, {recursive: true});
  const appPath = path.join(translocation, 'Mioon Dev.app');
  await rename(f.appPath, appPath);
  let verified = false;
  const moved = createCliInstaller({...f.options, appPath, platform: nativeMock({async verifyLauncher() {verified = true;}})});
  assert.equal((await moved.install()).cli.reason, 'CLI_INSTALL_FAILED');
  assert.equal(verified, false);
});

test('an existing foreign entry and one created during preparation remain untouched', async t => {
  const f = await fixture(t);
  const interfered = createCliInstaller({...f.options, platform: nativeMock({
    async copyLauncher(source, destination) {
      await copyFile(source, destination);
      await writeFile(f.command, 'appeared during copy');
    },
  })});
  assert.equal((await interfered.install()).cli.reason, 'CLI_INSTALL_TARGET_EXISTS');
  assert.equal(await readFile(f.command, 'utf8'), 'appeared during copy');
  await unlink(f.command);
  const installer = createCliInstaller(f.options);
  await installer.install();
  const target = await readlink(f.command);
  const replacement = path.join(f.bin, 'replacement');
  await symlink(target, replacement);
  await rename(replacement, f.command);
  assert.equal((await installer.status()).cli.reason, 'CLI_INSTALL_TARGET_EXISTS');
  assert.equal((await installer.repair()).cli.reason, 'CLI_INSTALL_TARGET_EXISTS');
  assert.equal((await installer.uninstall()).cli.state, 'not-installed');
  assert.equal(await readlink(f.command), target);
});

test('an interrupted upgrade restores a vacant old link and preserves an unproven replacement', async t => {
  const f = await fixture(t);
  const platform = nativeMock({async assessCopy() {return 'rejected';}});
  const options = {...f.options, platform};
  await createCliInstaller(options).install();
  const appPath = path.join(f.root, 'Updated Mioon Dev.app');
  const target = path.join(appPath, 'Contents', 'Helpers', 'mioon-dev');
  await mkdir(path.dirname(target), {recursive: true});
  await writeFile(target, 'updated launcher', {mode: 0o700});
  async function prepareInterruptedUpgrade() {
    const previous = JSON.parse(await readFile(f.manifest, 'utf8'));
    const {commandId: _previousCommand, ...identity} = previous.current;
    const next = {...identity, target, installedVersion: '0.4.1'};
    await writeFile(f.manifest, JSON.stringify({...previous, pending: {next, restorePrevious: true}}));
    await unlink(f.command);
  }
  await prepareInterruptedUpgrade();
  assert.equal((await createCliInstaller(options).autoRepair()).cli.state, 'installed');
  assert.equal(await readlink(f.command), f.helper);
  await prepareInterruptedUpgrade();
  await symlink(target, f.command);
  const restarted = createCliInstaller({...options, appPath, appVersion: '0.4.1'});
  assert.equal((await restarted.status()).cli.reason, 'CLI_INSTALL_TARGET_EXISTS');
  assert.equal((await restarted.repair()).cli.reason, 'CLI_INSTALL_TARGET_EXISTS');
  assert.equal((await restarted.uninstall()).cli.state, 'not-installed');
  assert.equal(await readlink(f.command), target);
});

test('queries the configured login shell with the temporary HOME and distinguishes shadowing from unknown', async t => {
  const f = await fixture(t);
  const shell = path.join(f.homeDir, 'zsh');
  await writeFile(shell, '#!/bin/sh\n[ "$1" = -lic ] || exit 2\nprintf "startup output\\nmioon-cli-path-probe:%s/.local/bin/mioon-dev\\n" "$HOME"\n', {mode: 0o700});
  const installer = createCliInstaller({...f.options, shell, pathLookup: undefined});
  const status = await installer.install();
  assert.equal(status.cli.onPath, 'yes');
  assert.equal(status.cli.pathHint, undefined);
  await writeFile(shell, '#!/bin/sh\nprintf "mioon-cli-path-probe:/other/mioon-dev\\n"\n');
  assert.equal((await installer.status()).cli.onPath, 'no');
  await writeFile(shell, '#!/bin/sh\nexit 2\n');
  assert.equal((await installer.status()).cli.onPath, 'unknown');
  for (const rc of ['.zshrc', '.bash_profile']) await assert.rejects(access(path.join(f.homeDir, rc)), {code: 'ENOENT'});
});

test('macOS copy preserves a bundle quarantine mark when the nested helper has none', {skip: process.platform !== 'darwin'}, async t => {
  const f = await fixture(t);
  const destination = path.join(f.root, 'standalone');
  const attribute = 'com.apple.quarantine';
  const quarantine = '0081;654FD780;MioonTest;';
  execFileSync('/usr/bin/xattr', ['-w', attribute, quarantine, f.appPath]);
  await createMacCliInstallPlatform('development').copyLauncher(f.helper, destination, f.appPath);
  const copied = execFileSync('/usr/bin/xattr', ['-p', attribute, destination], {encoding: 'utf8'}).trim();
  assert.equal(copied, quarantine);
  assert.equal(await readFile(destination, 'utf8'), packageBytes);
});

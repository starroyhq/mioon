import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {userInfo} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {ensurePrivateDirectory, readPrivateFile, removePrivateFile, writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import {identityForChannel, type DesktopChannel} from '../identity.ts';
import {macCliLauncherBundleEntry, MAC_CLI_LAUNCHER_MAX_BYTES} from '../cli-launcher-binary.ts';
import {createMacCliInstallPlatform, type CliInstallPlatform} from './cli-install-mac.ts';
import {
  appVersionPattern, copyMatches, createLink, discardUnpublishedCopy, errorCode, fileIdentity, finalizeCopy, inodeMatches,
  installDirectory, isCopyLocation, isIdentity, lstat, newCopyLocation, ownedLink, pathIsAbsolute, pointsTo, removeCopy,
  removeLink, type CopyProof, type FileIdentity,
} from './cli-install-storage.ts';

export type CliState = 'not-installed' | 'installed' | 'needs-repair' | 'install-failed';
export type CliReason = 'CLI_FILE_MISSING' | 'CLI_TARGET_MISSING' | 'CLI_VERSION_MISMATCH' | 'CLI_AUTO_UPDATE_FAILED'
  | 'CLI_INSTALL_TARGET_EXISTS' | 'CLI_INSTALL_NOT_WRITABLE' | 'CLI_INSTALL_FAILED';
type CommandName = 'mioon' | 'mioon-dev';
type PathPresence = 'yes' | 'no' | 'unknown';
type InstallReason = Extract<CliReason, `CLI_INSTALL_${string}`>;

export interface CliInstallStatus {
  commandName: CommandName;
  appVersion: string;
  cli: {
    state: CliState;
    version?: string;
    commandPath?: string;
    displayPath: string;
    onPath: PathPresence;
    pathHint?: {line: string; rcFile: string};
    reason?: CliReason;
    reasonValues?: {installedVersion?: string; directory?: string};
  };
  mcpCommands: {claudeCode: string; codex: string};
  managed: boolean;
  installationKind?: 'versioned-copy' | 'bundle-link';
}

export interface CliInstallerOptions {
  homeDir: string;
  userData: string;
  appPath: string;
  appVersion: string;
  channel: DesktopChannel;
  /** Defaults to the account's login shell when SHELL is unavailable. */
  shell?: string | null;
  /** Native boundary for tests. Production uses macOS tools and requires Darwin. */
  platform?: CliInstallPlatform;
  pathLookup?: (shell: string, command: CommandName, homeDir: string) => Promise<string | null | undefined>;
  now?: () => number;
}

interface Candidate {
  directory: string;
  directoryId: FileIdentity;
  target: string;
  installedVersion: string;
  copy?: CopyProof;
}
interface Installation extends Candidate {commandId: FileIdentity}
interface Pending {next: Candidate; commandId?: FileIdentity; restorePrevious: boolean}
interface Attempt {directory: string; reason: InstallReason | 'CLI_AUTO_UPDATE_FAILED'}
interface Manifest {
  format: 1;
  channel: DesktopChannel;
  current: Installation | null;
  pending?: Pending;
  failure?: Attempt;
}

const run = promisify(execFile);
const maxManifestBytes = 64 * 1024;
const ticketLifetimeMs = 60_000;
const installReasons = new Set<unknown>([
  'CLI_INSTALL_TARGET_EXISTS', 'CLI_INSTALL_NOT_WRITABLE', 'CLI_INSTALL_FAILED', 'CLI_AUTO_UPDATE_FAILED',
]);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const version = (value: unknown): value is string => typeof value === 'string' && appVersionPattern.test(value);
const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const mcpQuote = (value: string): string => /[\\"$`!]/u.test(value) ? shellQuote(value) : '"' + value + '"';

function defaultShell(): string | null {
  try {return process.env.SHELL || userInfo().shell || null;} catch {return null;}
}

async function lookupShellCommand(shell: string, command: CommandName, homeDir: string): Promise<string | null | undefined> {
  const marker = 'mioon-cli-path-probe:';
  try {
    const {stdout} = await run(shell, ['-lic', `printf '\\n${marker}%s\\n' "$(command -v ${command})"`], {
      cwd: homeDir, env: {...process.env, HOME: homeDir, SHELL: shell}, timeout: 2000, maxBuffer: 32 * 1024,
      killSignal: 'SIGKILL',
    });
    const lines = stdout.split(/\r?\n/u).filter(line => line.startsWith(marker));
    if (lines.length !== 1) return undefined;
    return lines[0]!.slice(marker.length) || null;
  } catch {return undefined;}
}

class InstallError extends Error {
  readonly reason: InstallReason;
  constructor(reason: InstallReason) {
    super(reason);
    this.reason = reason;
  }
}

function directoryFailure(error: unknown): never {
  if (errorCode(error) === 'EEXIST') throw new InstallError('CLI_INSTALL_TARGET_EXISTS');
  if (['EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'ENOENT'].includes(String(errorCode(error)))) {
    throw new InstallError('CLI_INSTALL_NOT_WRITABLE');
  }
  throw error;
}

export function createCliInstaller({
  homeDir, userData, appPath, appVersion, channel, shell = defaultShell(),
  platform = process.platform === 'darwin' ? createMacCliInstallPlatform(channel) : undefined,
  pathLookup = lookupShellCommand, now = Date.now,
}: CliInstallerOptions) {
  if (![homeDir, userData, appPath].every(pathIsAbsolute) || !version(appVersion)) {
    throw new TypeError('Invalid CLI installer paths or application version');
  }
  const commandName = channel === 'development' ? 'mioon-dev' : 'mioon';
  const bundleLauncher = path.join(appPath, macCliLauncherBundleEntry(identityForChannel(channel)));
  const defaultDirectory = path.join(homeDir, '.local', 'bin');
  const manifestFile = path.join(userData, 'cli-install.json');
  const manifestOptions = {root: userData, maxBytes: maxManifestBytes};
  const tickets = new Map<string, {directory: string; id: FileIdentity; deadline: number}>();
  const emptyManifest = (): Manifest => ({format: 1, channel, current: null});

  function candidate(value: unknown): value is Candidate {
    if (!record(value) || !pathIsAbsolute(value.directory) || !pathIsAbsolute(value.target) ||
      !isIdentity(value.directoryId) || !version(value.installedVersion)) return false;
    if (value.copy === undefined) return value.target.endsWith(`${path.sep}Contents${path.sep}Helpers${path.sep}${commandName}`);
    return record(value.copy) && isIdentity(value.copy.id) && typeof value.copy.sha256 === 'string'
      && /^[a-f0-9]{64}$/u.test(value.copy.sha256) && isCopyLocation(value.target, userData, value.installedVersion, commandName);
  }

  function readManifest(): Manifest {
    const raw = readPrivateFile(manifestFile, {...manifestOptions, allowMissing: true, encoding: 'utf8'});
    if (raw === null) return emptyManifest();
    const parsed: unknown = JSON.parse(String(raw));
    if (!record(parsed) || parsed.format !== 1 || parsed.channel !== channel
      || (parsed.current !== null && (!record(parsed.current) || !isIdentity(parsed.current.commandId) || !candidate(parsed.current)))
      || (parsed.failure !== undefined && (!record(parsed.failure) || !pathIsAbsolute(parsed.failure.directory)
        || !installReasons.has(parsed.failure.reason)))
      || (parsed.pending !== undefined && (!record(parsed.pending) || !candidate(parsed.pending.next)
        || (parsed.pending.commandId !== undefined && !isIdentity(parsed.pending.commandId))
        || typeof parsed.pending.restorePrevious !== 'boolean'))) {
      throw new Error('Invalid CLI ownership manifest');
    }
    return parsed as unknown as Manifest;
  }

  function writeManifest(manifest: Manifest) {
    ensurePrivateDirectory(userData, {create: true});
    writePrivateFileAtomic(manifestFile, JSON.stringify(manifest) + '\n', manifestOptions);
  }

  const commandPath = (directory: string): string => path.join(directory, commandName);
  function display(file: string): string {
    const relative = path.relative(homeDir, file);
    if (!relative) return '~';
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) ? `~/${relative}` : file;
  }

  function directoryOwned(entry: Candidate): boolean {
    try {return inodeMatches(installDirectory(entry.directory, false, false), entry.directoryId);}
    catch {return false;}
  }

  const linkOwned = (entry: Installation): boolean => directoryOwned(entry)
    && ownedLink(commandPath(entry.directory), entry.target, entry.commandId);
  function published(pending: Pending | undefined): Installation | null {
    if (!pending?.commandId) return null;
    const entry = {...pending.next, commandId: pending.commandId};
    return linkOwned(entry) ? entry : null;
  }

  function unproven({pending, current}: Manifest): boolean {
    return Boolean(pending && !pending.commandId && directoryOwned(pending.next)
      && !(current?.directory === pending.next.directory && linkOwned(current))
      && pointsTo(commandPath(pending.next.directory), pending.next.target));
  }

  function removePlacement(entry: Installation, removeCommand: boolean) {
    if (removeCommand && directoryOwned(entry)) removeLink(commandPath(entry.directory), entry.target, entry.commandId);
    if (entry.copy) removeCopy(entry.target, userData, entry.copy);
  }

  function reconcile(manifest: Manifest): Manifest {
    const {pending} = manifest;
    if (!pending) return manifest;
    if (unproven(manifest)) return manifest;
    let {current} = manifest;
    const {next} = pending;
    const installed = published(pending);
    if (!installed && pending.restorePrevious && current?.directory === next.directory && directoryOwned(current)) {
      const command = commandPath(current.directory);
      if (!lstat(command)) {
        try {current = {...current, commandId: createLink(command, current.target)};}
        catch (error) {if (errorCode(error) !== 'EEXIST') throw error;}
      }
    }
    if (installed && current) removePlacement(current, current.directory !== next.directory);
    else if (!installed && next.copy) removeCopy(next.target, userData, next.copy);
    const resolved = installed ? {...emptyManifest(), current: installed} : {...manifest, current, pending: undefined};
    writeManifest(resolved);
    return resolved;
  }

  function launcherPresent(file: string): boolean {
    const info = lstat(file);
    return Boolean(info?.isFile() && (info.mode & 0o111n) && info.size > 0n && info.size < BigInt(MAC_CLI_LAUNCHER_MAX_BYTES));
  }

  function currentReason(entry: Installation, failure?: Attempt): CliReason | undefined {
    if (failure?.reason === 'CLI_AUTO_UPDATE_FAILED') return failure.reason;
    if (!directoryOwned(entry) || !lstat(commandPath(entry.directory))) return 'CLI_FILE_MISSING';
    if (!linkOwned(entry)) return 'CLI_INSTALL_TARGET_EXISTS';
    if (entry.copy ? !copyMatches(entry.target, userData, entry.copy)
      : entry.target !== bundleLauncher || !launcherPresent(entry.target)) return 'CLI_TARGET_MISSING';
    if (entry.installedVersion !== appVersion) return 'CLI_VERSION_MISMATCH';
    return undefined;
  }

  async function view(manifest: Manifest, transient?: Attempt): Promise<CliInstallStatus> {
    const installedPending = published(manifest.pending);
    const entry = installedPending ?? manifest.current;
    const unprovenFailure: Attempt | undefined = manifest.pending && unproven(manifest)
      ? {directory: manifest.pending.next.directory, reason: 'CLI_INSTALL_TARGET_EXISTS'} : undefined;
    const failure = transient ?? unprovenFailure ?? (installedPending ? undefined : manifest.failure);
    const automatic = Boolean(entry && failure?.reason === 'CLI_AUTO_UPDATE_FAILED');
    const directory = failure && !automatic ? failure.directory : entry?.directory ?? defaultDirectory;
    const command = commandPath(directory);
    const reason = (failure && !automatic ? failure.reason : undefined)
      ?? (entry ? currentReason(entry, failure) : undefined);
    const state: CliState = failure && !automatic ? 'install-failed'
      : entry ? (reason ? 'needs-repair' : 'installed') : 'not-installed';
    const installedVersion = entry?.installedVersion;
    const cli: CliInstallStatus['cli'] = {state, displayPath: display(command), onPath: 'unknown'};
    if (entry || failure) cli.commandPath = command;
    if (installedVersion !== undefined) cli.version = installedVersion;
    if (reason) {
      cli.reason = reason;
      if (reason === 'CLI_VERSION_MISMATCH' && installedVersion !== undefined) cli.reasonValues = {installedVersion};
      if (reason === 'CLI_INSTALL_TARGET_EXISTS' || reason === 'CLI_INSTALL_NOT_WRITABLE') cli.reasonValues = {directory: display(directory)};
    }
    if (state === 'installed' && pathIsAbsolute(shell)) {
      let resolved: string | null | undefined;
      try {resolved = await pathLookup(shell, commandName, homeDir);} catch {resolved = undefined;}
      cli.onPath = resolved === undefined ? 'unknown' : resolved && path.isAbsolute(resolved)
        && path.normalize(resolved) === command ? 'yes' : 'no';
      const rcFile = path.basename(shell) === 'zsh' ? '~/.zshrc' : path.basename(shell) === 'bash' ? '~/.bash_profile' : undefined;
      if (cli.onPath === 'no' && rcFile && !directory.includes(':')) {
        const line = directory === defaultDirectory ? 'export PATH="$HOME/.local/bin:$PATH"'
          : `export PATH=${shellQuote(directory)}:"$PATH"`;
        cli.pathHint = {line, rcFile};
      }
    }
    const mcpCommand = commandPath(entry?.directory ?? defaultDirectory);
    return {
      commandName, appVersion, cli, managed: Boolean(entry && linkOwned(entry)),
      ...(entry ? {installationKind: entry.copy ? 'versioned-copy' : 'bundle-link'} : {}),
      mcpCommands: {claudeCode: `claude mcp add -s user ${commandName} -- ${mcpQuote(mcpCommand)} mcp`,
        codex: `codex mcp add ${commandName} -- ${mcpQuote(mcpCommand)} mcp`},
    };
  }

  async function status(): Promise<CliInstallStatus> {
    try {return await view(readManifest());}
    catch {return view(emptyManifest(), {directory: defaultDirectory, reason: 'CLI_INSTALL_FAILED'});}
  }

  async function failed(directory: string, error: unknown, automatic = false, persist = true): Promise<CliInstallStatus> {
    const reason = automatic ? 'CLI_AUTO_UPDATE_FAILED' : error instanceof InstallError ? error.reason : 'CLI_INSTALL_FAILED';
    const attempt = {directory, reason} as Attempt;
    try {
      const saved = readManifest();
      if (persist && !saved.pending) writeManifest({...saved, failure: attempt});
      return await view(saved, attempt);
    } catch {return view(emptyManifest(), attempt);}
  }

  function issueDirectoryTicket(directory: string): string {
    if (!pathIsAbsolute(directory)) throw new InstallError('CLI_INSTALL_NOT_WRITABLE');
    const time = now();
    for (const [key, ticket] of tickets) if (time >= ticket.deadline) tickets.delete(key);
    if (tickets.size >= 32) tickets.delete(tickets.keys().next().value!);
    let id: FileIdentity;
    try {id = fileIdentity(installDirectory(directory, false, false));}
    catch (error) {return directoryFailure(error);}
    const key = randomUUID();
    tickets.set(key, {directory, id, deadline: time + ticketLifetimeMs});
    return key;
  }

  async function installAt(directory: string, manifest: Manifest, expectedDirectory?: FileIdentity): Promise<CliInstallStatus> {
    if (manifest.pending) throw new InstallError('CLI_INSTALL_TARGET_EXISTS');
    const current = manifest.current;
    if (!platform || appPath.split(path.sep).includes('AppTranslocation') || !launcherPresent(bundleLauncher)) {
      throw new InstallError('CLI_INSTALL_FAILED');
    }
    function validateDestination() {
      try {
        const info = installDirectory(directory, !expectedDirectory && directory === defaultDirectory);
        if (expectedDirectory && !inodeMatches(info, expectedDirectory)) throw new InstallError('CLI_INSTALL_NOT_WRITABLE');
        return info;
      } catch (error) {return directoryFailure(error);}
    }
    const directoryId = fileIdentity(validateDestination());
    const command = commandPath(directory);
    function checkExisting(): boolean {
      const exists = lstat(command) !== undefined;
      if (exists && !(current?.directory === directory && linkOwned(current))) throw new InstallError('CLI_INSTALL_TARGET_EXISTS');
      return exists;
    }
    checkExisting();
    if (current?.directory === directory && currentReason(current) === undefined) {
      const next = {...emptyManifest(), current};
      if (manifest.failure) writeManifest(next);
      return view(next);
    }
    if (current && current.directory !== directory && directoryOwned(current) && linkOwned(current)) {
      try {installDirectory(current.directory);} catch (error) {directoryFailure(error);}
    }
    await platform.verifyLauncher(bundleLauncher);
    const staging = newCopyLocation(userData, appVersion, commandName);
    let target = staging.file;
    let copy: CopyProof | undefined;
    let pending: Manifest['pending'];
    let journaled = false;
    try {
      await platform.copyLauncher(bundleLauncher, target, appPath);
      copy = finalizeCopy(target, userData);
      await platform.verifyLauncher(target);
      if (!copyMatches(target, userData, copy)) throw new InstallError('CLI_INSTALL_FAILED');
      if (await platform.assessCopy(target) === 'rejected') {
        removeCopy(target, userData, copy);
        target = bundleLauncher;
        copy = undefined;
        await platform.verifyLauncher(bundleLauncher);
      }
      if (!inodeMatches(validateDestination(), directoryId)) throw new InstallError('CLI_INSTALL_NOT_WRITABLE');
      const replace = checkExisting();
      const next: Candidate = {directory, directoryId, target, installedVersion: appVersion, ...(copy ? {copy} : {})};
      pending = {next, restorePrevious: replace};
      writeManifest({...manifest, pending});
      journaled = true;
      // Check again after the journal write. All inspection and publication
      // here are synchronous so other operations on this installer cannot race.
      if (!inodeMatches(validateDestination(), directoryId)) throw new InstallError('CLI_INSTALL_NOT_WRITABLE');
      const canReplace = checkExisting();
      if (canReplace !== replace) throw new InstallError('CLI_INSTALL_TARGET_EXISTS');
      try {
        if (canReplace && current) removeLink(command, current.target, current.commandId);
        pending = {...pending, commandId: createLink(command, target)};
      } catch (error) {directoryFailure(error);}
      writeManifest({...manifest, pending});
      return view(reconcile({...manifest, pending}));
    } catch (error) {
      if (journaled) reconcile({...manifest, pending});
      else {
        if (copy) removeCopy(target, userData, copy);
        else if (target === staging.file) discardUnpublishedCopy(staging.file, staging.directoryId);
      }
      throw error;
    }
  }

  let queue: Promise<unknown> = Promise.resolve();
  function serialize(operation: () => Promise<CliInstallStatus>): Promise<CliInstallStatus> {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  }

  function install(ticket?: string): Promise<CliInstallStatus> {
    const selection = ticket === undefined ? undefined : tickets.get(ticket);
    if (ticket !== undefined) tickets.delete(ticket);
    return serialize(async () => {
      const directory = selection?.directory ?? defaultDirectory;
      if (ticket !== undefined && (!selection || selection.deadline <= now())) {
        return failed(directory, new InstallError('CLI_INSTALL_NOT_WRITABLE'), false, false);
      }
      try {return await installAt(directory, reconcile(readManifest()), selection?.id);}
      catch (error) {return failed(directory, error);}
    });
  }

  function installSelectedDirectory(directory: string): Promise<CliInstallStatus> {
    try {return install(issueDirectoryTicket(directory));}
    catch (error) {
      return serialize(() => failed(pathIsAbsolute(directory) ? directory : defaultDirectory, error));
    }
  }

  function repair(automatic: boolean): Promise<CliInstallStatus> {
    return serialize(async () => {
      let directory = defaultDirectory;
      try {
        const manifest = reconcile(readManifest());
        const entry = manifest.current;
        if (!entry) return view(manifest);
        directory = entry.directory;
        if (automatic && (!linkOwned(entry)
          || (entry.installedVersion === appVersion && (entry.copy || entry.target === bundleLauncher)))) return view(manifest);
        return await installAt(directory, manifest);
      } catch (error) {return failed(directory, error, automatic);}
    });
  }

  function uninstall(): Promise<CliInstallStatus> {
    return serialize(async () => {
      let directory = defaultDirectory;
      try {
        const manifest = reconcile(readManifest());
        if (manifest.current) {
          directory = manifest.current.directory;
          removePlacement(manifest.current, true);
        }
        removePrivateFile(manifestFile, manifestOptions);
        return view(emptyManifest());
      } catch (error) {return failed(directory, error);}
    });
  }

  return Object.freeze({status, issueDirectoryTicket, install, installSelectedDirectory, uninstall,
    repair: () => repair(false), autoRepair: () => repair(true)});
}

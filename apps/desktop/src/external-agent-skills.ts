import {createHash, randomUUID} from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readSync, readdirSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync, type BigIntStats,
} from 'node:fs';
import path from 'node:path';
import {ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import type {ExternalAgent, ExternalAgentsView, SkillState} from '../../../packages/contracts/src/external-agents.ts';
import {errorCode, fileIdentity, inodeMatches, isIdentity, lstat, pathIsAbsolute, type FileIdentity} from './cli-install-storage.ts';

type SkillView = ExternalAgentsView['skills'][number];

const agentDirectories = {'claude-code': '.claude', codex: '.codex'} as const;
const commandToken = '{{MIOON_COMMAND}}';
const maxManifestBytes = 64 * 1024;
const maxFileBytes = 1024 * 1024;

function safeRelativeFile(file: string): boolean {
  return file.split('/').every(part => /^[A-Za-z0-9_.-]+$/u.test(part) && part !== '.' && part !== '..');
}

interface InstalledSkill {
  commandPath: string;
  directory: FileIdentity;
  files: Record<string, string>;
  createdDirectories: Record<string, FileIdentity>;
}

interface Manifest {
  version: 1;
  commandName: ExternalAgentsView['commandName'];
  installations: Partial<Record<ExternalAgent, InstalledSkill>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInstalledSkill(value: unknown): value is InstalledSkill {
  return isRecord(value) && pathIsAbsolute(value.commandPath) && isIdentity(value.directory) && isRecord(value.files) &&
    Object.hasOwn(value.files, 'SKILL.md') && Object.entries(value.files).every(([file, hash]) =>
      safeRelativeFile(file) && typeof hash === 'string' && /^[0-9a-f]{64}$/u.test(hash)) &&
    isRecord(value.createdDirectories) && Object.entries(value.createdDirectories).every(([directory, proof]) =>
      (directory === '' || safeRelativeFile(directory)) && isIdentity(proof));
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function renderSkillFile(file: string, bytes: Buffer, commandPath: string, commandName: Manifest['commandName']): Buffer {
  if (!bytes.includes(commandToken) && file !== 'SKILL.md') return bytes;
  // K3 wraps commands in double quotes. A custom install path can contain shell metacharacters.
  const quotedPath = /[\\"$`!]/u.test(commandPath)
    ? "'" + commandPath.replaceAll("'", "'\"'\"'") + "'"
    : '"' + commandPath + '"';
  const rendered = bytes.toString('utf8').replace(/"\{\{MIOON_COMMAND\}\}"|\{\{MIOON_COMMAND\}\}/gu, token =>
    token === commandToken ? commandPath : quotedPath);
  return Buffer.from(file === 'SKILL.md'
    ? rendered.replace(/^(---\r?\nname: )mioon(?=\r?\n)/u, (_match, prefix: string) => prefix + commandName)
    : rendered);
}

function sameEntry(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameEntry(left, right) && left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs && left.size === right.size;
}

interface FileSnapshot {
  info: BigIntStats;
  bytes: Buffer;
}

function readFile(file: string, info: BigIntStats): FileSnapshot {
  const handle = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!sameFile(info, fstatSync(handle, {bigint: true}))) throw new Error('Skill file changed while opening');
    const bytes = Buffer.alloc(Number(info.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(handle, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length !== Number(info.size) || !sameFile(info, fstatSync(handle, {bigint: true}))) {
      throw new Error('Skill file changed while reading');
    }
    return {info, bytes: bytes.subarray(0, length)};
  } finally {
    closeSync(handle);
  }
}

function readBundle(directory: string, commandPath: string, commandName: Manifest['commandName']): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  function visit(relative: string): void {
    for (const entry of readdirSync(path.join(directory, relative), {withFileTypes: true})) {
      const file = relative ? relative + '/' + entry.name : entry.name;
      if (!safeRelativeFile(file)) throw new Error('Invalid bundled skill path');
      if (entry.isDirectory()) {
        visit(file);
      } else {
        const target = path.join(directory, file);
        const info = lstat(target);
        if (!info?.isFile() || info.size > maxFileBytes) throw new Error('Invalid bundled skill file');
        result.set(file, renderSkillFile(file, readFile(target, info).bytes, commandPath, commandName));
      }
    }
  }
  visit('');
  if (!result.has('SKILL.md')) throw new Error('Bundled skill is missing SKILL.md');
  return result;
}

const unsafeEntry = Symbol('unsafe skill entry');
type SkillSnapshot = FileSnapshot | typeof unsafeEntry | undefined;

export function createExternalAgentSkills({homeDirectory, appDataDirectory, bundledSkillDirectory, commandName}: {
  homeDirectory: string;
  appDataDirectory: string;
  bundledSkillDirectory: string;
  commandName: ExternalAgentsView['commandName'];
}) {
  if (![homeDirectory, appDataDirectory, bundledSkillDirectory].every(pathIsAbsolute)) {
    throw new TypeError('Skill storage requires absolute directories');
  }
  const manifestFile = path.join(appDataDirectory, 'external-agent-skills.json');
  const manifestStorage = {root: appDataDirectory, maxBytes: maxManifestBytes};
  const root = (agent: ExternalAgent) => path.join(homeDirectory, agentDirectories[agent], 'skills', commandName);

  function readManifest(): Manifest {
    if (!lstat(manifestFile)) return {version: 1, commandName, installations: {}};
    const raw = readPrivateFile(manifestFile, {...manifestStorage, allowMissing: true, encoding: 'utf8'});
    if (raw === null) return {version: 1, commandName, installations: {}};
    const parsed: unknown = JSON.parse(String(raw));
    if (!isRecord(parsed) || parsed.version !== 1 || parsed.commandName !== commandName || !isRecord(parsed.installations)) {
      throw new Error('Invalid skill manifest');
    }
    const installations: Manifest['installations'] = {};
    for (const [agent, installed] of Object.entries(parsed.installations)) {
      if ((agent !== 'claude-code' && agent !== 'codex') || !isInstalledSkill(installed)) {
        throw new Error('Invalid skill installation manifest');
      }
      installations[agent] = installed;
    }
    return {version: 1, commandName, installations};
  }

  function writeManifest(manifest: Manifest): void {
    ensurePrivateDirectory(appDataDirectory, {create: true});
    writePrivateFileAtomic(manifestFile, JSON.stringify(manifest) + '\n', manifestStorage);
  }

  function directoryStatus(agent: ExternalAgent, directory: string, created?: Map<string, FileIdentity>): 'ok' | 'missing' | 'unsafe' {
    const home = lstat(homeDirectory);
    if (!home?.isDirectory()) return 'unsafe';
    const skillRoot = root(agent);
    let current = homeDirectory;
    for (const part of path.relative(homeDirectory, directory).split(path.sep)) {
      current = path.join(current, part);
      let info = lstat(current);
      if (!info && created) {
        mkdirSync(current, {mode: 0o700});
        info = lstat(current);
        if (info?.isDirectory() && (current === skillRoot || current.startsWith(skillRoot + path.sep))) {
          created.set(path.relative(skillRoot, current).split(path.sep).join('/'), fileIdentity(info));
        }
      }
      if (!info) return 'missing';
      if (!info.isDirectory() || (process.getuid &&
        (info.uid !== BigInt(process.getuid()) || (info.mode & 0o022n) !== 0n))) return 'unsafe';
    }
    return 'ok';
  }

  function managedInstallation(agent: ExternalAgent, manifest: Manifest): InstalledSkill | undefined {
    const installed = manifest.installations[agent];
    if (!installed || directoryStatus(agent, root(agent)) !== 'ok') return undefined;
    const directory = lstat(root(agent));
    return directory?.isDirectory() && inodeMatches(directory, installed.directory) ? installed : undefined;
  }

  function snapshot(agent: ExternalAgent, file: string): SkillSnapshot {
    const target = path.join(root(agent), file);
    const directory = directoryStatus(agent, path.dirname(target));
    if (directory === 'unsafe') return unsafeEntry;
    if (directory === 'missing') return undefined;
    const info = lstat(target);
    if (!info) return undefined;
    if (!info.isFile() || info.nlink !== 1n || info.size > maxFileBytes || (process.getuid &&
      (info.uid !== BigInt(process.getuid()) || (info.mode & 0o022n) !== 0n))) return unsafeEntry;
    return readFile(target, info);
  }

  function assess(agent: ExternalAgent, installed: InstalledSkill, current: Map<string, Buffer>): SkillState {
    const files = Object.entries(installed.files);
    const observed = files.map<{hash: string; actual: SkillSnapshot}>(([file, hash]) => ({hash, actual: snapshot(agent, file)}));
    if (observed.every(({actual}) => actual === undefined)) return 'not-installed';
    const sameVersion = current.size === files.length && files.every(([file, hash]) => {
      const bytes = current.get(file);
      return bytes && sha256(bytes) === hash;
    });
    if (sameVersion) return 'installed';
    const edited = observed.some(({hash, actual}) => !actual || actual === unsafeEntry || sha256(actual.bytes) !== hash);
    return edited ? 'modified' : 'update-available';
  }

  function tidy(agent: ExternalAgent, created: Map<string, FileIdentity>): void {
    for (const [relative, expected] of [...created].sort(([a], [b]) => b.length - a.length)) {
      const directory = path.join(root(agent), relative);
      if (directoryStatus(agent, directory) !== 'ok') continue;
      const actual = lstat(directory);
      if (!actual?.isDirectory() || !inodeMatches(actual, expected)) continue;
      try {rmdirSync(directory);}
      catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String(errorCode(error)))) throw error;
      }
    }
  }

  function replaceFile(agent: ExternalAgent, file: string, before: FileSnapshot | undefined, bytes?: Buffer): FileSnapshot | undefined {
    const target = path.join(root(agent), file);
    function confirmUnchanged(): void {
      const actual = snapshot(agent, file);
      if (actual === unsafeEntry || (before ? !actual || !sameFile(before.info, actual.info) : actual)) {
        throw new Error('Installed skill file changed during the operation');
      }
    }
    if (!bytes) {
      confirmUnchanged();
      unlinkSync(target);
      return;
    }
    if (directoryStatus(agent, path.dirname(target)) !== 'ok') throw new Error('Invalid skill directory');
    const staged = path.join(path.dirname(target), '.mioon-' + randomUUID() + '.tmp');
    const handle = openSync(staged, 'wx', 0o600);
    let stagedInfo: BigIntStats | undefined;
    try {
      try {
        stagedInfo = fstatSync(handle, {bigint: true});
        writeFileSync(handle, bytes);
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      confirmUnchanged();
      if (before) renameSync(staged, target);
      else linkSync(staged, target);
    } finally {
      if (stagedInfo && directoryStatus(agent, path.dirname(staged)) === 'ok') {
        const remaining = lstat(staged);
        if (remaining && sameEntry(remaining, stagedInfo)) unlinkSync(staged);
      }
    }
    const written = snapshot(agent, file);
    if (!stagedInfo || !written || written === unsafeEntry || !sameEntry(written.info, stagedInfo) || !bytes.equals(written.bytes)) {
      throw new Error('Installed skill file changed during the operation');
    }
    return written;
  }

  function change(agent: ExternalAgent, manifest: Manifest, next: Map<string, Buffer>, commandPath?: string): void {
    const installed = managedInstallation(agent, manifest);
    const created = new Map(Object.entries(installed?.createdDirectories ?? {}));
    const added = new Map<string, FileIdentity>();
    const plan = new Map<string, FileSnapshot | undefined>();
    for (const file of new Set([...Object.keys(installed?.files ?? {}), ...next.keys()])) {
      const before = snapshot(agent, file);
      if (next.has(file)) {
        if (before === unsafeEntry || (before && !Object.hasOwn(installed?.files ?? {}, file))) {
          throw new Error('Skill destination already contains an unmanaged file');
        }
        plan.set(file, before);
      } else if (before && before !== unsafeEntry) {
        plan.set(file, before);
      }
    }
    const applied: {file: string; snapshot: FileSnapshot | undefined}[] = [];
    try {
      for (const [file, before] of plan) {
        const bytes = next.get(file);
        if (before && bytes?.equals(before.bytes)) continue;
        const directory = path.dirname(path.join(root(agent), file));
        if (bytes && directoryStatus(agent, directory, added) !== 'ok') throw new Error('Invalid skill directory');
        applied.push({file, snapshot: replaceFile(agent, file, before, bytes)});
      }
      const installations = {...manifest.installations};
      if (commandPath) {
        const directory = lstat(root(agent));
        if (!directory?.isDirectory() || (installed && !inodeMatches(directory, installed.directory))) {
          throw new Error('Skill directory changed during the operation');
        }
        installations[agent] = {
          commandPath,
          directory: fileIdentity(directory),
          files: Object.fromEntries([...next].map(([file, bytes]) => [file, sha256(bytes)])),
          createdDirectories: Object.fromEntries([...created, ...added]),
        };
      } else {
        delete installations[agent];
      }
      writeManifest({...manifest, installations});
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const {file, snapshot: written} of applied.reverse()) {
        try {replaceFile(agent, file, written, plan.get(file)?.bytes);}
        catch (rollbackError) {rollbackErrors.push(rollbackError);}
      }
      try {tidy(agent, added);}
      catch (rollbackError) {rollbackErrors.push(rollbackError);}
      if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'Skill operation could not be rolled back');
      throw error;
    }
    if (!commandPath) tidy(agent, created);
  }

  function bundle(commandPath: string): Map<string, Buffer> {
    if (!pathIsAbsolute(commandPath)) throw new TypeError('Skill requires an absolute CLI path');
    return readBundle(bundledSkillDirectory, commandPath, commandName);
  }

  return {
    async read(agent: ExternalAgent, commandPath?: string): Promise<SkillView> {
      const installed = managedInstallation(agent, readManifest());
      const state = installed ? assess(agent, installed, bundle(commandPath ?? installed.commandPath)) : 'not-installed';
      return {agent, state, displayDirectory: '~/' + [agentDirectories[agent], 'skills', commandName].join('/')};
    },
    async install(agent: ExternalAgent, commandPath: string): Promise<void> {
      const manifest = readManifest();
      const installed = managedInstallation(agent, manifest);
      const current = bundle(commandPath);
      if (installed && assess(agent, installed, current) !== 'not-installed') return;
      change(agent, manifest, current, commandPath);
    },
    async update(agent: ExternalAgent, commandPath: string, overwriteModified: boolean): Promise<'updated' | 'modified'> {
      const manifest = readManifest();
      const installed = managedInstallation(agent, manifest);
      const current = bundle(commandPath);
      if (!installed) return 'updated';
      const state = assess(agent, installed, current);
      if (state === 'modified' && !overwriteModified) return 'modified';
      if (state === 'modified' || state === 'update-available') change(agent, manifest, current, commandPath);
      return 'updated';
    },
    async uninstall(agent: ExternalAgent): Promise<void> {
      const manifest = readManifest();
      if (manifest.installations[agent]) change(agent, manifest, new Map());
    },
    async autoUpdate(agent: ExternalAgent, commandPath: string): Promise<void> {
      const manifest = readManifest();
      const installed = managedInstallation(agent, manifest);
      if (!installed) return;
      const current = bundle(commandPath);
      if (assess(agent, installed, current) === 'update-available') change(agent, manifest, current, commandPath);
    },
  };
}

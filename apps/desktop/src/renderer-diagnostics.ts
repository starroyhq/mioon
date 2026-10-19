import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

// Renderer health evidence only. One bounded JSONL family covers unresponsive /
// responsive / render-process-gone transitions so an issue #4 investigation has
// causal ordering without renderer content. Rotation mirrors backend exit
// diagnostics: at most maxBytes per file and fileCount files (current plus two
// rotated), 0700 directory and 0600 files, atomic rename rotation.
export const RENDERER_DIAGNOSTIC_LIMITS = Object.freeze({ maxBytes: 65536, fileCount: 3 });

const events = ['unresponsive', 'responsive', 'render-process-gone'] as const;
const classifications = ['unresponsive', 'responsive', 'exited', 'terminated', 'crashed', 'abnormal'] as const;
const goneReasons = ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure'] as const;
const channels = ['production', 'development'] as const;
const schemaVersion = 1;
const semanticVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export type RendererDiagnosticEvent = typeof events[number];
export type RendererClassification = typeof classifications[number];
export type RendererGoneReason = typeof goneReasons[number];
export type RendererChannel = typeof channels[number];
export interface RendererDiagnosticRecord {
  readonly schemaVersion: typeof schemaVersion;
  readonly at: string;
  readonly event: RendererDiagnosticEvent | null;
  readonly classification: RendererClassification | null;
  readonly reason: RendererGoneReason | null;
  readonly exitCode: number | null;
  readonly appVersion: string | null;
  readonly channel: RendererChannel | null;
}
export interface RendererDiagnostics { record(event: unknown, details?: unknown): boolean }
interface Metadata {
  readonly appVersion: string | null;
  readonly channel: RendererChannel | null;
}
interface DirectoryPolicy {
  ensurePrivateDirectory(directory: string, options: { create: true }): unknown;
  validatePrivateDirectory(directory: string): unknown;
}
interface Options {
  readonly dataDir?: string | null;
  readonly modulePath: string;
  // Trusted main-process composition only, never supplied over IPC/config.
  readonly directoryPolicy: DirectoryPolicy;
}
interface RendererEventInput {
  readonly event?: unknown;
  readonly reason?: unknown;
  readonly exitCode?: unknown;
  readonly details?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  for (const item of allowed) if (value === item) return item;
  return null;
}

function appVersion(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const match = semanticVersion.exec(value);
  if (!match || match[0] !== value) return null;
  if (match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) return null;
  return value;
}

function readMetadata(modulePath: string): Metadata {
  let metadata: unknown;
  try { metadata = JSON.parse(readFileSync(path.join(path.dirname(modulePath), 'package.json'), 'utf8')); }
  catch { /* A source checkout or damaged manifest may have no build metadata. */ }
  const source = isRecord(metadata) ? metadata : null;
  const desktop = isRecord(source?.mioonDesktop) ? source.mioonDesktop : null;
  return { appVersion: appVersion(source?.version), channel: enumValue(desktop?.channel, channels) };
}

/**
 * Classify one renderer health transition. `render-process-gone` carries the
 * Electron reason and exit code; unresponsive/responsive never claim a cause.
 * Unknown or hostile values downgrade to null instead of being interpreted.
 */
export function classifyRendererEvent(event: unknown, details: unknown): RendererClassification | null {
  if (event === 'unresponsive' || event === 'responsive') return event;
  if (event !== 'render-process-gone') return null;
  const reason = isRecord(details) ? details.reason : undefined;
  switch (reason) {
    case 'clean-exit': return 'exited';
    case 'killed': return 'terminated';
    case 'crashed': case 'oom': case 'launch-failed': case 'integrity-failure': return 'crashed';
    case 'abnormal-exit': return 'abnormal';
    default: return null;
  }
}

function existingFile(file: string): Stats | null {
  try {
    const stat = lstatSync(file);
    ownedFile(stat);
    return stat;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

function ownedFile(stat: Stats): Stats {
  if (!stat.isFile() || typeof process.getuid !== 'function' || stat.uid !== process.getuid() || stat.nlink !== 1) {
    throw new Error('Invalid diagnostic file');
  }
  return stat;
}
function sameFile(left: Stats | null, right: Stats | null): boolean {
  return left === null || right === null ? left === right : left.dev === right.dev && left.ino === right.ino;
}

// Match private-storage's POSIX owner and canonical-parent boundary. As with
// its pathname-only operations, this does not claim protection against root or
// an actively racing process running as the same OS account.
function appendDiagnostic(dataDir: string, directory: string, file: string, line: Buffer, policy: DirectoryPolicy): void {
  const { maxBytes, fileCount } = RENDERER_DIAGNOSTIC_LIMITS;
  policy.ensurePrivateDirectory(dataDir, { create: true });
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (!isRecord(error) || error.code !== 'EEXIST') throw error; }
  const directoryIdentity = lstatSync(directory);
  const assertDirectory = () => {
    policy.validatePrivateDirectory(dataDir);
    const current = lstatSync(directory);
    if (!current.isDirectory() || current.uid !== process.getuid!() || !sameFile(directoryIdentity, current)) {
      throw new Error('Diagnostic directory changed');
    }
  };
  assertDirectory();
  const targets = [file];
  for (let index = 1; index < fileCount; index++) targets.push(`${file}.${index}`);
  const snapshots = targets.map(existingFile);
  const assertTarget = (index: number) => {
    assertDirectory();
    if (!sameFile(snapshots[index]!, existingFile(targets[index]!))) throw new Error('Diagnostic file changed');
  };
  // Inspect every slot before mutating any existing file or permission.
  let directoryDescriptor: number | undefined;
  try {
    directoryDescriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(directoryDescriptor);
    if (!opened.isDirectory() || !sameFile(directoryIdentity, opened) || opened.uid !== process.getuid!()) {
      throw new Error('Diagnostic directory changed while opening');
    }
    assertDirectory();
    fchmodSync(directoryDescriptor, 0o700);
  } finally { if (directoryDescriptor !== undefined) closeSync(directoryDescriptor); }
  const remove = (index: number) => {
    assertTarget(index);
    if (snapshots[index]) unlinkSync(targets[index]!);
    snapshots[index] = null;
  };
  for (let index = 0; index < targets.length; index++) {
    const snapshot = snapshots[index];
    if (!snapshot) continue;
    if (snapshot.size > maxBytes) { remove(index); continue; }
    let descriptor: number | undefined;
    try {
      assertTarget(index);
      descriptor = openSync(targets[index]!, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!sameFile(snapshot, ownedFile(fstatSync(descriptor)))) throw new Error('Diagnostic file changed while opening');
      assertTarget(index);
      fchmodSync(descriptor, 0o600);
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
  for (let index = 0; index < targets.length; index++) assertTarget(index);
  if ((snapshots[0]?.size ?? 0) + line.length > maxBytes) {
    remove(fileCount - 1);
    for (const source of [fileCount - 2, 0]) {
      assertTarget(source); assertTarget(source + 1);
      if (!snapshots[source]) continue;
      renameSync(targets[source]!, targets[source + 1]!);
      snapshots[source + 1] = snapshots[source]!; snapshots[source] = null;
      assertTarget(source + 1);
    }
  }
  let descriptor: number | undefined;
  try {
    assertTarget(0);
    descriptor = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK
      | (snapshots[0] ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
    const opened = ownedFile(fstatSync(descriptor));
    if (snapshots[0] && !sameFile(snapshots[0]!, opened)) throw new Error('Diagnostic file changed while opening');
    snapshots[0] = opened; assertTarget(0);
    if (opened.size + line.length > maxBytes) throw new Error('Diagnostic capacity changed');
    fchmodSync(descriptor, 0o600);
    let written = 0;
    while (written < line.length) {
      ownedFile(fstatSync(descriptor)); assertTarget(0);
      const count = writeSync(descriptor, line, written);
      if (count <= 0) throw new Error('Incomplete diagnostic write');
      written += count;
    }
    fsyncSync(descriptor);
    ownedFile(fstatSync(descriptor)); assertTarget(0);
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** Minimal structural surface of Electron WebContents used for wiring. */
export interface RendererHealthContents { on(event: string, listener: (...args: unknown[]) => void): unknown }

/**
 * Attach the three renderer health listeners. Diagnostic failure (missing
 * factory, write error, or even a hostile listener transport) is swallowed so
 * it can never replace, delay or gate the caller's existing recovery handlers.
 */
export function installRendererHealthDiagnostics(contents: RendererHealthContents, diagnostics: RendererDiagnostics | null | undefined): void {
  const record = (event: string, details?: unknown): void => {
    try { diagnostics?.record(event, details); } catch { /* Evidence only. */ }
  };
  try {
    contents.on('unresponsive', () => record('unresponsive'));
    contents.on('responsive', () => record('responsive'));
    contents.on('render-process-gone', (...args: unknown[]) => {
      // Only the Electron reason and exit code are extracted; the event object,
      // details identity and any extra renderer-supplied fields are discarded.
      const details = isRecord(args[1]) ? args[1] : {};
      record('render-process-gone', { reason: details.reason, exitCode: details.exitCode });
    });
  } catch {
    // A missing or unusual webContents surface must not affect recovery.
  }
}

// Only fixed renderer-health fields reach this local JSONL. Renderer URLs,
// document titles, console text, stack traces, project paths, tokens and the
// original event/details objects are never serialized.
export function createRendererDiagnostics({ dataDir, modulePath, directoryPolicy }: Options): RendererDiagnostics {
  const metadata = readMetadata(modulePath);
  const directory = typeof dataDir === 'string' && dataDir.length ? path.join(dataDir, 'diagnostics') : null;
  const file = directory && path.join(directory, 'renderer-health.jsonl');

  function record(event: unknown, details?: unknown): boolean {
    try {
      if (!file || !directory || !dataDir) return false;
      const input: RendererEventInput = isRecord(details) ? details : {};
      const name = enumValue(event, events);
      const reason = enumValue(input.reason, goneReasons);
      const exitCode = input.exitCode;
      const record: RendererDiagnosticRecord = {
        schemaVersion, at: new Date().toISOString(), ...metadata,
        event: name,
        classification: classifyRendererEvent(name, input),
        reason: name === 'render-process-gone' ? reason : null,
        exitCode: name === 'render-process-gone' && typeof exitCode === 'number' && Number.isSafeInteger(exitCode) ? exitCode : null,
      };
      const line = Buffer.from(`${JSON.stringify(record)}\n`);
      if (line.length > RENDERER_DIAGNOSTIC_LIMITS.maxBytes) return false;
      appendDiagnostic(dataDir, directory, file, line, directoryPolicy);
      return true;
    } catch {
      // Diagnostics are evidence only: I/O failures never change recovery.
      return false;
    }
  }
  return { record };
}

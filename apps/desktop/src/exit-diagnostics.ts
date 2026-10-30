import { randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { appendWindowsDiagnostic } from './diagnostic-append-windows.ts';

export const EXIT_DIAGNOSTIC_LIMITS = Object.freeze({ maxBytes: 65536, fileCount: 3 });

const events = ['start', 'ready', 'stop-requested', 'termination-requested', 'backend-notice',
  'exit', 'stop-unconfirmed', 'spawn-failed'] as const;
const classifications = ['normal', 'terminated', 'abnormal', 'connection-lost'] as const;
const reasons = ['stop-requested', 'startup-timeout', 'startup-error', 'startup-failed',
  'startup-communication-failed', 'invalid-origin', 'runtime-error', 'communication-lost', 'lease-expired',
  'signal-term', 'signal-int', 'uncaught-exception', 'unhandled-rejection', 'shutdown-failed', 'utility-exit'] as const;
const states = ['idle', 'starting', 'running', 'stopping', 'stopped', 'failed', 'stop-unconfirmed', 'media-unconfirmed'] as const;
const terminations = ['utility-kill', 'owned-sigkill'] as const;
const channels = ['production', 'development'] as const;
const numericVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const semanticVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const booleanValue = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface RuntimeVersions { readonly node?: unknown; readonly electron?: unknown; readonly sqlite?: unknown }
interface Metadata {
  readonly appVersion: string | null;
  readonly channel: typeof channels[number] | null;
  readonly runtime: { readonly node: string | null; readonly electron: string | null; readonly sqlite: string | null };
}
interface DirectoryPolicy {
  ensurePrivateDirectory(directory: string, options: { create: true }): unknown;
  validatePrivateDirectory(directory: string): unknown;
}
interface Options {
  readonly dataDir?: string | null;
  readonly modulePath: string;
  readonly versions?: RuntimeVersions;
  // Trusted main-process composition only, never supplied over IPC/config.
  readonly directoryPolicy: DirectoryPolicy;
}
export interface ExitDiagnostics { record(event: unknown): boolean }
export type ExitClassification = typeof classifications[number];
interface ExitClassificationInput {
  readonly reason: string | null;
  readonly shutdownFailed: boolean;
  readonly forced: boolean;
  readonly expected: boolean;
  readonly code: unknown;
  readonly mediaExitConfirmed: boolean;
}
export interface ExitDiagnosticRecord extends Metadata {
  readonly runId: string;
  readonly time: string;
  readonly event: typeof events[number] | null;
  readonly classification: typeof classifications[number] | null;
  readonly reason: typeof reasons[number] | null;
  readonly state: typeof states[number] | null;
  readonly expected: boolean | null;
  readonly forced: boolean | null;
  readonly exitConfirmed: boolean | null;
  readonly shutdownFailed: boolean | null;
  readonly mediaExitConfirmed: boolean | null;
  readonly code: number | null;
  readonly signal: null;
  readonly termination: typeof terminations[number] | null;
}

export function classifyBackendExit({ reason, shutdownFailed, forced, expected, code,
  mediaExitConfirmed }: ExitClassificationInput): ExitClassification {
  const cause = reason ?? 'utility-exit';
  if (['communication-lost', 'lease-expired'].includes(cause)) return 'connection-lost';
  if (shutdownFailed || !['stop-requested', 'signal-term', 'signal-int', 'utility-exit'].includes(cause)) return 'abnormal';
  if (forced || ['signal-term', 'signal-int'].includes(cause)) return 'terminated';
  return expected && code === 0 && mediaExitConfirmed ? 'normal' : 'abnormal';
}

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

function runtimeVersion(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 32 && numericVersion.exec(value)?.[0] === value ? value : null;
}

function readMetadata(modulePath: string, versions: RuntimeVersions): Metadata {
  let metadata: unknown;
  try { metadata = JSON.parse(readFileSync(path.join(path.dirname(modulePath), 'package.json'), 'utf8')); }
  catch { /* A source checkout or damaged manifest may have no build metadata. */ }
  const source = isRecord(metadata) ? metadata : null;
  const desktop = isRecord(source?.mioonDesktop) ? source.mioonDesktop : null;
  return {
    appVersion: appVersion(source?.version),
    channel: enumValue(desktop?.channel, channels),
    runtime: { node: runtimeVersion(versions?.node), electron: runtimeVersion(versions?.electron),
      sqlite: runtimeVersion(versions?.sqlite) }
  };
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
  // Windows has no owner or mode bits to check; its ACL backend writes instead.
  if (process.platform === 'win32') { appendWindowsDiagnostic(dataDir, directory, file, line, EXIT_DIAGNOSTIC_LIMITS); return; }
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
  const targets = [file, `${file}.1`, `${file}.2`];
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
    if (snapshot.size > EXIT_DIAGNOSTIC_LIMITS.maxBytes) { remove(index); continue; }
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
  if ((snapshots[0]?.size ?? 0) + line.length > EXIT_DIAGNOSTIC_LIMITS.maxBytes) {
    remove(2);
    for (const source of [1, 0]) {
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
    if (opened.size + line.length > EXIT_DIAGNOSTIC_LIMITS.maxBytes) throw new Error('Diagnostic capacity changed');
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

// Only fixed lifecycle fields reach this local JSONL. No error, config, request,
// environment or path is serialized, including fields supplied by the backend.
export function createExitDiagnostics({ dataDir, modulePath, versions = process.versions, directoryPolicy }: Options): ExitDiagnostics {
  const runId = randomUUID();
  const metadata = readMetadata(modulePath, versions);
  const directory = typeof dataDir === 'string' && dataDir.length ? path.join(dataDir, 'diagnostics') : null;
  const file = directory && path.join(directory, 'backend-exit.jsonl');

  return {
    record(event: unknown): boolean {
      try {
        if (!file || !directory) return false;
        const input = isRecord(event) ? event : null;
        const code = input?.code;
        const record: ExitDiagnosticRecord = {
          runId, time: new Date().toISOString(), ...metadata,
          event: enumValue(input?.event, events),
          classification: enumValue(input?.classification, classifications),
          reason: enumValue(input?.reason, reasons),
          state: enumValue(input?.state, states),
          expected: booleanValue(input?.expected),
          forced: booleanValue(input?.forced),
          exitConfirmed: booleanValue(input?.exitConfirmed),
          shutdownFailed: booleanValue(input?.shutdownFailed),
          mediaExitConfirmed: booleanValue(input?.mediaExitConfirmed),
          code: typeof code === 'number' && Number.isSafeInteger(code) ? code : null,
          // Electron utilityProcess exposes an exit code, not an OS signal.
          signal: null,
          termination: enumValue(input?.termination, terminations)
        };
        const line = Buffer.from(`${JSON.stringify(record)}\n`);
        if (line.length > EXIT_DIAGNOSTIC_LIMITS.maxBytes) return false;
        appendDiagnostic(dataDir!, directory, file, line, directoryPolicy);
        return true;
      } catch {
        // Diagnostics are evidence only: I/O failures never change lifecycle.
        return false;
      }
    }
  };
}

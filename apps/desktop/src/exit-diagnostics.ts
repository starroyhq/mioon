import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

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
interface Options { readonly dataDir?: string | null; readonly modulePath: string; readonly versions?: RuntimeVersions }
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
    if (!stat.isFile()) throw new Error('Invalid diagnostic file');
    return stat;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

// Only fixed lifecycle fields reach this local JSONL. No error, config, request,
// environment or path is serialized, including fields supplied by the backend.
export function createExitDiagnostics({ dataDir, modulePath, versions = process.versions }: Options): ExitDiagnostics {
  const runId = randomUUID();
  const metadata = readMetadata(modulePath, versions);
  const directory = typeof dataDir === 'string' && dataDir.length ? path.join(dataDir, 'diagnostics') : null;
  const file = directory && path.join(directory, 'backend-exit.jsonl');

  return {
    record(event: unknown): boolean {
      let descriptor: number | undefined;
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
        // Keep backend-exit.jsonl and its .1/.2 rotations at most 64 KiB each.
        // Factories share the fixed files, so later launches retain the cap.
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (!lstatSync(directory).isDirectory()) return false;
        chmodSync(directory, 0o700);
        for (let index = 0; index < EXIT_DIAGNOSTIC_LIMITS.fileCount; index++) {
          const target = index ? `${file}.${index}` : file;
          const stat = existingFile(target);
          if (stat && stat.size > EXIT_DIAGNOSTIC_LIMITS.maxBytes) unlinkSync(target);
          else if (stat) chmodSync(target, 0o600);
        }
        if ((existingFile(file)?.size ?? 0) + line.length > EXIT_DIAGNOSTIC_LIMITS.maxBytes) {
          if (existingFile(`${file}.2`)) unlinkSync(`${file}.2`);
          if (existingFile(`${file}.1`)) renameSync(`${file}.1`, `${file}.2`);
          if (existingFile(file)) renameSync(file, `${file}.1`);
        }
        descriptor = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND
          | (constants.O_NOFOLLOW ?? 0), 0o600);
        if (!fstatSync(descriptor).isFile()) return false;
        fchmodSync(descriptor, 0o600);
        let written = 0;
        while (written < line.length) {
          const count = writeSync(descriptor, line, written);
          if (count <= 0) return false;
          written += count;
        }
        fsyncSync(descriptor);
        return true;
      } catch {
        // Diagnostics are evidence only: I/O failures never change lifecycle.
        return false;
      } finally {
        if (descriptor !== undefined) {
          try { closeSync(descriptor); } catch { /* Preserve lifecycle on I/O failure. */ }
        }
      }
    }
  };
}

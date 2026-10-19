#!/usr/bin/env node
// Deliberately separate from the HTTP CLI: never resolve connections, read
// credentials, initialize services or contact a provider. Restore only installs
// the fixed offline guard into a private candidate before atomic publication.
import path from 'node:path';
import {backupPresentationArguments, localizeBackupHelp, backupDiagnostic} from './backup-presentation.ts';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import type {Locale} from '@mioon/i18n';

const messages = Object.freeze({
  RESTORE_BACKUP_UNAVAILABLE: 'This restored working branch cannot create another backup until recursive restore is supported. No backup destination was created; keep the original verified backup.',
  WORKSPACE_RESTORE_IO: 'Offline restore did not complete. Preserve the incomplete destination and original backup; use a different new destination after review.',
  WORKSPACE_RESTORE_INVALID_PATH: 'Use explicit canonical absolute backup and new destination directories with no overlap.',
  WORKSPACE_RESTORE_DESTINATION_WORKSPACE_ANCESTOR: 'The destination is inside a directory with an existing workspace database or workspace lock. Choose an independent new destination outside existing workspaces.',
  WORKSPACE_RESTORE_DESTINATION_EXISTS: 'The restore destination already exists. Choose a new destination; existing contents were not changed.',
  WORKSPACE_RESTORE_LOCKED: 'The destination contains a preexisting lock. No lock was removed or repaired.',
  WORKSPACE_RESTORE_LOCK_LOST: 'The destination lock changed. Preserve the incomplete destination and original backup.',
  WORKSPACE_RESTORE_SOURCE_SCHEMA_UNSUPPORTED: 'Only fully classified schema24 original backups can be restored. Restored and unknown schemas are not supported.',
  WORKSPACE_RESTORE_CHANGED: 'A backup or destination file changed. Preserve the incomplete destination and original backup.',
  WORKSPACE_RESTORE_LIMIT: 'The backup or restored candidate exceeds a fixed offline restore safety limit.',
  WORKSPACE_RESTORE_CANCELLED: 'Restore was cancelled before activation. Incomplete files are retained; choose a different new destination after review.',
  WORKSPACE_RESTORE_DATABASE_INVALID: 'The candidate failed fixed schema, captured identity or preservation validation. It was not activated.',
  WORKSPACE_RESTORE_PUBLICATION_UNCONFIRMED: 'The guarded database may be activated, but publication or durability is unconfirmed. Preserve the original backup and this destination. Run restore-status with the original backup directory and destination, or the exact returned binding; if unavailable, review this destination and use a different new destination for another offline copy. Do not retry inherited tasks.',
  WORKSPACE_RESTORE_STATUS_UNAVAILABLE: 'The destination is not safely inspectable offline or does not match the supplied restoration binding. Close the backend before inspection. Existing locks, links and sidecars were not repaired.',
  VALIDATION_ERROR: 'Use exactly one supported command and its documented options. Run node apps/cli/src/backup.ts --help for usage.',
  WORKSPACE_BACKUP_INVALID_PATH: 'Use explicit canonical absolute directories with no overlapping source and destination.',
  WORKSPACE_BACKUP_DESTINATION_EXISTS: 'The backup destination already exists. Choose a new destination; existing contents were not changed.',
  WORKSPACE_BACKUP_LOCKED: 'The workspace has an existing lock. Close the backend and review the lock before retrying.',
  WORKSPACE_BACKUP_LOCK_LOST: 'The workspace lock changed. The incomplete backup has not been published.',
  WORKSPACE_BACKUP_NOT_COLD: 'The workspace has an uncheckpointed SQLite WAL or journal. Close the backend cleanly before backing up; no sidecar was repaired or deleted.',
  WORKSPACE_BACKUP_LIMIT: 'The workspace or backup exceeds a fixed offline backup safety limit.',
  WORKSPACE_BACKUP_DATABASE_INVALID: 'The copied database cannot be safely inspected as a supported workspace.',
  WORKSPACE_BACKUP_INCOMPLETE: 'This directory has no complete supported workspace backup.',
  WORKSPACE_BACKUP_CORRUPT: 'Backup contents do not match the complete manifest.',
  WORKSPACE_BACKUP_CHANGED: 'A workspace or backup file changed during inspection. The operation did not complete safely.',
  WORKSPACE_BACKUP_PUBLICATION_UNCONFIRMED: 'Backup publication durability or rollback could not be confirmed. This destination may contain a published backup. Preserve this destination and run the separate verify command; marker presence alone is not proof of a complete backup.',
  WORKSPACE_BACKUP_CANCELLED: 'The workspace backup operation was cancelled. Incomplete files may remain in the new destination.',
  WORKSPACE_BACKUP_IO: 'The workspace backup operation could not safely complete. Incomplete files may remain in the new destination.',
  STORAGE_PRIVATE_REQUIRED: 'The operation requires private, current-user-owned storage with safe files and ancestry. No permissions were changed.',
  STORAGE_PRIVACY_UNAVAILABLE: 'Required storage privacy checks are unavailable on this platform. The operation was not performed.',
});
type BackupCode = keyof typeof messages;
export interface BackupHelp {command: 'help'; topic?: string | undefined}
export interface BackupVersion {command: 'version'}
export interface BackupCreate {command: 'create'; source: string; destination: string}
export interface BackupVerify {command: 'verify'; directory: string}
export interface BackupRestore {command: 'restore'; directory: string; destination: string}
export interface BackupRestoreStatusDirectory {command: 'restore-status'; directory: string; destination: string}
export interface BackupRestoreStatusExact {command: 'restore-status'; destination: string; restorationId: string; sourceBackupId: string; manifestHash: string; sourceDbHash: string}
export type BackupInvocation = BackupHelp | BackupVersion | BackupCreate | BackupVerify | BackupRestore | BackupRestoreStatusDirectory | BackupRestoreStatusExact;
interface BackupSafeError {code: BackupCode; message: string; details: Record<string, unknown>; retryable: false}
interface ResultSchema {safeParse(value: unknown): {success: true; data: unknown} | {success: false; error: unknown}}

function fail(code: BackupCode = 'VALIDATION_ERROR'): never {
  throw Object.assign(new Error(messages[code]), {code});
}

function absoluteDirectory(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value) || path.resolve(value) !== value) {
    fail('WORKSPACE_BACKUP_INVALID_PATH');
  }
  return value;
}

export function parseBackupArguments(argv: readonly string[], onLocale: (locale: Locale | undefined) => void = () => {}): BackupInvocation {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) fail();
  let visit: (index: number, allowLocale?: boolean) => void = () => {};
  if (argv.some(value => value === '--locale' || value.startsWith('--locale='))) ({argv, visit} = backupPresentationArguments(argv, fail, onLocale));
  visit(0);
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--help')) { visit(Infinity); return {command: 'help'}; }
  if (argv.length === 1 && argv[0] === '--version') { visit(Infinity); return {command: 'version'}; }
  const [command, ...options] = argv;
  if (command !== 'create' && command !== 'verify' && command !== 'restore' && command !== 'restore-status') fail();
  if (options.length === 1 && options[0] === '--help') { visit(Infinity); return {command: 'help', topic: command}; }
  const allowed = command === 'create' ? ['--source', '--destination'] : command === 'restore' ? ['--directory', '--destination'] : command === 'restore-status' ? (options.includes('--directory') ? ['--directory', '--destination'] : ['--destination', '--restoration-id', '--backup-id', '--manifest-hash', '--source-db-hash']) : ['--directory'];
  const values: Record<string, string | undefined> = Object.create(null);
  for (let index = 0; index < options.length; index += 2) {
    visit(index + 1);
    const flag = options[index], value: string | undefined = options[index + 1];
    if (!allowed.includes(flag) || Object.hasOwn(values, flag)) fail();
    visit(index + 2, false);
    if (value === undefined || value.startsWith('--')) fail();
    if (['--source', '--destination', '--directory'].includes(flag)) values[flag] = absoluteDirectory(value);
    else {
      const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
      if (flag.endsWith('-hash') ? value.length !== 64 || !/^[a-f0-9]{64}$/.test(value) : value.length !== 36 || !uuid.test(value)) fail();
      values[flag] = value;
    }
  }
  visit(Infinity);
  if (allowed.some(flag => !Object.hasOwn(values, flag))) fail();
  if (command === 'restore') return {command, directory: values['--directory']!, destination: values['--destination']!};
  if (command === 'restore-status' && values['--directory']) return {command, directory: values['--directory'], destination: values['--destination']!};
  if (command === 'restore-status') return {command, destination: values['--destination']!, restorationId: values['--restoration-id']!, sourceBackupId: values['--backup-id']!, manifestHash: values['--manifest-hash']!, sourceDbHash: values['--source-db-hash']!};
  return command === 'create'
    ? {command, source: values['--source']!, destination: values['--destination']!}
    : {command, directory: values['--directory']!};
}

function version(): string {
  const value: unknown = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(value)) fail('WORKSPACE_BACKUP_IO');
  return value;
}

function help(topic: string | undefined) {
  const commands: Readonly<Record<string, string>> = {
    create: 'node apps/cli/src/backup.ts create --source /absolute/workspace --destination /absolute/new-backup',
    verify: 'node apps/cli/src/backup.ts verify --directory /absolute/backup',
    restore: 'node apps/cli/src/backup.ts restore --directory /absolute/verified-backup --destination /absolute/new-workspace',
    'restore-status': 'node apps/cli/src/backup.ts restore-status --directory /absolute/original-backup --destination /absolute/restored-workspace',
  };
  return {
    name: 'mioon-backup', version: version(), offline: true,
    usage: topic ? [commands[topic]] : [...Object.values(commands), 'node apps/cli/src/backup.ts --help', 'node apps/cli/src/backup.ts --version', 'pnpm backup --help'],
    requirements: [
      'Node.js 24+ with installed source workspace dependencies.',
      'Close every backend or desktop app using the source workspace before capture. Existing locks and uncheckpointed SQLite sidecars are refused without repair.',
      'Use explicit canonical absolute paths. The destination must be new, with an existing safe parent, and must not overlap the source. Restore also refuses destination ancestors containing workbench.sqlite or server.lock; choose an independent workspace root.',
      'Backup format1 does not record its original source path. Renamed or uninitialized source directories lacking fixed workspace/lock markers cannot be identified automatically; keep the new destination outside your original workspace.',
    ],
    privacy: [
      'Whole-workspace capture includes the database and supported managed media/staging payloads across all projects.',
      'The database includes chats, prompts, request/replay caches and other user text. User text may contain secrets; this is not a secret-redacted export.',
      'App credential, settings and connection files are excluded. Backup payloads remain private plaintext, not encrypted.',
    ],
    safety: [
      'Local files only. No connection or token configuration is read, and no HTTP, provider, recovery or generation operation is started.',
      'Verification checks supported manifest and payload integrity; it does not establish restoration readiness. Restore separately accepts only classified schema24 and installs permanent held-work guards in schema25.',
      'Restored branches allow supported fresh local editing and export. Captured tasks, approvals, histories, receipts and unknown outcomes remain held; generation, Agent, Comfy, frame and waveform work are unavailable. Backup creation of restored branches is unavailable; keep the original verified backup.',
      'Restore never opens or switches the backend automatically. For Web, select the new workspace with MIOON_DATA_DIR. For Desktop, restore to a new root/workspace child, then explicitly select that new root with MIOON_DESKTOP_USER_DATA; never share old token/session files.',
      'Restore budgets payload plus four 512MiB database/copy/journal allowances and 64MiB sidecars. This is an estimate, not a free-space or memory guarantee.',
      'After total stdout/acknowledgement loss, use restore-status --directory /absolute/original-backup --destination /absolute/restored-workspace. It verifies the whole original backup and target binding before disclosing the existing restoration identity. Exact-ID mode remains available: restore-status --destination /absolute/restored-workspace --restoration-id UUID --backup-id UUID --manifest-hash SHA256 --source-db-hash SHA256.',
      'Restore-status is a read-only guarded-schema and provenance observation. It does not repair locks or sidecars, resume work, or prove a previously unconfirmed fsync was durable.',
      'No overwrite, automatic retry or automatic deletion. Interrupted captures may leave an incomplete new destination; choose a different new destination after review.',
      'SIGINT and SIGTERM request cancellation and wait for local cleanup attempts. Unconfirmed source lock release is explicitly reported; inspect it before another capture.',
      'A published backup may include warnings:["SOURCE_LOCK_RELEASE_UNCONFIRMED"]. A failed or cancelled operation preserves its error code and adds details.sourceLockRelease:"unconfirmed" if source lock cleanup is unconfirmed.',
    ],
    output: 'Exactly one JSON envelope on stdout. Success is {ok:true,data:...}; errors are {ok:false,error:{code,message,details:{...},retryable:false}}. Details contain only fixed cleanup warnings and generated restore provenance after uncertain publication. Exit codes: 0 success, 2 invalid arguments, 1 operation failure, 130 SIGINT cancellation, 143 SIGTERM cancellation.',
  };
}

// Diagnostics are an allowlist; never forward raw exception messages, causes,
// paths, input values, SQLite rows, stack traces or validation details.
function safeError(error: unknown, command: string | undefined): BackupSafeError {
  const candidate = error !== null && typeof error === 'object' ? error as {code?: unknown; cleanupUnconfirmed?: unknown; publication?: unknown} : {};
  const code: BackupCode = typeof candidate.code === 'string' && Object.hasOwn(messages, candidate.code) ? candidate.code as BackupCode : 'WORKSPACE_BACKUP_IO';
  const details: Record<string, unknown> = candidate.cleanupUnconfirmed === true ? {[command === 'restore' ? 'destinationLockRelease' : 'sourceLockRelease']: 'unconfirmed'} : {};
  if (code === 'WORKSPACE_RESTORE_PUBLICATION_UNCONFIRMED' && candidate.publication) {
    const p = candidate.publication as Record<string, unknown>, uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, hash = /^[a-f0-9]{64}$/;
    if (['restorationId', 'workspaceOrigin', 'sourceBackupId'].every(key => typeof p[key] === 'string' && p[key].length === 36 && uuid.test(p[key] as string)) && ['manifestHash', 'sourceDbHash'].every(key => typeof p[key] === 'string' && p[key].length === 64 && hash.test(p[key] as string))) {
      const publication: Record<string, unknown> = Object.fromEntries(['restorationId', 'workspaceOrigin', 'sourceBackupId', 'manifestHash', 'sourceDbHash'].map(key => [key, p[key]]));
      publication.state = 'unconfirmed';
      details.publication = publication;
    }
  }
  return {code, message: messages[code], details, retryable: false};
}

function output(stream: NodeJS.WritableStream, text: string): Promise<boolean> {
  // Respect pipe backpressure, including the largest bounded issue list. A
  // closed pipe is handled within this write rather than a global exit hook.
  return new Promise<boolean>(resolve => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      stream.removeListener('error', onError);
      resolve(value);
    };
    const onError = () => finish(false);
    stream.once('error', onError);
    try {
      stream.write(text, error => {
        // Writable streams emit a write error after calling their callback.
        // Keep our scoped listener until that event has had a turn to arrive.
        if (error) setImmediate(() => finish(false));
        else finish(true);
      });
    } catch {finish(false);}
  });
}

export async function runBackupCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let firstSignal: 'SIGINT' | 'SIGTERM' | undefined, command: string | undefined, locale: Locale | undefined;
  let data: unknown;
  let error: BackupSafeError | undefined;
  try {
    const input = parseBackupArguments(argv, value => { locale = value; });
    command = input.command;
    if (input.command === 'help') data = localizeBackupHelp(help(input.topic), locale);
    else if (input.command === 'version') data = {name: 'mioon-backup', version: version()};
    else {
      const controller = new AbortController();
      const interrupt = (signal: 'SIGINT' | 'SIGTERM') => {
        firstSignal ??= signal;
        controller.abort();
      };
      const onInterrupt = () => interrupt('SIGINT');
      const onTerminate = () => interrupt('SIGTERM');
      process.on('SIGINT', onInterrupt);
      process.on('SIGTERM', onTerminate);
      try {
        let result: unknown, resultSchema: ResultSchema;
        if (input.command === 'restore' || input.command === 'restore-status') {
          const {restoreWorkspaceBackup, inspectWorkspaceRestorePublication} = await import('../../../packages/business/src/workspace-restore.ts');
          const {workspaceRestoreOfflineResultSchema, workspaceRestorePublicationStatusSchema} = await import('../../../packages/contracts/src/workspace-restore-offline.ts');
          const {command: ignored, ...options} = input;
          result = await (input.command === 'restore' ? restoreWorkspaceBackup : inspectWorkspaceRestorePublication)({...options, signal: controller.signal});
          resultSchema = input.command === 'restore' ? workspaceRestoreOfflineResultSchema : workspaceRestorePublicationStatusSchema;
        } else {
          const {createWorkspaceBackup, verifyWorkspaceBackup} = await import('../../../packages/business/src/workspace-backup.ts');
          const {workspaceBackupResultSchema} = await import('../../../packages/contracts/src/workspace-backup.ts');
          result = input.command === 'create'
            ? await createWorkspaceBackup({source: input.source, destination: input.destination, signal: controller.signal})
            : await verifyWorkspaceBackup({directory: input.directory, signal: controller.signal});
          resultSchema = workspaceBackupResultSchema;
        }
        const parsed = resultSchema.safeParse(result);
        if (!parsed.success) fail('WORKSPACE_BACKUP_IO');
        data = parsed.data;
      } finally {
        // No exit hooks and no forced process exit: the operation has settled
        // and completed its own cleanup attempts before handlers are removed.
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onTerminate);
      }
    }
  } catch (caught) {
    error = safeError(caught, command);
  }
  if (error) {
    await output(process.stdout, `${JSON.stringify({ok: false, error})}\n`);
    await output(process.stderr, `${error.code}: ${backupDiagnostic(error.code, error.message, locale)}\n`);
    return error.code === 'VALIDATION_ERROR' || ['WORKSPACE_BACKUP_INVALID_PATH', 'WORKSPACE_RESTORE_INVALID_PATH'].includes(error.code) ? 2
      : ['WORKSPACE_BACKUP_CANCELLED', 'WORKSPACE_RESTORE_CANCELLED'].includes(error.code) ? (firstSignal === 'SIGTERM' ? 143 : 130) : 1;
  }
  return await output(process.stdout, `${JSON.stringify({ok: true, data})}\n`) ? 0 : 1;
}

// Internal offline candidate CLI reuses the exact parser, sanitized diagnostics
// and bounded output lifecycle; this does not change the ordinary commands.
export {safeError as safeBackupCliError, output as writeBackupCliOutput};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runBackupCli();
}

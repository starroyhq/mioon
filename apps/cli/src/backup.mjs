#!/usr/bin/env node
// Deliberately separate from the HTTP CLI: never resolve connections, read
// credentials, initialize services, migrate a database or contact a provider.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';

const messages = Object.freeze({
  VALIDATION_ERROR: 'Use exactly one supported command and its documented options. Run node apps/cli/src/backup.mjs --help for usage.',
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

function fail(code = 'VALIDATION_ERROR') {
  throw Object.assign(new Error(messages[code]), {code});
}

function absoluteDirectory(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value) || path.resolve(value) !== value) {
    fail('WORKSPACE_BACKUP_INVALID_PATH');
  }
  return value;
}

export function parseBackupArguments(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) fail();
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--help')) return {command: 'help'};
  if (argv.length === 1 && argv[0] === '--version') return {command: 'version'};
  const [command, ...options] = argv;
  if (!['create', 'verify'].includes(command)) fail();
  if (options.length === 1 && options[0] === '--help') return {command: 'help', topic: command};
  const allowed = command === 'create' ? ['--source', '--destination'] : ['--directory'];
  const values = Object.create(null);
  for (let index = 0; index < options.length; index += 2) {
    const flag = options[index], value = options[index + 1];
    if (!allowed.includes(flag) || Object.hasOwn(values, flag) || value === undefined || value.startsWith('--')) fail();
    values[flag] = absoluteDirectory(value);
  }
  if (allowed.some(flag => !Object.hasOwn(values, flag))) fail();
  return command === 'create'
    ? {command, source: values['--source'], destination: values['--destination']}
    : {command, directory: values['--directory']};
}

function version() {
  const value = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(value)) fail('WORKSPACE_BACKUP_IO');
  return value;
}

function help(topic) {
  const commands = {
    create: 'node apps/cli/src/backup.mjs create --source /absolute/workspace --destination /absolute/new-backup',
    verify: 'node apps/cli/src/backup.mjs verify --directory /absolute/backup',
  };
  return {
    name: 'mioon-backup', version: version(), offline: true,
    usage: topic ? [commands[topic]] : [...Object.values(commands), 'node apps/cli/src/backup.mjs --help', 'node apps/cli/src/backup.mjs --version', 'pnpm backup --help'],
    requirements: [
      'Node.js 24+ with installed source workspace dependencies.',
      'Close every backend or desktop app using the source workspace before capture. Existing locks and uncheckpointed SQLite sidecars are refused without repair.',
      'Use explicit canonical absolute paths. The destination must be new, with an existing safe parent, and must not overlap the source.',
    ],
    privacy: [
      'Whole-workspace capture includes the database and supported managed media/staging payloads across all projects.',
      'The database includes chats, prompts, request/replay caches and other user text. User text may contain secrets; this is not a secret-redacted export.',
      'App credential, settings and connection files are excluded. Backup payloads remain private plaintext, not encrypted.',
    ],
    safety: [
      'Local files only. No connection or token configuration is read, and no HTTP, provider, recovery or generation operation is started.',
      'Verification checks supported manifest and payload integrity; it does not establish restoration readiness. Restore is not implemented.',
      'No overwrite, restore, automatic retry or automatic deletion. Interrupted captures may leave an incomplete new destination; choose a different new destination after review.',
      'SIGINT and SIGTERM request cancellation and wait for local cleanup attempts. Unconfirmed source lock release is explicitly reported; inspect it before another capture.',
      'A published backup may include warnings:["SOURCE_LOCK_RELEASE_UNCONFIRMED"]. A failed or cancelled operation preserves its error code and adds details.sourceLockRelease:"unconfirmed" if source lock cleanup is unconfirmed.',
    ],
    output: 'Exactly one JSON envelope on stdout. Success is {ok:true,data:...}; errors are {ok:false,error:{code,message,details:{...},retryable:false}}. Details are empty except the fixed source-lock cleanup warning. Exit codes: 0 success, 2 invalid arguments, 1 operation failure, 130 SIGINT cancellation, 143 SIGTERM cancellation.',
  };
}

// Diagnostics are an allowlist; never forward raw exception messages, causes,
// paths, input values, SQLite rows, stack traces or validation details.
function safeError(error) {
  const code = typeof error?.code === 'string' && Object.hasOwn(messages, error.code) ? error.code : 'WORKSPACE_BACKUP_IO';
  return {code, message: messages[code], details: error?.cleanupUnconfirmed === true ? {sourceLockRelease: 'unconfirmed'} : {}, retryable: false};
}

function output(stream, text) {
  // Respect pipe backpressure, including the largest bounded issue list. A
  // closed pipe is handled within this write rather than a global exit hook.
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
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

export async function runBackupCli(argv = process.argv.slice(2)) {
  let firstSignal;
  let data;
  let error;
  try {
    const input = parseBackupArguments(argv);
    if (input.command === 'help') data = help(input.topic);
    else if (input.command === 'version') data = {name: 'mioon-backup', version: version()};
    else {
      const controller = new AbortController();
      const interrupt = signal => {
        firstSignal ??= signal;
        controller.abort();
      };
      const onInterrupt = () => interrupt('SIGINT');
      const onTerminate = () => interrupt('SIGTERM');
      process.on('SIGINT', onInterrupt);
      process.on('SIGTERM', onTerminate);
      try {
        const {createWorkspaceBackup, verifyWorkspaceBackup} = await import('../../../packages/business/src/workspace-backup.mjs');
        const {workspaceBackupResultSchema} = await import('../../../packages/contracts/src/workspace-backup.mjs');
        const result = input.command === 'create'
          ? await createWorkspaceBackup({source: input.source, destination: input.destination, signal: controller.signal})
          : await verifyWorkspaceBackup({directory: input.directory, signal: controller.signal});
        const parsed = workspaceBackupResultSchema.safeParse(result);
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
    error = safeError(caught);
  }
  if (error) {
    await output(process.stdout, `${JSON.stringify({ok: false, error})}\n`);
    await output(process.stderr, `${error.code}: ${error.message}\n`);
    return error.code === 'VALIDATION_ERROR' || error.code === 'WORKSPACE_BACKUP_INVALID_PATH' ? 2
      : error.code === 'WORKSPACE_BACKUP_CANCELLED' ? (firstSignal === 'SIGTERM' ? 143 : 130) : 1;
  }
  return await output(process.stdout, `${JSON.stringify({ok: true, data})}\n`) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runBackupCli();
}

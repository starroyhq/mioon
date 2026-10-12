import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, chmod, truncate} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from '../packages/business/src/db.mjs';
import {workspaceBackupResultSchema} from '../packages/contracts/src/workspace-backup.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const entry = path.join(repo, 'apps/cli/src/backup.mjs');
const secret = 'synthetic-backup-credential-never-live';
const privateText = 'Synthetic chat and prompt text may contain a secret.';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = value => createHash('sha256').update(value).digest('hex');

// Fail at the boundary rather than merely relying on unreachable endpoints.
// The real child remains responsible for all backup/verification filesystem I/O.
const offlineGuard = `
import {registerHooks, syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
registerHooks({resolve(specifier, context, nextResolve) {
  const value = nextResolve(specifier, context);
  if (/^(?:node:)?(?:http|https|http2|net|tls|dns)(?:\\/|$)/.test(value.url) ||
      /\\/packages\\/(?:client|server)\\//.test(value.url) ||
      /\\/packages\\/business\\/src\\/(?:index|services)\\.mjs$/.test(value.url) ||
      /\\/apps\\/(?:server|mcp)\\//.test(value.url)) throw Error('OFFLINE_BOUNDARY_VIOLATION');
  return value;
}});
globalThis.fetch = () => { throw Error('OFFLINE_NETWORK_VIOLATION'); };
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = () => { throw Error('OFFLINE_SUBPROCESS_VIOLATION'); };
}
process.env = new Proxy(process.env, {get(target, name) {
  if (typeof name === 'string' && /^(?:MIOON_|RUNWAY|ARK_|VEO_|OPENAI_API|GOOGLE_API|MINIMAX|VIDU)/.test(name)) throw Error('OFFLINE_CREDENTIAL_ENV_VIOLATION');
  return Reflect.get(target, name);
}});
const guardPath = value => {
  if (value instanceof URL) value = fileURLToPath(value);
  if (typeof value === 'string' && /^(?:access-token|mcp-connection\\.json|settings\\.json|custom-settings\\.json)$/.test(path.basename(value))) throw Error('OFFLINE_CREDENTIAL_FILE_VIOLATION');
};
for (const name of ['readFileSync', 'openSync', 'readFile', 'open']) {
  const original = fs[name];
  fs[name] = function(value, ...args) { guardPath(value); return Reflect.apply(original, this, [value, ...args]); };
}
for (const name of ['readFile', 'open']) {
  const original = fs.promises[name];
  fs.promises[name] = function(value, ...args) { guardPath(value); return Reflect.apply(original, this, [value, ...args]); };
}
syncBuiltinESMExports();
`;

async function sandbox(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-backup-cli-'));
  const guard = path.join(root, 'offline-guard.mjs');
  await writeFile(guard, offlineGuard, {mode: 0o600});
  const children = new Set();
  t.after(async () => {
    await Promise.all([...children].map(cleanup => cleanup()));
    await rm(root, {recursive: true, force: true});
  });
  return {root, guard, children};
}

function startCli(t, args, {root, guard, children, timeout = 20_000} = {}) {
  const child = spawn(process.execPath, ['--import', guard, entry, ...args], {
    cwd: repo,
    env: {...process.env, MIOON_TOKEN: secret, MIOON_TOKEN_FILE: path.join(root, 'access-token'), MIOON_CONNECTION_FILE: path.join(root, 'mcp-connection.json'), MIOON_BASE_URL: 'https://must-never-contact.invalid'},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', failure, closed = false;
  const capture = which => chunk => {
    if (which === 'stdout') stdout += chunk;
    else stderr += chunk;
    if (stdout.length + stderr.length > 256 * 1024) {
      failure ??= Error('CLI output exceeded the bounded test capture');
      child.kill('SIGKILL');
    }
  };
  // Set UTF-8 before adding data handlers; chunk boundaries must not corrupt it.
  child.stdout.setEncoding('utf8').on('data', capture('stdout'));
  child.stderr.setEncoding('utf8').on('data', capture('stderr'));
  const complete = new Promise(resolve => {
    const timer = setTimeout(() => {
      failure ??= Error('Owned backup CLI did not exit within its test deadline');
      child.kill('SIGKILL');
    }, timeout);
    child.once('error', error => {failure ??= error;});
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      closed = true;
      resolve({code, signal, stdout, stderr, failure});
    });
  });
  children.add(async () => {
    if (!closed) child.kill('SIGKILL');
    // The timeout targets exactly this owned child; never kill by name/group.
    let timer;
    try {
      await Promise.race([complete, new Promise((_, reject) => {timer = setTimeout(() => reject(Error('Owned CLI cleanup did not finish')), 5000);})]);
    } finally {clearTimeout(timer);}
  });
  return {child, complete, isClosed: () => closed};
}

async function resultFor(owned) {
  const result = await owned.complete;
  if (result.failure) throw result.failure;
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'exactly one JSON envelope, no progress/logging on stdout');
  result.body = JSON.parse(lines[0]);
  for (const forbidden of [secret, privateText, 'OFFLINE_BOUNDARY_VIOLATION', 'OFFLINE_NETWORK_VIOLATION', 'OFFLINE_SUBPROCESS_VIOLATION', 'OFFLINE_CREDENTIAL_ENV_VIOLATION', 'OFFLINE_CREDENTIAL_FILE_VIOLATION']) {
    assert.ok(!result.stdout.includes(forbidden), 'stdout does not expose secrets or guard failures');
    assert.ok(!result.stderr.includes(forbidden), 'stderr does not expose secrets or guard failures');
  }
  return result;
}

const run = (t, args, context) => resultFor(startCli(t, args, context));
function success(result) {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.body.ok, true);
  assert.ok(Object.hasOwn(result.body, 'data'));
  return result.body.data;
}
function failure(result, code, exit = 1, details = {}) {
  assert.equal(result.code, exit, result.stdout + result.stderr);
  assert.equal(result.signal, null);
  assert.deepEqual(Object.keys(result.body).sort(), ['error', 'ok']);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.error.code, code);
  assert.equal(typeof result.body.error.message, 'string');
  assert.deepEqual(result.body.error.details, details);
  assert.equal(result.body.error.retryable, false);
  assert.ok(result.stderr.includes(code));
  assert.ok(!result.stdout.includes(repo));
  return result.body.error;
}

async function fixture(t, context, {large = false} = {}) {
  const source = path.join(context.root, 'workspace');
  const store = openStore(source);
  const projectId = randomUUID(), assetId = randomUUID();
  const assetRelative = `media/${assetId}.mp4`, media = path.join(source, assetRelative);
  try {
    store.put('projects', {id: projectId, name: privateText});
    const bytes = Buffer.from('synthetic managed media bytes');
    await writeFile(media, bytes, {mode: 0o600});
    if (large) await truncate(media, 128 * 1024 * 1024);
    store.put('assets', {id: assetId, projectId, name: privateText, relativePath: assetRelative, mimeType: 'video/mp4', sha256: sha256(bytes), sizeBytes: large ? 128 * 1024 * 1024 : bytes.length});
  } finally {store.close();}
  await writeFile(path.join(source, 'access-token'), secret, {mode: 0o600});
  await writeFile(path.join(source, 'mcp-connection.json'), JSON.stringify({token: secret}), {mode: 0o600});
  for (const name of ['agent-settings', 'image-settings', 'comfy-settings']) {
    await mkdir(path.join(source, name), {mode: 0o700});
    await writeFile(path.join(source, name, 'settings.json'), JSON.stringify({apiKey: secret}), {mode: 0o600});
  }
  return {source, media, assetRelative, projectId};
}

async function exists(file) {
  try {await stat(file); return true;} catch (error) {if (error.code === 'ENOENT') return false; throw error;}
}

test('offline backup help/version disclose whole-workspace sensitivity without startup or credentials', {timeout: 15_000}, async t => {
  const context = await sandbox(t);
  for (const args of [[], ['--help'], ['create', '--help'], ['verify', '--help']]) {
    const output = success(await run(t, args, context));
    const content = JSON.stringify(output);
    assert.equal(output.name, 'mioon-backup');
    assert.equal(output.offline, true);
    assert.ok(output.usage.every(usage => usage.startsWith('node apps/cli/src/backup.mjs ') || usage.startsWith('pnpm backup ')), 'only verified source-checkout launchers are advertised');
    for (const text of ['Whole-workspace', 'chats', 'prompts', 'caches', 'may contain secrets', 'private plaintext', 'Restore separately accepts only classified schema24', 'App credential, settings and connection files are excluded', 'cleanup attempts', 'SOURCE_LOCK_RELEASE_UNCONFIRMED']) assert.ok(content.includes(text), text);
  }
  const output = success(await run(t, ['--version'], context));
  const metadata = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
  assert.deepEqual(output, {name: 'mioon-backup', version: metadata.version});
  assert.equal(metadata.scripts.backup, 'node apps/cli/src/backup.mjs');
  const cliPackage = JSON.parse(await readFile(path.join(repo, 'apps/cli/package.json'), 'utf8'));
  assert.equal(Object.hasOwn(cliPackage.bin, 'mioon-backup'), false, 'no unverified workspace bin entry is published');
  assert.deepEqual((await readdir(context.root)).sort(), ['offline-guard.mjs']);
  const alternateVersionGuard = path.join(context.root, 'alternate-version.mjs');
  await writeFile(alternateVersionGuard, `${offlineGuard}\n
const ordinaryRead = fs.readFileSync;
fs.readFileSync = function(value, options) {
  const name = value instanceof URL ? fileURLToPath(value) : value;
  if (name === ${JSON.stringify(path.join(repo, 'package.json'))}) return JSON.stringify({version: '9.8.7'});
  return ordinaryRead(value, options);
};
syncBuiltinESMExports();
`, {mode: 0o600});
  for (const args of [['--version'], ['--help']]) {
    assert.equal(success(await run(t, args, {...context, guard: alternateVersionGuard})).version, '9.8.7', 'product root is the single version source');
  }
});

test('offline backup rejects unknown commands, duplicates, extra arguments and noncanonical paths before writes', {timeout: 30_000}, async t => {
  const context = await sandbox(t);
  const source = path.join(context.root, 'source'), destination = path.join(context.root, 'new-backup');
  for (const args of [
    ['restore'], ['--help', '--version'], ['--version', 'extra'], ['create'], ['verify'],
    ['create', '--source', source], ['create', '--destination', destination], ['verify', '--directory'],
    ['create', '--source', source, '--source', source, '--destination', destination],
    ['create', '--source', source, '--destination', destination, '--destination', destination],
    ['verify', '--directory', destination, '--directory', destination],
    ['verify', '--directory', destination, '--source', source],
    ['verify', '--directory', destination, '--token', secret],
    ['create', '--source', source, '--destination', destination, '--force'],
    ['create', '--source', source, '--destination', destination, 'extra'],
    ['verify', '--directory', destination, 'extra'], ['verify', `--directory=${destination}`],
    ['create', '--help', '--source', source], ['verify', '--directory', destination, '--help'],
    ['create', '--source', '--destination', destination], ['verify', '--directory', destination, '--json'],
  ]) failure(await run(t, args, context), 'VALIDATION_ERROR', 2);
  for (const bad of ['relative', '', `${context.root}/../source`, `${source}/`, '-']) {
    failure(await run(t, ['verify', '--directory', bad], context), 'WORKSPACE_BACKUP_INVALID_PATH', 2);
  }
  assert.equal(await exists(destination), false);
  assert.equal(await exists(source), false);
});

test('offline CLI creates and verifies a real closed workspace without reading credentials or changing source bytes', {timeout: 30_000}, async t => {
  const context = await sandbox(t), f = await fixture(t, context);
  const destination = path.join(context.root, 'new-backup');
  const sourceDatabase = await readFile(path.join(f.source, 'workbench.sqlite'));
  const sourceMedia = await readFile(f.media);
  const created = success(await run(t, ['create', '--destination', destination, '--source', f.source], context));
  assert.equal(workspaceBackupResultSchema.safeParse(created).success, true);
  assert.equal(created.integrity, 'verified');
  assert.equal(created.restoration, 'not_tested');
  assert.equal(created.inventory.complete, true);
  assert.equal(created.fileCount, 2);
  assert.deepEqual((await readdir(destination)).sort(), ['COMPLETE.json', 'manifest.json', 'payload']);
  assert.deepEqual((await readdir(path.join(destination, 'payload'))).sort(), ['media', 'workbench.sqlite']);
  assert.deepEqual(await readFile(path.join(destination, 'payload/workbench.sqlite')), sourceDatabase);
  assert.deepEqual(await readFile(path.join(destination, 'payload', f.assetRelative)), sourceMedia);
  assert.equal((await stat(destination)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(destination, 'payload/workbench.sqlite'))).mode & 0o777, 0o600);
  assert.ok(sourceDatabase.includes(Buffer.from(privateText)), 'whole database bytes retain private user text');
  const beforeVerify = await readdir(context.root);
  const verified = success(await run(t, ['verify', '--directory', destination], context));
  assert.deepEqual(verified, created);
  assert.deepEqual(await readdir(context.root), beforeVerify, 'verification cleans its owned temporary sibling');
  assert.deepEqual(await readFile(path.join(f.source, 'workbench.sqlite')), sourceDatabase);
  assert.deepEqual(await readFile(f.media), sourceMedia);
  assert.equal(await exists(path.join(f.source, 'server.lock')), false);
  assert.equal(await exists(path.join(f.source, 'workbench.sqlite-wal')), false);
});

test('offline CLI refusals preserve existing destinations and foreign locks and suppress private paths', {timeout: 30_000}, async t => {
  const context = await sandbox(t), f = await fixture(t, context);
  const existing = path.join(context.root, 'existing');
  await mkdir(existing, {mode: 0o700});
  await writeFile(path.join(existing, 'keep.txt'), privateText, {mode: 0o600});
  const cases = [
    {args: ['create', '--source', f.source, '--destination', existing], code: 'WORKSPACE_BACKUP_DESTINATION_EXISTS'},
    {args: ['verify', '--directory', existing], code: 'WORKSPACE_BACKUP_INCOMPLETE'},
    {args: ['create', '--source', f.source, '--destination', path.join(f.source, 'nested')], code: 'WORKSPACE_BACKUP_INVALID_PATH', exit: 2},
  ];
  for (const item of cases) {
    const result = await run(t, item.args, context);
    failure(result, item.code, item.exit);
    assert.ok(!result.stdout.includes(context.root));
    assert.ok(!result.stderr.includes(context.root));
  }
  const lock = path.join(f.source, 'server.lock');
  await writeFile(lock, '999999999', {mode: 0o600});
  failure(await run(t, ['create', '--source', f.source, '--destination', path.join(context.root, 'locked')], context), 'WORKSPACE_BACKUP_LOCKED');
  assert.equal(await readFile(lock, 'utf8'), '999999999', 'offline capture never reclaims even a stale-looking lock');
  await rm(lock);
  const wal = path.join(f.source, 'workbench.sqlite-wal');
  await writeFile(wal, 'uncheckpointed fixture', {mode: 0o600});
  failure(await run(t, ['create', '--source', f.source, '--destination', path.join(context.root, 'warm')], context), 'WORKSPACE_BACKUP_NOT_COLD');
  assert.equal(await readFile(wal, 'utf8'), 'uncheckpointed fixture');
  assert.equal(await exists(lock), false);
  assert.equal(await readFile(path.join(existing, 'keep.txt'), 'utf8'), privateText);
});

test('offline CLI emits a complete bounded inventory result larger than a pipe buffer', {timeout: 30_000}, async t => {
  const context = await sandbox(t), f = await fixture(t, context);
  for (let index = 0; index < 105; index++) {
    await writeFile(path.join(f.source, 'media', `unregistered-${String(index).padStart(3, '0')}-${'x'.repeat(170)}.txt`), 'excluded', {mode: 0o600});
  }
  const result = await run(t, ['create', '--source', f.source, '--destination', path.join(context.root, 'bounded-inventory')], context);
  const data = success(result);
  assert.equal(workspaceBackupResultSchema.safeParse(data).success, true);
  assert.equal(data.inventory.complete, false);
  assert.equal(data.inventory.issues.length, 100);
  assert.equal(data.inventory.totalIssues, 105);
  assert.equal(data.inventory.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) > 16 * 1024);
});

test('offline CLI reports corrupt payload and private-storage refusal through bounded safe diagnostics', {timeout: 30_000}, async t => {
  const context = await sandbox(t), f = await fixture(t, context);
  const destination = path.join(context.root, 'backup');
  success(await run(t, ['create', '--source', f.source, '--destination', destination], context));
  await writeFile(path.join(destination, 'payload', f.assetRelative), 'modified bytes', {mode: 0o600});
  failure(await run(t, ['verify', '--directory', destination], context), 'WORKSPACE_BACKUP_CORRUPT');
  await chmod(f.source, 0o755);
  try {
    const result = await run(t, ['create', '--source', f.source, '--destination', path.join(context.root, 'unsafe')], context);
    failure(result, 'STORAGE_PRIVATE_REQUIRED');
    assert.ok(!result.stdout.includes(context.root));
    assert.ok(!result.stderr.includes(context.root));
  } finally {await chmod(f.source, 0o700);}
});

test('offline CLI preserves publication uncertainty without raw exception details or automatic retry', {timeout: 30_000}, async t => {
  const context = await sandbox(t), f = await fixture(t, context);
  const destination = path.join(context.root, 'publication-uncertain');
  const faultGuard = path.join(context.root, 'publication-fault.mjs');
  await writeFile(faultGuard, `${offlineGuard}\n
const originalLink = fs.linkSync, originalUnlink = fs.unlinkSync, originalFsync = fs.fsyncSync;
let published = false;
fs.linkSync = function(from, to) {
  const value = originalLink(from, to);
  if (path.basename(to) === 'COMPLETE.json') published = true;
  return value;
};
fs.fsyncSync = function(fd) {
  if (published) throw Error(${JSON.stringify(`${secret} ${context.root}`)});
  return originalFsync(fd);
};
fs.unlinkSync = function(file) {
  if (published && path.basename(file) === 'COMPLETE.json') throw Error(${JSON.stringify(`${secret} ${context.root}`)});
  return originalUnlink(file);
};
syncBuiltinESMExports();
`, {mode: 0o600});
  const result = await run(t, ['create', '--source', f.source, '--destination', destination], {...context, guard: faultGuard});
  const error = failure(result, 'WORKSPACE_BACKUP_PUBLICATION_UNCONFIRMED');
  assert.match(error.message, /may contain a published backup/);
  assert.match(error.message, /Preserve this destination/);
  assert.match(error.message, /separate verify command/);
  assert.match(error.message, /marker presence alone is not proof/);
  assert.ok(!result.stdout.includes(context.root));
  assert.ok(!result.stderr.includes(context.root));
  assert.equal(await exists(path.join(destination, 'COMPLETE.json')), true);
  assert.equal(await exists(path.join(f.source, 'server.lock')), false);
  success(await run(t, ['verify', '--directory', destination], context));
});

test('offline CLI reports unconfirmed source lock cleanup without reversing a published backup or replacing an error', {timeout: 30_000}, async t => {
  const context = await sandbox(t), f = await fixture(t, context);
  const destination = path.join(context.root, 'cleanup-uncertain');
  const lock = path.join(f.source, 'server.lock');
  const faultGuard = path.join(context.root, 'cleanup-fault.mjs');
  await writeFile(faultGuard, `${offlineGuard}\n
const originalUnlink = fs.unlinkSync;
fs.unlinkSync = function(file) {
  if (file === ${JSON.stringify(lock)}) throw Error(${JSON.stringify(`${secret} ${context.root}`)});
  return originalUnlink(file);
};
syncBuiltinESMExports();
`, {mode: 0o600});
  const guarded = {...context, guard: faultGuard};
  const created = success(await run(t, ['create', '--source', f.source, '--destination', destination], guarded));
  assert.deepEqual(created.warnings, ['SOURCE_LOCK_RELEASE_UNCONFIRMED']);
  assert.equal(created.integrity, 'verified');
  assert.equal(await exists(path.join(destination, 'COMPLETE.json')), true);
  assert.equal(await exists(lock), true);
  const verified = success(await run(t, ['verify', '--directory', destination], context));
  assert.equal(verified.backupId, created.backupId);
  assert.equal(verified.integrity, 'verified');
  // Test-owned fixture cleanup only; the CLI never removes this retained lock.
  await rm(lock);
  const failed = await run(t, ['create', '--source', f.source, '--destination', destination], guarded);
  failure(failed, 'WORKSPACE_BACKUP_DESTINATION_EXISTS', 1, {sourceLockRelease: 'unconfirmed'});
  assert.equal(await exists(lock), true);
  assert.equal(await exists(path.join(destination, 'COMPLETE.json')), true);
  assert.ok(!failed.stdout.includes(context.root));
  assert.ok(!failed.stderr.includes(context.root));
});

for (const [signal, exit] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`offline CLI ${signal} waits for owned lock cleanup and leaves no complete marker`, {timeout: 30_000}, async t => {
    const context = await sandbox(t), f = await fixture(t, context, {large: true});
    const destination = path.join(context.root, 'interrupted');
    const owned = startCli(t, ['create', '--source', f.source, '--destination', destination], context);
    const deadline = Date.now() + 15_000;
    for (;;) {
      let copied = 0;
      try {copied = (await stat(path.join(destination, 'payload', f.assetRelative))).size;}
      catch (error) {if (error.code !== 'ENOENT') throw error;}
      if (copied > 0) break;
      assert.equal(owned.isClosed(), false, 'copy should still be running when interrupted');
      assert.ok(Date.now() < deadline, 'copy began within the bounded wait');
      await pause(2);
    }
    assert.equal(owned.child.kill(signal), true);
    failure(await resultFor(owned), 'WORKSPACE_BACKUP_CANCELLED', exit);
    assert.equal(await exists(path.join(f.source, 'server.lock')), false);
    assert.equal(await exists(path.join(destination, 'COMPLETE.json')), false);
    assert.equal(await exists(destination), true, 'interrupted destination is retained for explicit review');
    assert.ok((await readdir(destination)).every(name => !name.startsWith('.inspection-')));
    failure(await run(t, ['verify', '--directory', destination], context), 'WORKSPACE_BACKUP_INCOMPLETE');
    failure(await run(t, ['create', '--source', f.source, '--destination', destination], context), 'WORKSPACE_BACKUP_DESTINATION_EXISTS');
  });
}

test('offline CLI imports are inert and only attach operation-scoped signal listeners', async () => {
  const signals = ['SIGINT', 'SIGTERM', 'exit', 'beforeExit', 'uncaughtException', 'unhandledRejection'];
  const before = signals.map(signal => process.listenerCount(signal));
  const {parseBackupArguments} = await import('../apps/cli/src/backup.mjs');
  assert.deepEqual(signals.map(signal => process.listenerCount(signal)), before);
  assert.deepEqual(parseBackupArguments(['--help']), {command: 'help'});
  assert.throws(() => parseBackupArguments(['verify', '--directory', '/tmp/\0private']), {code: 'WORKSPACE_BACKUP_INVALID_PATH'});
  const source = await readFile(entry, 'utf8');
  assert.ok(!/process\.env|createServices|startServer|process\.exit\(/.test(source));
  assert.ok(!/process\.(?:on|once)\(['"](?:exit|beforeExit|uncaughtException|unhandledRejection)/.test(source));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {opacityBackupFixture, tree} from './helpers/opacity-backup-fixture.mjs';
import {opacityWorkspaceBackupResultSchema, opacityWorkspaceRestoreResultSchema, opacityWorkspaceRestoreStatusSchema} from '../packages/contracts/src/opacity-candidate-backup.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const entry = path.join(repo, 'apps/cli/src/opacity-backup.ts');
const legacy = path.join(repo, 'apps/cli/src/backup.ts');
const secret = 'SYNTHETIC_CLI_CREDENTIAL_NEVER_LIVE';
const guards = ['BOUNDARY', 'NETWORK', 'SUBPROCESS', 'CREDENTIAL_ENV', 'CREDENTIAL_FILE'];

/** Every command runs the actual CLI in an isolated child. A boundary failure
 * records evidence outside sanitized diagnostics, so a caught error cannot
 * disguise an attempted provider/media/network/credential operation. */
function guardFor(base, extra = '') {
  const guard = path.join(base, `guard-${fs.readdirSync(base).filter(name => name.startsWith('guard-')).length}.ts`);
  const violations = path.join(base, 'guard-violations.jsonl');
  fs.writeFileSync(guard, `
import {registerHooks,syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs';
import cp from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const violate = kind => {fs.appendFileSync(${JSON.stringify(violations)},kind+'\\n',{mode:0o600});throw Error('OFFLINE_'+kind+'_VIOLATION');};
registerHooks({resolve(specifier,context,nextResolve){const resolved=nextResolve(specifier,context);
 if(/^(?:node:)?(?:http|https|http2|net|tls|dns)(?:\\/|$)/.test(resolved.url)||/\\/packages\\/(?:client|server)\\//.test(resolved.url)||/\\/packages\\/business\\/src\\/(?:index|services)\\.mjs$/.test(resolved.url)||/\\/apps\\/(?:server|mcp)\\//.test(resolved.url))violate('BOUNDARY');
 return resolved;}});
globalThis.fetch=()=>violate('NETWORK');
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=()=>violate('SUBPROCESS');
process.env=new Proxy(process.env,{get(target,name){if(typeof name==='string'&&/^(?:MIOON_|RUNWAY|ARK_|VEO_|OPENAI_API|GOOGLE_API|MINIMAX|VIDU)/.test(name))violate('CREDENTIAL_ENV');return Reflect.get(target,name);}});
const guardPath=value=>{if(value instanceof URL)value=fileURLToPath(value);if(typeof value==='string'&&/^(?:access-token|mcp-connection\\.json|settings\\.json|custom-settings\\.json)$/.test(path.basename(value)))violate('CREDENTIAL_FILE');};
for(const name of ['readFileSync','openSync','readFile','open']){const original=fs[name];fs[name]=function(value,...args){guardPath(value);return Reflect.apply(original,this,[value,...args]);};}
for(const name of ['readFile','open']){const original=fs.promises[name];fs.promises[name]=function(value,...args){guardPath(value);return Reflect.apply(original,this,[value,...args]);};}
${extra}
syncBuiltinESMExports();
`, {mode: 0o600});
  return {guard, violations};
}

async function run(t, f, args, {target = entry, extra = ''} = {}) {
  const {guard, violations} = guardFor(f.base, extra);
  const child = spawn(process.execPath, ['--import', guard, target, ...args], {cwd: repo,
    env: {...process.env, MIOON_TOKEN: secret, MIOON_DATA_DIR: path.join(f.base, 'must-not-read-default-workspace'), MIOON_TOKEN_FILE: path.join(f.base, 'access-token'), MIOON_BASE_URL: 'https://must-not-contact.invalid'},
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, killSignal: 'SIGTERM'});
  let stdout = '', stderr = '', closed = false;
  child.stdout.setEncoding('utf8').on('data', chunk => {stdout += chunk;});
  child.stderr.setEncoding('utf8').on('data', chunk => {stderr += chunk;});
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {closed = true; resolve({code, signal});});
  });
  t.after(async () => {if (!closed) child.kill('SIGTERM'); await completion;});
  const result = await completion;
  assert.equal(fs.existsSync(violations), false, 'zero offline boundary attempts, including safely caught exceptions');
  assert.equal(result.signal, null, stdout + stderr);
  assert.ok(Buffer.byteLength(stdout) + Buffer.byteLength(stderr) < 256 * 1024);
  for (const forbidden of [secret, ...guards.map(name => 'OFFLINE_' + name + '_VIOLATION')]) {
    assert.ok(!stdout.includes(forbidden)); assert.ok(!stderr.includes(forbidden));
  }
  const lines = stdout.trim().split('\n'); assert.equal(lines.length, 1, stdout + stderr);
  return {...result, stdout, stderr, body: JSON.parse(lines[0])};
}

function success(result) {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(Object.keys(result.body).sort(), ['data', 'ok']); assert.equal(result.body.ok, true);
  return result.body.data;
}
function failure(result, code, exit = 1) {
  assert.equal(result.code, exit, result.stdout + result.stderr); assert.equal(result.body.ok, false);
  assert.equal(result.body.error.code, code); assert.equal(result.body.error.retryable, false);
  assert.ok(result.stderr.includes(code)); assert.ok(!result.stdout.includes(repo));
  return result.body.error;
}

test('candidate offline help has four locales, accurate fixed42→43 boundaries and explicit draft exclusion', {timeout: 30_000}, async t => {
  const f = await opacityBackupFixture(t), before = tree(f.source);
  const notices = {'zh-Hans': 'v3 未保存草稿不备份、不恢复', 'zh-Hant': 'v3 未儲存草稿不備份、不還原', en: 'Unsaved v3 drafts are excluded from backup and restore', ja: '未保存の v3 下書きはバックアップ・復元の対象外'};
  for (const [locale, notice] of Object.entries(notices)) {
    for (const args of [['--help', '--locale', locale], ['restore', '--help', `--locale=${locale}`]]) {
      const result = await run(t, f, args), data = success(result), text = JSON.stringify(data);
      assert.equal(data.name, 'mioon-opacity-backup'); assert.equal(data.locale, locale);
      assert.equal(data.offline, true); assert.equal(data.sourceSchema, 42); assert.equal(data.restoredSchema, 43); assert.equal(data.draftPolicy, 'excluded');
      assert.ok(data.usage.every(value => value.startsWith('node apps/cli/src/opacity-backup.ts ')));
      assert.ok(text.includes(notice)); assert.ok(text.includes('restored-local-v10')); assert.ok(text.includes('held')); assert.ok(text.includes('epoch')); assert.ok(text.includes('origin'));
      assert.ok(text.includes('40/41')); assert.ok(text.includes('token') || text.includes('Tokens'));
      assert.ok(data.safety.some(value => value.includes('--open-restored-workspace') && value.includes('43')), 'each locale documents the separate explicit restored43 application entry');
      for (const stale of ['仍不接受43', 'still refuses43', '引き続き43を拒否']) assert.ok(!text.includes(stale));
      assert.ok(!text.includes('schema24')); assert.ok(!text.includes('schema25')); assert.equal(result.stderr, '');
    }
  }
  assert.equal(success(await run(t, f, [])).locale, 'zh-Hans');
  const metadata = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  assert.deepEqual(success(await run(t, f, ['--version'])), {name: 'mioon-opacity-backup', version: metadata.version});
  assert.deepEqual(tree(f.source), before, 'help/version do not open or alter any workspace');
});

test('actual candidate CLI cold roundtrip preserves media/opacity/history and exposes both read-only status modes', {timeout: 30_000}, async t => {
  const f = await opacityBackupFixture(t), sourceBefore = tree(f.source);
  fs.writeFileSync(path.join(f.source, 'access-token'), secret, {mode: 0o600});
  const withToken = tree(f.source);
  const createdResult = await run(t, f, ['create', '--source', f.source, '--destination', f.backup]);
  const created = success(createdResult); assert.equal(opacityWorkspaceBackupResultSchema.safeParse(created).success, true);
  assert.match(createdResult.stderr, /v3 未保存草稿不备份、不恢复/); assert.match(createdResult.stderr, /源草稿和源工作区保留/);
  assert.equal(created.draftPolicy, 'excluded'); assert.deepEqual(success(await run(t, f, ['verify', '--directory', f.backup])), created);
  const backupBefore = tree(f.backup), restoredResult = await run(t, f, ['restore', '--directory', f.backup, '--destination', f.destination, '--locale', 'en']);
  const restored = success(restoredResult); assert.equal(opacityWorkspaceRestoreResultSchema.safeParse(restored).success, true);
  assert.match(restoredResult.stderr, /Unsaved v3 drafts are excluded from backup and restore/); assert.match(restoredResult.stderr, /source drafts and the source workspace remain/);
  assert.equal(restored.sourceSchema, 42); assert.equal(restored.databaseSchemaVersion, 43); assert.equal(restored.heldCounts.edit_tasks, 1);
  const observed = success(await run(t, f, ['restore-status', '--directory', f.backup, '--destination', f.destination]));
  const exact = success(await run(t, f, ['restore-status', '--destination', f.destination, '--restoration-id', restored.restorationId, '--backup-id', restored.sourceBackupId, '--manifest-hash', restored.manifestHash, '--source-db-hash', restored.sourceDbHash]));
  assert.equal(opacityWorkspaceRestoreStatusSchema.safeParse(observed).success, true); assert.deepEqual(observed, exact);
  assert.equal(observed.publication, 'observed_guarded'); assert.equal(observed.durability, 'not_reconfirmed'); assert.equal(observed.draftPolicy, 'excluded');
  assert.deepEqual(tree(f.source), withToken); assert.deepEqual(tree(f.backup), backupBefore);
  assert.deepEqual(fs.readFileSync(path.join(f.destination, f.relativePath)), f.mediaBytes);
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'local-drafts-v3.json')), f.draftBytes);
  for (const excluded of ['local-drafts-v3.json', 'access-token', 'mcp-connection.json']) assert.equal(fs.existsSync(path.join(f.destination, excluded)), false);
  const db = new DatabaseSync(path.join(f.destination, 'workbench.sqlite'), {readOnly: true});
  try {
    assert.equal(db.prepare('SELECT data FROM timelines WHERE id=?').get(f.timelineId).data, f.timelineText);
    assert.equal(db.prepare('SELECT beforeSnapshot FROM workspace_restore_timeline_history').get().beforeSnapshot, f.historyBefore);
    assert.equal(db.prepare('SELECT afterSnapshot FROM workspace_restore_timeline_history').get().afterSnapshot, f.historyAfter);
    assert.equal(db.prepare('SELECT input FROM edit_tasks WHERE id=?').get(f.taskId).input, f.taskText);
    assert.equal(db.prepare('SELECT executionEpoch FROM edit_tasks WHERE id=?').get(f.taskId).executionEpoch, 'captured');
  } finally {db.close();}
  assert.ok(sourceBefore.length > 0); assert.equal(fs.existsSync(path.join(f.destination, 'server.lock')), false);
});

test('candidate CLI preserves original parser validation and identifies its own localized usage', {timeout: 30_000}, async t => {
  const f = await opacityBackupFixture(t), absent = path.join(f.base, 'must-not-create');
  for (const args of [
    ['create'], ['verify'], ['restore'], ['restore-status'], ['start'], ['--help', '--version'],
    ['create', '--source', f.source, '--source', f.source, '--destination', absent],
    ['verify', '--directory', f.backup, '--token', secret], ['verify', '--directory'], ['verify', '--directory', '--locale', 'en'],
    ['--locale', 'zh-TW', '--help'], ['--locale', 'en', '--locale', 'ja', '--help'],
    ['restore-status', '--destination', absent, '--restoration-id', 'invalid'],
  ]) {
    const result = await run(t, f, args), error = failure(result, 'VALIDATION_ERROR', 2);
    assert.match(error.message, /apps\/cli\/src\/opacity-backup\.ts --help/); assert.ok(!error.message.includes('backup.ts'));
  }
  for (const bad of ['relative', `${f.base}/../source`, `${f.source}/`]) failure(await run(t, f, ['verify', '--directory', bad]), 'WORKSPACE_BACKUP_INVALID_PATH', 2);
  assert.equal(fs.existsSync(absent), false);
});

test('successful create and restore also disclose excluded drafts in Traditional Chinese and Japanese', {timeout: 30_000}, async t => {
  const f = await opacityBackupFixture(t);
  const pairs = [
    ['zh-Hant', 'ja', /v3 未儲存草稿不備份、不還原/, /未保存の v3 下書きはバックアップ・復元の対象外/],
    ['ja', 'zh-Hant', /未保存の v3 下書きはバックアップ・復元の対象外/, /v3 未儲存草稿不備份、不還原/],
  ];
  for (const [createLocale, restoreLocale, createNotice, restoreNotice] of pairs) {
    const backup = path.join(f.base, `notice-backup-${createLocale}`), destination = path.join(f.base, `notice-restored-${restoreLocale}`);
    const created = await run(t, f, ['create', '--source', f.source, '--destination', backup, '--locale', createLocale]);
    assert.equal(success(created).draftPolicy, 'excluded'); assert.match(created.stderr, createNotice);
    const restored = await run(t, f, ['restore', '--directory', backup, '--destination', destination, '--locale', restoreLocale]);
    assert.equal(success(restored).draftPolicy, 'excluded'); assert.match(restored.stderr, restoreNotice);
  }
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'local-drafts-v3.json')), f.draftBytes);
});

test('candidate CLI refuses corruption, occupied sources and existing targets without overwriting or leaking private paths', {timeout: 30_000}, async t => {
  const f = await opacityBackupFixture(t), foreignLock = path.join(f.source, 'server.lock');
  fs.writeFileSync(foreignLock, 'synthetic-foreign-lock', {mode: 0o600});
  failure(await run(t, f, ['create', '--source', f.source, '--destination', f.backup]), 'WORKSPACE_BACKUP_LOCKED');
  assert.equal(fs.readFileSync(foreignLock, 'utf8'), 'synthetic-foreign-lock'); fs.unlinkSync(foreignLock);
  success(await run(t, f, ['create', '--source', f.source, '--destination', f.backup]));
  fs.mkdirSync(f.destination, {mode: 0o700}); fs.writeFileSync(path.join(f.destination, 'retain'), 'owned existing target', {mode: 0o600});
  const targetBefore = tree(f.destination);
  const collision = failure(await run(t, f, ['restore', '--directory', f.backup, '--destination', f.destination]), 'WORKSPACE_RESTORE_DESTINATION_EXISTS');
  assert.deepEqual(tree(f.destination), targetBefore); assert.ok(!collision.message.includes(f.base));
  fs.writeFileSync(path.join(f.backup, 'payload', f.relativePath), 'changed bytes', {mode: 0o600});
  const corrupted = await run(t, f, ['verify', '--directory', f.backup]); failure(corrupted, 'WORKSPACE_BACKUP_CORRUPT');
  assert.ok(!corrupted.stdout.includes(f.base)); assert.ok(!corrupted.stderr.includes(f.base));
});

test('candidate CLI preserves sanitized uncertain-publication binding for read-only status rather than retrying', {timeout: 30_000}, async t => {
  const f = await opacityBackupFixture(t); success(await run(t, f, ['create', '--source', f.source, '--destination', f.backup]));
  const extra = `
const originalLink=fs.linkSync,originalFsync=fs.fsyncSync;let published=false;
fs.linkSync=function(from,to){const value=originalLink(from,to);if(to===${JSON.stringify(path.join(f.destination, 'workbench.sqlite'))})published=true;return value;};
fs.fsyncSync=function(fd){if(published&&fs.fstatSync(fd).isDirectory())throw Error(${JSON.stringify(secret + ' ' + f.base)});return originalFsync(fd);};
`;
  const result = await run(t, f, ['restore', '--directory', f.backup, '--destination', f.destination], {extra});
  const error = failure(result, 'WORKSPACE_RESTORE_PUBLICATION_UNCONFIRMED');
  assert.equal(error.details.publication.state, 'unconfirmed'); assert.equal(error.details.publication.manifestHash.length, 64);
  assert.ok(!result.stdout.includes(f.base)); assert.ok(!result.stderr.includes(f.base));
  const before = tree(f.destination), observed = success(await run(t, f, ['restore-status', '--directory', f.backup, '--destination', f.destination]));
  assert.equal(observed.restorationId, error.details.publication.restorationId); assert.equal(observed.durability, 'not_reconfirmed');
  assert.deepEqual(tree(f.destination), before);
});

test('ordinary offline CLI keeps its original help and rejects fixed42 archives/workspaces', {timeout: 30_000}, async t => {
  const f = await opacityBackupFixture(t);
  const ordinary = success(await run(t, f, ['--help'], {target: legacy}));
  assert.equal(ordinary.name, 'mioon-backup'); assert.ok(JSON.stringify(ordinary).includes('classified schema24'));
  // The original classifier's unsupported-schema error is intentionally not
  // added to its CLI allowlist: preserve its existing generic safe refusal.
  failure(await run(t, f, ['create', '--source', f.source, '--destination', f.backup], {target: legacy}), 'WORKSPACE_BACKUP_IO');
  assert.equal(fs.existsSync(f.backup), false);
  success(await run(t, f, ['create', '--source', f.source, '--destination', f.backup]));
  failure(await run(t, f, ['verify', '--directory', f.backup], {target: legacy}), 'WORKSPACE_BACKUP_CORRUPT');
  failure(await run(t, f, ['restore', '--directory', f.backup, '--destination', f.destination], {target: legacy}), 'WORKSPACE_BACKUP_CORRUPT');
  assert.equal(fs.existsSync(f.destination), false);
});

test('candidate CLI import is inert and preserves scoped listener lifecycle', async () => {
  const signals = ['SIGINT', 'SIGTERM', 'exit', 'beforeExit', 'uncaughtException', 'unhandledRejection'];
  const before = signals.map(signal => process.listenerCount(signal));
  const module = await import('../apps/cli/src/opacity-backup.ts');
  assert.equal(typeof module.runOpacityBackupCli, 'function'); assert.deepEqual(signals.map(signal => process.listenerCount(signal)), before);
  const source = fs.readFileSync(entry, 'utf8');
  assert.ok(!/process\.env|process\.exit\(|createServices|startServer/.test(source));
  assert.ok(!/process\.(?:on|once)\(['"](?:exit|beforeExit|uncaughtException|unhandledRejection)/.test(source));
  assert.match(source, /process\.removeListener\('SIGINT'/); assert.match(source, /process\.removeListener\('SIGTERM'/);
});

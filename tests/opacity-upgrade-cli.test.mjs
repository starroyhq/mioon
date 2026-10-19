import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseOpacityUpgradeArguments, opacityUpgradeHelp, safeOpacityUpgradeError} from '../apps/cli/src/opacity-upgrade.ts';
import {OPACITY_UPGRADE_ERROR_CODES, opacityWorkspaceUpgradeInputSchema, opacityWorkspaceUpgradeResultSchema} from '../packages/contracts/src/opacity-upgrade.ts';
import {createWorkspaceBackup} from '../packages/business/src/workspace-backup.mjs';
import {opacityUpgradeFixture, upgradeFixtureHash} from './helpers/opacity-upgrade-fixture.mjs';
import {tree} from './helpers/opacity-backup-fixture.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url)), entry = path.join(repo, 'apps/cli/src/opacity-upgrade.ts');
const languages = ['zh-Hans', 'zh-Hant', 'en', 'ja'];
const binding = {sourceBackupId: '12345678-1234-4234-8234-123456789abc', manifestHash: 'a'.repeat(64), sourceDbHash: 'b'.repeat(64), targetDbHash: 'c'.repeat(64)};
const result = {sourceVersion: 40, targetVersion: 42, profile: 'ordinary', ...binding, fileCount: 1, payloadBytes: 4096,
  preferencePolicy: 'preserved', draftPolicy: 'excluded-empty-only', taskPolicy: 'settled-only', sourcePolicy: 'unchanged', publication: 'confirmed'};
const valid = ['upgrade', '--source', '/synthetic/source40', '--backup', '/synthetic/verified40-backup', '--destination', '/synthetic/new42', '--channel', 'web'];

test('offline upgrade parser requires every explicit input, exact channels and region-neutral languages', () => {
  for (const channel of ['web', 'development', 'production']) {
    const args = [...valid.slice(0, -1), channel];
    const parsed = parseOpacityUpgradeArguments(args);
    assert.deepEqual(parsed, {command: 'upgrade', locale: 'zh-Hans', source: valid[2], backup: valid[4], destination: valid[6], channel});
    for (const locale of languages) {
      assert.equal(parseOpacityUpgradeArguments(['--lang', locale, ...args]).locale, locale);
      assert.equal(parseOpacityUpgradeArguments([...args, `--lang=${locale}`]).locale, locale);
    }
  }
  for (const args of [
    ['upgrade'], valid.slice(0, -2), [...valid, '--token', 'SYNTHETIC_SECRET'], [...valid, '--source', '/other'],
    [...valid, '--channel', 'web'], [...valid, '--lang', 'zh-TW'], [...valid, '--lang', 'zh-CN'], [...valid, '--lang', 'en', '--lang', 'ja'],
    ['upgrade', '--source', '--lang', 'en', '/source', ...valid.slice(3)], [...valid.slice(0, -1), 'unknown'],
    ['start', ...valid.slice(1)], ['restore', ...valid.slice(1)], ['--version'], ['--help', '--version'], ['schema', '--source', '/source'],
    ['upgrade', '--source=/source', ...valid.slice(3)], [...valid, '--settings', '/private/settings'], [...valid, '--locale', 'en'],
  ]) assert.throws(() => parseOpacityUpgradeArguments(args), {code: 'VALIDATION_ERROR'});
  for (const args of [[], ['--help'], ['help'], ['upgrade', '--help']]) assert.equal(parseOpacityUpgradeArguments(args).command, 'help');
  assert.equal(parseOpacityUpgradeArguments(['schema', '--lang', 'ja']).command, 'schema');
});

test('upgrade result strictly binds ordinary40 to ordinary42 with explicit preservation and cleanup policies', () => {
  assert.equal(opacityWorkspaceUpgradeResultSchema.safeParse(result).success, true);
  assert.equal(opacityWorkspaceUpgradeResultSchema.safeParse({...result, warnings: ['SOURCE_LOCK_RELEASE_UNCONFIRMED', 'DESTINATION_LOCK_RELEASE_UNCONFIRMED']}).success, true);
  for (const patch of [
    {sourceVersion: 41}, {sourceVersion: 42}, {targetVersion: 43}, {profile: 'restored-local-v10'}, {publication: 'observed'},
    {preferencePolicy: 'excluded'}, {draftPolicy: 'excluded'}, {taskPolicy: 'held'}, {sourcePolicy: 'modified'},
    {sourceDbHash: '../private'}, {sourceBackupId: 'not-uuid'}, {targetDbHash: 'A'.repeat(64)}, {fileCount: 0}, {fileCount: 20_001},
    {payloadBytes: 0}, {payloadBytes: 64 * 1024 * 1024 * 1024 + 1}, {warnings: []}, {warnings: ['unknown']},
    {warnings: ['SOURCE_LOCK_RELEASE_UNCONFIRMED', 'SOURCE_LOCK_RELEASE_UNCONFIRMED']}, {unexpected: true},
  ]) assert.equal(opacityWorkspaceUpgradeResultSchema.safeParse({...result, ...patch}).success, false, JSON.stringify(patch));
  assert.equal(opacityWorkspaceUpgradeInputSchema.safeParse({source: '/source', backup: '/backup', destination: '/new42', channel: 'web', token: 'NO'}).success, false);
});

test('all four help copies disclose read-only existing backup, preservation, qualifications and remaining acceptance', () => {
  for (const locale of languages) {
    const help = opacityUpgradeHelp(locale), text = JSON.stringify(help);
    assert.equal(help.locale, locale); assert.equal(help.sourceVersion, 40); assert.equal(help.targetVersion, 42); assert.equal(help.profile, 'ordinary'); assert.equal(help.offline, true);
    assert.equal(help.draftPolicy, 'excluded-empty-only'); assert.equal(help.taskPolicy, 'settled-only'); assert.equal(help.preferencePolicy, 'preserved');
    for (const term of ['existing-verified40-backup', 'schema40', 'restored41', 'restored43', 'last-project', 'scope', 'token', 'origin', 'epoch', 'pending', 'held', 'sequence export', 'generated asset', 'SIGINT', 'SIGTERM', 'GUI', 'timeline.track.add/update', 'timeline.clip.add/update/remove', 'timeline.undo/redo']) assert.ok(text.toLowerCase().includes(term.toLowerCase()), `${locale}: ${term}`);
    assert.ok(help.usage.every(line => line.startsWith('node apps/cli/src/opacity-upgrade.ts ')));
    assert.ok(help.preservation.some(line => line.includes('last-project') && line.includes('development')), 'target preference scope matches the candidate launcher');
    assert.doesNotMatch(text, /zh-TW|zh-HK|zh-CN|SIGKILL|--force|--in-place/u);
    assert.notEqual(help.requirements[0], opacityUpgradeHelp(locale === 'en' ? 'ja' : 'en').requirements[0]);
  }
});

test('fixed error messages are localized and never disclose unknown errors, getters or private text', () => {
  const secret = '/private/workspace SECRET_SQLITE_ROW provider-key';
  for (const locale of languages) for (const code of ['VALIDATION_ERROR', ...OPACITY_UPGRADE_ERROR_CODES]) {
    const error = safeOpacityUpgradeError(Object.assign(new Error(secret), {code, details: {secret}, cause: new Error(secret)}), locale);
    assert.equal(error.code, code); assert.equal(error.retryable, false); assert.deepEqual(error.details, {});
    assert.ok(error.message.length > 10); assert.ok(!JSON.stringify(error).includes(secret));
    assert.notEqual(error.message, safeOpacityUpgradeError({code}, locale === 'en' ? 'ja' : 'en').message);
  }
  const unsupportedHints = {'zh-Hans': '旧任务操作', 'zh-Hant': '舊任務操作', en: 'Historical task operations', ja: '過去のタスク操作'};
  for (const [locale, hint] of Object.entries(unsupportedHints)) assert.ok(safeOpacityUpgradeError({code: 'WORKSPACE_UPGRADE_SOURCE_UNSUPPORTED'}, locale).message.includes(hint));
  for (const error of [new Error(secret), {code: secret, message: secret}, null, undefined, {get code() {throw new Error(secret);}}, new Proxy({}, {getOwnPropertyDescriptor() {throw new Error(secret);}})])
    assert.deepEqual(safeOpacityUpgradeError(error), safeOpacityUpgradeError({code: 'WORKSPACE_UPGRADE_IO'}));
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.deepEqual(safeOpacityUpgradeError(revoked.proxy), safeOpacityUpgradeError({code: 'WORKSPACE_UPGRADE_IO'}));
});

test('uncertain publication sanitizes exact generated binding and retains cleanup uncertainty without retry advice', () => {
  const error = safeOpacityUpgradeError({code: 'WORKSPACE_UPGRADE_PUBLICATION_UNCONFIRMED', cleanupUnconfirmed: true,
    publication: {state: 'unconfirmed', ...binding, path: '/private/never-output'}, details: {ignored: true}}, 'en');
  assert.deepEqual(error.details, {cleanupUnconfirmed: true, publication: {state: 'unconfirmed', ...binding}});
  assert.ok(!JSON.stringify(error).includes('/private')); assert.match(error.message, /Do not retry automatically/u);
  for (const patch of [{state: 'confirmed'}, {sourceBackupId: 'bad'}, {manifestHash: 'bad'}, {targetDbHash: 'bad'}]) {
    const value = safeOpacityUpgradeError({code: error.code, publication: {state: 'unconfirmed', ...binding, ...patch}});
    assert.deepEqual(value.details, {});
  }
  const {targetDbHash: ignored, ...withoutTarget} = binding;
  assert.deepEqual(safeOpacityUpgradeError({code: error.code, publication: {state: 'unconfirmed', ...withoutTarget}}).details.publication, {state: 'unconfirmed', ...withoutTarget});
  assert.deepEqual(safeOpacityUpgradeError({code: 'WORKSPACE_UPGRADE_IO', publication: {state: 'unconfirmed', ...binding}}).details, {});
});

async function isolated(t, args, business, allowOfflineBusiness = false) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mioon-upgrade-cli-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const guard = path.join(base, 'guard.mjs'), violations = path.join(base, 'violations'), called = path.join(base, 'called.json');
  fs.writeFileSync(guard, `
import {registerHooks,syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs';
import cp from 'node:child_process';
import path from 'node:path';
const violation=kind=>{fs.appendFileSync(${JSON.stringify(violations)},kind+'\\n');throw Error('OFFLINE_BOUNDARY');};
const business=${JSON.stringify(business ?? null)};
const allowOfflineBusiness=${JSON.stringify(allowOfflineBusiness)};
registerHooks({resolve(specifier,context,nextResolve){
 if(business!==null&&specifier.endsWith('/packages/business/src/opacity-upgrade.ts'))return {url:'fixture:upgrade',shortCircuit:true};
 const found=nextResolve(specifier,context);
 if(/^(?:node:)?(?:http|https|http2|net|tls|dns)(?:\\/|$)/u.test(found.url)||/\\/apps\\/(?:server|mcp)\\//u.test(found.url)||(/\\/packages\\/business\\//u.test(found.url)&&(!allowOfflineBusiness||/\\/(?:services|index)\\.mjs$/u.test(found.url))))violation('IMPORT');
 return found;
},load(url,context,nextLoad){if(url==='fixture:upgrade')return {format:'module',source:business,shortCircuit:true};return nextLoad(url,context);}});
globalThis.fetch=()=>violation('NETWORK');
for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[key]=()=>violation('PROCESS');
const guardPath=value=>{if(value instanceof URL)value=value.pathname;if(typeof value==='string'&&['access-token','settings.json','custom-settings.json','mcp-connection.json'].includes(path.basename(value)))violation('CREDENTIAL_FILE');};
for(const key of ['readFileSync','openSync','readFile','open']){const original=fs[key];fs[key]=function(value,...rest){guardPath(value);return Reflect.apply(original,this,[value,...rest]);};}
process.env=new Proxy(process.env,{get(target,key){if(typeof key==='string'&&/^(?:MIOON_|OPENAI_API|GOOGLE_API|RUNWAY|ARK_|VEO_|MINIMAX|VIDU)/u.test(key))violation('CREDENTIAL_ENV');return Reflect.get(target,key);}});
syncBuiltinESMExports();
`, {mode: 0o600});
  const child = spawn(process.execPath, ['--import', guard, entry, ...args], {cwd: repo, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', value => {stdout += value;}); child.stderr.setEncoding('utf8').on('data', value => {stderr += value;});
  // These finite local commands exit themselves; no signal, timeout kill or
  // process cleanup fallback is sent by the test runner.
  const closed = await new Promise((resolve, reject) => {child.once('error', reject); child.once('close', (code, signal) => resolve({code, signal}));});
  assert.equal(closed.signal, null, stdout + stderr); assert.equal(fs.existsSync(violations), false, 'no attempted offline boundary violation');
  assert.ok(Buffer.byteLength(stdout) + Buffer.byteLength(stderr) < 64 * 1024);
  const lines = stdout.trim().split('\n'); assert.equal(lines.length, 1, stdout + stderr);
  return {...closed, stdout, stderr, body: JSON.parse(lines[0]), called: fs.existsSync(called) ? JSON.parse(fs.readFileSync(called, 'utf8')) : null};
}

test('actual Node CLI help/schema stay inert and return one JSON envelope with no business imports', async t => {
  for (const locale of languages) {
    const output = await isolated(t, ['--help', '--lang', locale]);
    assert.equal(output.code, 0); assert.equal(output.body.ok, true); assert.deepEqual(output.body.data, opacityUpgradeHelp(locale)); assert.equal(output.stderr, '');
  }
  const output = await isolated(t, ['schema']);
  assert.equal(output.code, 0); assert.equal(output.body.ok, true); assert.equal(output.stderr, '');
  assert.equal(output.body.data.input.additionalProperties, false); assert.deepEqual(output.body.data.input.required, ['source', 'backup', 'destination', 'channel']);
  assert.equal(output.body.data.input.properties.backup.format, 'canonical-absolute-verified40-backup-path');
  assert.deepEqual(output.body.data.errors, ['VALIDATION_ERROR', ...OPACITY_UPGRADE_ERROR_CODES]);
  for (const locale of languages) {
    const invalid = await isolated(t, ['upgrade', '--lang', locale]);
    assert.equal(invalid.code, 2); assert.equal(invalid.body.ok, false); assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
    assert.equal(invalid.body.error.message, safeOpacityUpgradeError({code: 'VALIDATION_ERROR'}, locale).message); assert.match(invalid.stderr, /^VALIDATION_ERROR:/u);
  }
});

test('actual CLI runner adapter checks exact arguments, result schema, cancellation and scoped listeners without executing a workspace', async t => {
  const expected = {source: valid[2], backup: valid[4], destination: valid[6], channel: 'web'};
  const successful = `export async function upgradeOpacityWorkspace40To42(options){const {signal,...input}=options;if(JSON.stringify(input)!==${JSON.stringify(JSON.stringify(expected))}||!(signal instanceof AbortSignal)||signal.aborted)throw Error('bad input');return ${JSON.stringify(result)};}`;
  const output = await isolated(t, [...valid, '--lang', 'en'], successful);
  assert.equal(output.code, 0); assert.deepEqual(output.body, {ok: true, data: result}); assert.match(output.stderr, /existing40 backup and source remain/u);
  const invalid = await isolated(t, valid, 'export async function upgradeOpacityWorkspace40To42(){return {publication:"confirmed",sourceVersion:41};}');
  assert.equal(invalid.code, 1); assert.equal(invalid.body.error.code, 'WORKSPACE_UPGRADE_IO');
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const cancelled = await isolated(t, [...valid, '--lang', 'ja'], `export async function upgradeOpacityWorkspace40To42({signal}){process.emit(${JSON.stringify(signal)});await Promise.resolve();if(!signal.aborted)throw Error('not cancelled');throw Object.assign(Error('SECRET'),{code:'WORKSPACE_UPGRADE_CANCELLED',cleanupUnconfirmed:true});}`);
    assert.equal(cancelled.code, code); assert.equal(cancelled.body.error.code, 'WORKSPACE_UPGRADE_CANCELLED'); assert.deepEqual(cancelled.body.error.details, {cleanupUnconfirmed: true});
    assert.ok(!cancelled.stdout.includes('SECRET'));
  }
  const before = ['SIGINT', 'SIGTERM', 'exit', 'beforeExit', 'uncaughtException', 'unhandledRejection'].map(signal => process.listenerCount(signal));
  const imported = await import('../apps/cli/src/opacity-upgrade.ts'); assert.equal(typeof imported.runOpacityUpgradeCli, 'function');
  assert.deepEqual(['SIGINT', 'SIGTERM', 'exit', 'beforeExit', 'uncaughtException', 'unhandledRejection'].map(signal => process.listenerCount(signal)), before);
  const source = fs.readFileSync(entry, 'utf8');
  assert.doesNotMatch(source, /process\.env|process\.exit\(|\.kill\(|startServer|createServices/u);
  assert.match(source, /process\.removeListener\('SIGINT'/u); assert.match(source, /process\.removeListener\('SIGTERM'/u);
});

test('actual CLI upgrades only its own closed40 fixture from a read-only existing backup and leaves source bytes intact', async t => {
  const f = await opacityUpgradeFixture(t);
  const credential = 'SYNTHETIC_NEVER_LIVE_CLI_TOKEN';
  fs.writeFileSync(path.join(f.source, 'access-token'), credential, {mode: 0o600});
  const sourceBefore = tree(f.source), sourceDbHash = upgradeFixtureHash(fs.readFileSync(f.database));
  const backed = await createWorkspaceBackup({source: f.source, destination: f.backup});
  const backupBefore = tree(f.backup);
  const args = ['upgrade', '--source', f.source, '--backup', f.backup, '--destination', f.destination, '--channel', 'web', '--lang', 'en'];
  const output = await isolated(t, args, undefined, true);
  assert.equal(output.code, 0, output.stdout + output.stderr); assert.equal(output.body.ok, true);
  assert.equal(opacityWorkspaceUpgradeResultSchema.safeParse(output.body.data).success, true);
  assert.equal(output.body.data.sourceBackupId, backed.backupId); assert.equal(output.body.data.sourceDbHash, sourceDbHash);
  assert.equal(output.body.data.targetDbHash, upgradeFixtureHash(fs.readFileSync(path.join(f.destination, 'workbench.sqlite'))));
  assert.equal(output.body.data.fileCount, backed.fileCount); assert.equal(output.body.data.payloadBytes, backed.payloadBytes);
  assert.deepEqual(tree(f.source), sourceBefore); assert.deepEqual(tree(f.backup), backupBefore);
  assert.deepEqual(fs.readFileSync(path.join(f.destination, f.relativePath)), f.mediaBytes);
  for (const name of ['access-token', 'settings.json', 'mcp-connection.json', 'server.lock']) assert.equal(fs.existsSync(path.join(f.destination, name)), false);
  assert.ok(!output.stdout.includes(credential)); assert.ok(!output.stderr.includes(credential)); assert.ok(!output.stdout.includes(f.base));
  const targetBefore = tree(f.destination), collision = await isolated(t, args, undefined, true);
  assert.equal(collision.code, 1); assert.equal(collision.body.error.code, 'WORKSPACE_UPGRADE_DESTINATION_EXISTS');
  assert.deepEqual(tree(f.destination), targetBefore); assert.deepEqual(tree(f.source), sourceBefore); assert.deepEqual(tree(f.backup), backupBefore);
});

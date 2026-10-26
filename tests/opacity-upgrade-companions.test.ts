import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {captureOpacityUpgradeCompanions, rebindOpacityUpgradeLastProject, verifyOpacityUpgradeCompanionCapture, type OpacityUpgradeCompanionCapture} from '../packages/business/src/opacity-upgrade-companions.ts';
import {calculateWorkspaceScope} from '../packages/contracts/src/workspace-scope.ts';
import {LOCAL_DRAFT_LIMITS} from '../packages/contracts/src/local-drafts.ts';
import {LOCAL_DELIVERY_LIMITS} from '../packages/contracts/src/local-delivery.ts';
import {LOCAL_SHOT_TEXT_LIMITS} from '../packages/contracts/src/local-shot-text.ts';
import {LAST_PROJECT_LIMITS} from '../packages/contracts/src/last-project.ts';
import {createLastProject} from '../packages/business/src/last-project.ts';
import {readPrivateFile, writePrivateFileAtomic, validatePrivateDirectory, validateManagedFile} from '@mioon/contracts/private-storage';

const stamp = '2026-10-16T00:00:00.000Z', storage = {readPrivateFile, writePrivateFileAtomic, validatePrivateDirectory, validateManagedFile};
function fixture(t: test.TestContext, channel:'web'|'development'|'production' = 'development') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'mioon-upgrade-companions-'))), database = path.join(root, 'workbench.sqlite'), projectId = randomUUID();
  fs.chmodSync(root, 0o700);
  const writable = new DatabaseSync(database); writable.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,data TEXT NOT NULL);');
  writable.prepare('INSERT INTO projects VALUES(?,?)').run(projectId, JSON.stringify({id: projectId, name: 'Own synthetic project'})); writable.close(); fs.chmodSync(database, 0o600);
  const db = new DatabaseSync(database, {readOnly: true}); db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
  t.after(() => {db.close(); fs.rmSync(root, {recursive: true, force: true});});
  const options = () => ({root, channel, db, directoryIdentity: fs.lstatSync(root), databaseIdentity: fs.lstatSync(database)});
  const scope = () => {const value = options(); return calculateWorkspaceScope({channel, root, directory: value.directoryIdentity, db: value.databaseIdentity});};
  const write = (name: string, value: unknown) => {fs.writeFileSync(path.join(root, name), Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value), {mode: 0o600}); fs.chmodSync(path.join(root, name), 0o600);};
  const lastProject = () => ({version: 1 as const, workspaceScope: scope(), revision: 7, projectId, updatedAt: stamp});
  return {root, database, db, projectId, options, scope, write, lastProject, capture: () => captureOpacityUpgradeCompanions((options() as unknown as Parameters<typeof captureOpacityUpgradeCompanions>[0]))};
}
const code = (suffix: string) => ({code: `OPACITY_UPGRADE_COMPANION_${suffix}`});
const clipSlot = (f: Awaited<ReturnType<typeof fixture>>, extra = {}) => ({projectId: f.projectId, timelineId: randomUUID(), clipId: randomUUID(), revision: 2, draft: null, ...extra});
const clipDisk = (f: Awaited<ReturnType<typeof fixture>>, version = 1, entries = [clipSlot((((f!))))]) => ({version, workspaceScope: f.scope(), entries});
const deliverySlot = (f: Awaited<ReturnType<typeof fixture>>) => ({projectId: f.projectId, draftRevision: 2, draft: null, intentRevision: 0, intent: null});
const shotSlot = (f: Awaited<ReturnType<typeof fixture>>) => ({...deliverySlot(f), shotId: randomUUID()});
const disk = (f: Awaited<ReturnType<typeof fixture>>, entries: unknown[]) => ({version: 1, workspaceScope: f.scope(), entries});

test('missing companion capture is noncreating and records all fixed absent paths without changing SQLite', t => {
  const f = fixture(t), before = fs.readFileSync(f.database), names = fs.readdirSync(f.root), changes = f.db.prepare('SELECT total_changes() AS n').get()!.n;
  const captured = f.capture();
  assert.equal(captured.workspaceScope, f.scope()); assert.equal(captured.files.length, 6); assert.deepEqual(captured.excludedEmpty, []); assert.equal(captured.lastProject, null);
  assert.ok(captured.files.every(file => file.identity === null && file.bytes === null));
  verifyOpacityUpgradeCompanionCapture(captured, {root: f.root});
  assert.deepEqual(fs.readdirSync(f.root), names); assert.deepEqual(fs.readFileSync(f.database), before); assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
  assert.equal(rebindOpacityUpgradeLastProject(captured, {root: f.root, channel: 'development', directoryIdentity: fs.lstatSync(f.root), databaseIdentity: fs.lstatSync(f.database)}), null);
});

test('last-project rebinding preserves revision, project and timestamp, and normal target CAS rejects old source authority', t => {
  const source = fixture(t, 'production'), target = fixture(t, 'development'); source.write('last-project-v1.json', (source.lastProject() as unknown as Parameters<typeof source.write>[1]));
  const original = fs.readFileSync(path.join(source.root, 'last-project-v1.json')), captured = source.capture();
  const targetOptions = {root: target.root, channel: 'development', directoryIdentity: fs.lstatSync(target.root), databaseIdentity: fs.lstatSync(target.database)};
  const migrated = rebindOpacityUpgradeLastProject(captured, (targetOptions as unknown as Parameters<typeof rebindOpacityUpgradeLastProject>[1]));
  assert.deepEqual({...migrated, workspaceScope: captured.workspaceScope}, source.lastProject()); assert.notEqual(migrated!.workspaceScope, captured.workspaceScope);
  target.write('last-project-v1.json', (migrated! as unknown as Parameters<typeof target.write>[1]));
  const locator = (createLastProject({root: target.root, channel: 'development', storage, guards: {ownsLock: () => true, isRestored: () => false, readProject: id => id === source.projectId ? {id} : null}}) as unknown as import('./helpers/strict-opacity-fixture-types.ts').PositiveLastProjectService);
  const found = locator.get(); assert.equal(found.projectId, source.projectId); assert.equal(found.revision, 7); assert.equal(found.updatedAt, stamp);
  assert.throws(() => locator.put({workspaceScope: captured.workspaceScope, instanceId: found.instanceId, expectedRevision: 7, projectId: source.projectId}), {code: 'LAST_PROJECT_SCOPE_MISMATCH'});
  assert.throws(() => locator.put({workspaceScope: found.workspaceScope, instanceId: randomUUID(), expectedRevision: 7, projectId: source.projectId}), {code: 'LAST_PROJECT_STALE_INSTANCE'});
  assert.equal(locator.put({workspaceScope: found.workspaceScope, instanceId: found.instanceId, expectedRevision: 7, projectId: source.projectId}).revision, 8);
  assert.deepEqual(fs.readFileSync(path.join(source.root, 'last-project-v1.json')), original); verifyOpacityUpgradeCompanionCapture(captured, {root: source.root});
});

for (const version of [1, 2] as const) test(`legacy clip content version${version} tombstones are explicitly excluded without rewriting source bytes`, t => {
  const f = fixture(t), value = clipDisk(f, version); f.write('local-drafts-v1.json', (value as unknown as Parameters<typeof f.write>[1]));
  const before = fs.readFileSync(path.join(f.root, 'local-drafts-v1.json')), result = f.capture();
  assert.deepEqual(result.excludedEmpty, ['local-drafts-v1.json']); assert.deepEqual(result.files.find(file => file.name === 'local-drafts-v1.json')!.bytes, before);
  verifyOpacityUpgradeCompanionCapture(result, {root: f.root}); assert.deepEqual(fs.readFileSync(path.join(f.root, 'local-drafts-v1.json')), before);
});

test('delivery and shot-text tombstones and empty files are validated and explicitly excluded', t => {
  const f = fixture(t); f.write('local-delivery-v1.json', (disk(f, [deliverySlot(f)]) as unknown as Parameters<typeof f.write>[1])); f.write('local-shot-text-v1.json', (disk(f, [shotSlot(f)]) as unknown as Parameters<typeof f.write>[1]));
  assert.deepEqual(f.capture().excludedEmpty, ['local-delivery-v1.json', 'local-shot-text-v1.json']);
  for (const name of ['local-drafts-v1.json', 'local-delivery-v1.json', 'local-shot-text-v1.json'] as const) f.write(name, (disk(f, []) as unknown as Parameters<typeof f.write>[1]));
  assert.deepEqual(f.capture().excludedEmpty, ['local-drafts-v1.json', 'local-delivery-v1.json', 'local-shot-text-v1.json']);
});

for (const [name, field, value] of [
  ['local-drafts-v1.json', 'draft', {raw: {name: 'Unfinished input'}}],
  ['local-delivery-v1.json', 'draft', {raw: {deliveryName: 'Unfinished input'}}],
  ['local-delivery-v1.json', 'intent', {outcome: {status: 'pending'}}],
  ['local-delivery-v1.json', 'intent', {outcome: {status: 'accepted'}}],
  ['local-shot-text-v1.json', 'draft', {raw: {title: 'Unfinished input', prompt: ''}}],
  ['local-shot-text-v1.json', 'intent', {outcome: {status: 'pending'}}],
  ['local-shot-text-v1.json', 'intent', {outcome: {status: 'applied'}}],
] as const) test(`${name} retained ${field}/${value.outcome?.status ?? 'raw'} refuses without data loss or implicit task execution`, t => {
  const f = fixture(t), slot = name === 'local-drafts-v1.json' ? clipSlot(f) : name === 'local-delivery-v1.json' ? deliverySlot(f) : shotSlot(f);
  f.write(name, (disk(f, [{...slot, [field]: value}]) as unknown as Parameters<typeof f.write>[1])); const before = fs.readFileSync(path.join(f.root, name)), database = fs.readFileSync(f.database);
  assert.throws(() => f.capture(), code('ACTIVE')); assert.deepEqual(fs.readFileSync(path.join(f.root, name)), before); assert.deepEqual(fs.readFileSync(f.database), database);
});

for (const name of ['local-drafts-v3.json', 'local-drafts-restored43-v1.json'] as const) test(`ordinary40 never imports or resets ${name}`, t => {
  const f = fixture(t); f.write(name, '{unsupported or corrupt source candidate format'); const before = fs.readFileSync(path.join(f.root, name));
  assert.throws(() => f.capture(), code('UNSUPPORTED')); assert.deepEqual(fs.readFileSync(path.join(f.root, name)), before);
});

test('decoded duplicate keys, fatal UTF-8, malformed JSON and unknown formats remain untouched', t => {
  const f = fixture(t), value = f.lastProject(), valid = JSON.stringify(value);
  const cases = ['{', 'null', JSON.stringify({...value, version: 2}), JSON.stringify({...value, secret: 'never accepted'}), JSON.stringify({...value, revision: 0}),
    valid.replace('"revision":7', '"revision":7,"revi\\u0073ion":8'),
    valid.replace('"projectId":', '"projectId":"00000000-0000-4000-8000-000000000000","projectId":'), Buffer.from([0xff])];
  for (const bytes of cases) {f.write('last-project-v1.json', bytes); const before = fs.readFileSync(path.join(f.root, 'last-project-v1.json')); assert.throws(() => f.capture(), code('INVALID')); assert.deepEqual(fs.readFileSync(path.join(f.root, 'last-project-v1.json')), before);}
  f.write('local-drafts-v1.json', JSON.stringify(clipDisk(f)).replace('"draft":null', '"draft":null,"dr\\u0061ft":null')); fs.rmSync(path.join(f.root, 'last-project-v1.json'));
  assert.throws(() => f.capture(), code('INVALID'));
});

test('foreign workspace or channel scope rejects valid locator and empty drafts without rebinding them', t => {
  const f = fixture(t), foreign = fixture(t);
  for (const [name, value] of [['last-project-v1.json', {...f.lastProject(), workspaceScope: foreign.scope()}], ['local-drafts-v1.json', {...clipDisk(f), workspaceScope: foreign.scope()}]] as const) {
    f.write(name, value); const before = fs.readFileSync(path.join(f.root, name)); assert.throws(() => f.capture(), code('SCOPE_MISMATCH')); assert.deepEqual(fs.readFileSync(path.join(f.root, name)), before); fs.rmSync(path.join(f.root, name));
  }
  f.write('last-project-v1.json', (f.lastProject() as unknown as Parameters<typeof f.write>[1])); assert.throws(() => captureOpacityUpgradeCompanions({...f.options(), channel: 'web'}), code('SCOPE_MISMATCH'));
});

test('last-project target must exist and match bounded relational JSON identity', t => {
  const f = fixture(t); f.write('last-project-v1.json', {...f.lastProject(), projectId: randomUUID()}); assert.throws(() => f.capture(), code('INVALID'));
  f.write('last-project-v1.json', (f.lastProject() as unknown as Parameters<typeof f.write>[1])); const writer = new DatabaseSync(f.database);
  try {for (const value of ['null', '{', JSON.stringify({id: randomUUID()}), JSON.stringify({id: f.projectId, name: 'x'.repeat(17000)}), `{"id":"${f.projectId}","i\\u0064":"${f.projectId}"}`] as const) {
    writer.prepare('UPDATE projects SET data=? WHERE id=?').run(value, f.projectId); assert.throws(() => f.capture(), code('INVALID'));
  }} finally {writer.close();}
});

test('slot uniqueness, known formats, missing fields and slot capacity are strict for excluded files', t => {
  const f = fixture(t), slot = clipSlot(f), cases = [clipDisk(f, 1, [slot, slot]), clipDisk(f, 3), {...clipDisk(f), extra: true}, clipDisk(f, 1, Array.from({length: 129}, () => clipSlot(f)))];
  for (const value of cases) {f.write('local-drafts-v1.json', (value as unknown as Parameters<typeof f.write>[1])); assert.throws(() => f.capture(), code('INVALID'));}
  f.write('local-drafts-v1.json', (clipDisk(f, 1, Array.from({length: 128}, () => clipSlot(f))) as unknown as Parameters<typeof f.write>[1])); assert.equal(f.capture().excludedEmpty.length, 1); fs.rmSync(path.join(f.root, 'local-drafts-v1.json'));
  for (const [name, slotValue] of [['local-delivery-v1.json', deliverySlot(f)], ['local-shot-text-v1.json', shotSlot(f)]] as const) {
    for (const entry of [{...slotValue, draftRevision: 0}, {...slotValue, intentRevision: 1}, {...slotValue, extra: true}] as const) {f.write(name, (disk(f, [entry]) as unknown as Parameters<typeof f.write>[1])); assert.throws(() => f.capture(), code('INVALID'));}
    f.write(name, (disk(f, [slotValue, slotValue]) as unknown as Parameters<typeof f.write>[1])); assert.throws(() => f.capture(), code('INVALID')); fs.rmSync(path.join(f.root, name));
  }
});

for (const [name, limit] of [['last-project-v1.json', LAST_PROJECT_LIMITS.fileBytes], ['local-drafts-v1.json', LOCAL_DRAFT_LIMITS.envelopeBytes],
  ['local-delivery-v1.json', LOCAL_DELIVERY_LIMITS.envelopeBytes], ['local-shot-text-v1.json', LOCAL_SHOT_TEXT_LIMITS.envelopeBytes]] as const) test(`${name} enforces its original ${limit}-byte bound`, t => {
  const f = fixture(t); f.write(name, Buffer.alloc(limit + 1, 32)); const before = fs.lstatSync(path.join(f.root, name)); assert.throws(() => f.capture(), code('INVALID')); assert.equal(fs.lstatSync(path.join(f.root, name)).size, before.size);
});

test('symlink, hardlink, directory and nonprivate mode refuse without repairs', t => {
  const f = fixture(t), name = 'last-project-v1.json', file = path.join(f.root, name), unrelated = path.join(f.root, 'unrelated'); fs.writeFileSync(unrelated, JSON.stringify(f.lastProject()), {mode: 0o600});
  fs.symlinkSync(unrelated, file); assert.throws(() => f.capture(), code('INVALID')); assert.equal(fs.lstatSync(file).isSymbolicLink(), true); fs.unlinkSync(file);
  fs.linkSync(unrelated, file); assert.throws(() => f.capture(), code('INVALID')); assert.equal(fs.lstatSync(file).nlink, 2); fs.unlinkSync(file);
  fs.mkdirSync(file, {mode: 0o700}); assert.throws(() => f.capture(), code('INVALID')); fs.rmdirSync(file);
  f.write(name, (f.lastProject() as unknown as Parameters<typeof f.write>[1])); fs.chmodSync(file, 0o644); assert.throws(() => f.capture(), code('INVALID')); assert.equal(fs.lstatSync(file).mode & 0o777, 0o644);
});

test('final capture verification detects new paths, deletion, content changes and same-byte inode replacement', t => {
  const f = fixture(t), absent = f.capture(); f.write('local-delivery-v1.json', (disk(f, []) as unknown as Parameters<typeof f.write>[1])); assert.throws(() => verifyOpacityUpgradeCompanionCapture(absent, {root: f.root}), code('CHANGED')); fs.rmSync(path.join(f.root, 'local-delivery-v1.json'));
  f.write('last-project-v1.json', (f.lastProject() as unknown as Parameters<typeof f.write>[1])); const captured = f.capture(), file = path.join(f.root, 'last-project-v1.json'), bytes = fs.readFileSync(file);
  f.write('last-project-v1.json', {...f.lastProject(), revision: 8}); assert.throws(() => verifyOpacityUpgradeCompanionCapture(captured, {root: f.root}), code('CHANGED'));
  f.write('last-project-v1.json', bytes); const capturedAgain = f.capture(); fs.rmSync(file); assert.throws(() => verifyOpacityUpgradeCompanionCapture(capturedAgain, {root: f.root}), code('CHANGED'));
  f.write('last-project-v1.json', bytes); const beforeReplacement = f.capture(), replacement = path.join(f.root, 'replacement'); fs.writeFileSync(replacement, bytes, {mode: 0o600}); fs.renameSync(replacement, file);
  assert.throws(() => verifyOpacityUpgradeCompanionCapture(beforeReplacement, {root: f.root}), code('CHANGED')); assert.deepEqual(fs.readFileSync(file), bytes);
});

test('source identity admission rejects stale directory/database identities and lexical path aliases', t => {
  const f = fixture(t), options = f.options();
  for (const changed of [{directoryIdentity: {...options.directoryIdentity, ino: options.directoryIdentity.ino + 1}}, {databaseIdentity: {...options.databaseIdentity, ino: options.databaseIdentity.ino + 1}}] as const) assert.throws(() => captureOpacityUpgradeCompanions(({...options, ...changed} as unknown as Parameters<typeof captureOpacityUpgradeCompanions>[0])), code('CHANGED'));
  assert.throws(() => captureOpacityUpgradeCompanions(({...options, root: f.root + '/.'} as unknown as Parameters<typeof captureOpacityUpgradeCompanions>[0])), code('INVALID'));
  const source = f.capture(); assert.throws(() => rebindOpacityUpgradeLastProject({...source, lastProject: f.lastProject()}, {...options, root: 'relative'}), code('INVALID'));
});

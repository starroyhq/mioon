import * as storage from '@mioon/contracts/private-storage';
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createDesktopLutRecoveryStore, DESKTOP_LUT_RECOVERY_LIMITS } from '../apps/desktop/src/lut-recovery-store.ts';

const record = (change: Record<string, unknown> = {}) => ({ version: 1, workspaceScope: 'a'.repeat(64), projectId: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222', name: 'look.cube', sizeBytes: 30, sha256: 'b'.repeat(64), ...change });
const code = (value: string) => (error: unknown) => (error as {code?: string}).code === `LUT_RECOVERY_${value}`;
type LooseStore = {read(value: unknown): unknown; reserve(value: unknown): void; verify(value: unknown): void; complete(value: unknown): void};
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'mioon-lut-store-'));
  const userData = path.join(root, 'userData'); fs.mkdirSync(userData, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(userData, 'lut-import-pending-v1.json');
  return { root, userData, file, create: (options: Record<string, unknown> = {}): LooseStore => createDesktopLutRecoveryStore({ userData, storage: storage as unknown as Parameters<typeof createDesktopLutRecoveryStore>[0]['storage'], guard() {}, ...options }) as unknown as LooseStore };
}
const bytes = (file: string) => fs.readFileSync(file, 'utf8');

test('private desktop LUT metadata survives store recreation without touching missing storage on read', t => {
  const f = fixture(t), value = record(), store = f.create();
  assert.equal(store.read(value), null);
  store.complete(value);
  assert.deepEqual(fs.readdirSync(f.userData), []);
  store.reserve(value); store.verify(value);
  const saved = bytes(f.file);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(saved)), ['version', 'records']);
  assert.deepEqual(JSON.parse(saved).records, [value]);
  assert.deepEqual(fs.readdirSync(f.userData), ['lut-import-pending-v1.json']);
  assert.deepEqual(f.create().read(value), value);
  f.create().complete(value);
  assert.equal(f.create().read(value), null);
});

test('CAS reservation and completion compare the complete metadata and preserve unrelated scopes', t => {
  const f = fixture(t), a = record(), b = record({ workspaceScope: 'c'.repeat(64) }), store = f.create();
  store.reserve(a); store.reserve(b);
  const original = bytes(f.file);
  for (const change of [{requestId: randomUUID()}, {name:'other.cube'}, {sha256:'d'.repeat(64)}, {sizeBytes:31}]) {
    for (const method of ['reserve', 'verify', 'complete'] as const) assert.throws(() => store[method]({...a, ...change}), code('CONFLICT'));
    assert.equal(bytes(f.file), original);
  }
  store.reserve(a); assert.equal(bytes(f.file), original);
  store.complete(a); store.complete(a);
  assert.deepEqual(store.read(b), b);
  assert.equal(store.read(a), null);
  assert.throws(() => store.verify(a), code('CONFLICT'));
});

test('each operation rereads disk and invalid data is never repaired or evicted', t => {
  const f = fixture(t), store = f.create(), a = record();
  store.reserve(a);
  for (const corrupt of ['{', '{}', bytes(f.file)+'\n', '{"version":1,"version":1,"records":[]}',
    JSON.stringify({version:1, records:[a,a]}), JSON.stringify({version:1, records:[{...a, cubeText:'secret'}]})]) {
    fs.writeFileSync(f.file, corrupt);
    for (const method of ['read','reserve','verify','complete'] as const) assert.throws(() => store[method](a), code('CORRUPT'));
    assert.equal(bytes(f.file), corrupt);
  }
});

test('oversized existing aggregate is rejected without replacing evidence', t => {
  const f = fixture(t), store = f.create();
  const oversized = ' '.repeat(DESKTOP_LUT_RECOVERY_LIMITS.maxBytes + 1);
  fs.writeFileSync(f.file, oversized, {mode:0o600});
  assert.throws(() => store.reserve(record()), code('CORRUPT'));
  assert.equal(bytes(f.file), oversized);
});

test('bounded slots reject a new unresolved request but never evict prior evidence', t => {
  const f = fixture(t), store = f.create(), values = [];
  for (let i = 0; i < DESKTOP_LUT_RECOVERY_LIMITS.records; i++) {
    const value = record({ projectId: randomUUID() }); values.push(value); store.reserve(value);
  }
  const original = bytes(f.file);
  assert.throws(() => store.reserve(record({projectId:randomUUID()})), code('UNAVAILABLE'));
  assert.equal(bytes(f.file), original);
  for (const value of values) assert.deepEqual(store.read(value), value);
  store.reserve(values[0]); store.complete(values[0]);
  store.reserve(record({projectId:randomUUID()}));
  assert.equal(JSON.parse(bytes(f.file)).records.length, DESKTOP_LUT_RECOVERY_LIMITS.records);
});

for (const kind of ['symlink', 'hardlink', 'mode', 'directory']) {
  test(`rejects ${kind} target without repairing or modifying it`, t => {
    const f = fixture(t), store = f.create(), other = path.join(f.root, 'other');
    fs.writeFileSync(other, 'untouched', {mode:0o600});
    if (kind === 'symlink') fs.symlinkSync(other, f.file);
    if (kind === 'hardlink') fs.linkSync(other, f.file);
    if (kind === 'mode') fs.writeFileSync(f.file, 'untouched', {mode:0o644});
    if (kind === 'directory') fs.mkdirSync(f.file);
    for (const method of ['read','reserve','verify','complete'] as const) assert.throws(() => store[method](record()), code('UNAVAILABLE'));
    assert.equal(bytes(other), 'untouched');
    if (kind === 'mode') assert.equal(fs.statSync(f.file).mode & 0o777, 0o644);
    if (kind === 'symlink') assert.ok(fs.lstatSync(f.file).isSymbolicLink());
    if (kind === 'hardlink') assert.equal(fs.statSync(f.file).nlink, 2);
  });
}

test('root is private and pinned for the lifetime of the store', t => {
  const f = fixture(t), store = f.create();
  fs.chmodSync(f.userData, 0o755);
  assert.throws(() => store.reserve(record()), code('UNAVAILABLE'));
  assert.equal(fs.statSync(f.userData).mode & 0o777, 0o755);
  fs.chmodSync(f.userData, 0o700);
  fs.renameSync(f.userData, path.join(f.root,'old')); fs.mkdirSync(f.userData,{mode:0o700});
  assert.throws(() => store.read(record()), code('UNAVAILABLE'));
  assert.deepEqual(fs.readdirSync(f.userData), []);
});

test('publication aborts after a root identity swap without touching replacement directory', t => {
  const f = fixture(t);
  const store = f.create({beforePublish() {
    fs.renameSync(f.userData,path.join(f.root,'old')); fs.mkdirSync(f.userData,{mode:0o700});
    fs.writeFileSync(f.file,'replacement',{mode:0o600});
  }});
  assert.throws(() => store.reserve(record()), code('UNAVAILABLE'));
  assert.equal(bytes(f.file),'replacement');
});

test('publication rechecks original target identity and preserves a replacement record', t => {
  const f = fixture(t), first = record(), replacement = record({requestId:randomUUID()});
  const other = f.create(); other.reserve(first);
  const store = f.create({beforePublish() { other.complete(first); other.reserve(replacement); }});
  assert.throws(() => store.complete(first), code('CONFLICT'));
  assert.deepEqual(other.read(first),replacement);
  assert.deepEqual(fs.readdirSync(f.userData), ['lut-import-pending-v1.json']);
});

test('workspace/backend fence runs before access and again immediately before publication', t => {
  const f = fixture(t); let active = true, calls = 0;
  const store = f.create({guard() { calls++; if (!active) throw Error('backend changed'); }, beforePublish() { active = false; }});
  assert.throws(() => store.reserve(record()), code('UNAVAILABLE'));
  assert.ok(calls > 2); assert.equal(fs.existsSync(f.file),false);
  assert.deepEqual(fs.readdirSync(f.userData), []);
  assert.throws(() => store.read(record()), code('UNAVAILABLE'));
});

test('invalid incoming metadata cannot reach disk', t => {
  const f = fixture(t), store = f.create();
  for (const value of [record({cubeText:'secret'}),record({name:'../look.cube'}),record({version:2}),record({sizeBytes:0})]) {
    assert.throws(() => store.reserve(value), code('CORRUPT'));
  }
  assert.deepEqual(fs.readdirSync(f.userData), []);
});

test('invalid UTF-8 and too many preexisting records are corrupt, not normalized', t => {
  const f = fixture(t), store = f.create();
  const valid = Buffer.from(JSON.stringify({version:1, records:[record({name:'x.cube'})]}));
  valid[valid.indexOf('x.cube')] = 0xff;
  fs.writeFileSync(f.file,valid,{mode:0o600});
  assert.throws(() => store.read(record()),code('CORRUPT'));
  assert.deepEqual(fs.readFileSync(f.file),valid);
  const tooMany = JSON.stringify({version:1,records:Array.from({length:129},()=>record({projectId:randomUUID()}))});
  fs.writeFileSync(f.file,tooMany);
  assert.throws(() => store.reserve(record()),code('CORRUPT'));
  assert.equal(bytes(f.file),tooMany);
});

test('constructor pins private root without requiring an active backend request', t => {
  const f = fixture(t); let calls = 0;
  const store = f.create({guard() { calls++; throw Error('no active request'); }});
  assert.equal(calls,0);
  assert.throws(() => store.read(record()),code('UNAVAILABLE'));
  assert.equal(calls,1);
});

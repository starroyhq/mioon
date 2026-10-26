import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createLookPackIntake, type LookPackFile, type LookPackIntakeState } from '../apps/web/src/look-pack-intake.ts';
import { createClipLutController, type ClipLutImportRecord } from '../apps/web/src/clip-lut-state.ts';
import { createClipLutRecovery } from '../apps/web/src/clip-lut-recovery.ts';
import { parseCube3D } from '../packages/business/src/cube-lut.ts';

const bytes = readFileSync(new URL('../examples/look-packs/synthetic-nonlinear.mioon-look.cube', import.meta.url));
const name = 'synthetic-nonlinear.mioon-look.cube';
const file = (content: Uint8Array = bytes, filename: string|undefined = name) => ({ name: filename, size: content.length, arrayBuffer: async () => Uint8Array.from(content).buffer });
const gate = <T = ArrayBuffer>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function intake(overrides: Partial<Parameters<typeof createLookPackIntake>[0]> = {}) {
  let scope = 'first-project', blocked = false; const calls: LookPackFile[] = [], changes: LookPackIntakeState[] = [];
  const controller = createLookPackIntake({ getScope: () => scope, isBlocked: () => blocked,
    adopt: async value => { calls.push(value); return true; }, onChange: value => changes.push(value), ...overrides });
  return { controller, calls, changes, setScope: (value: string) => { scope = value; }, block: (value: boolean) => { blocked = value; }, state: () => controller.getState() };
}

test('preview is read-only; explicit acknowledgement adopts exactly original bytes once', async () => {
  const h = intake(); assert.equal(await h.controller.preview(file()), true); assert.equal(h.state().phase, 'ready');
  assert.equal((h.state().inspection)!.manifest.kind, 'look-pack'); assert.deepEqual((h.calls as unknown), []);
  assert.equal(await h.controller.adopt(), false); h.controller.acknowledge(true);
  assert.equal(await h.controller.adopt(), true); assert.equal(h.state().phase, 'adopted');
  assert.equal(h.calls.length, 1); assert.deepEqual(Buffer.from(await h.calls[0].arrayBuffer()), bytes);
  assert.equal(await h.controller.adopt(), false); assert.equal(h.calls.length, 1);
});

test('cancel and stale file preview cannot import or repaint a different project', async () => {
  for (const action of ['cancel', 'scope', 'dispose', 'blocked']) {
    const d = gate(), h = intake(), pending = h.controller.preview({ ...file(), arrayBuffer: () => d.promise });
    if (action === 'cancel') h.controller.cancel();
    if (action === 'scope') h.setScope('other-project');
    if (action === 'dispose') h.controller.dispose();
    if (action === 'blocked') h.block(true);
    (d.resolve)!(Uint8Array.from(bytes).buffer); assert.equal(await pending, false);
    assert.notEqual(h.state().phase, 'ready'); assert.equal(h.state().inspection, null); assert.deepEqual((h.calls as unknown), []);
  }
});

test('newer preview wins; repeated selection resets acknowledgement', async () => {
  const d = gate(), h = intake(), old = h.controller.preview({ ...file(), arrayBuffer: () => d.promise });
  assert.equal(await h.controller.preview(file(bytes, 'new-name.mioon-look.cube')), true); h.controller.acknowledge(true);
  (d.resolve)!(Uint8Array.from(bytes).buffer); assert.equal(await old, false); assert.equal(h.state().name, 'new-name.mioon-look.cube');
  assert.equal(await h.controller.preview(file()), true); assert.equal(h.state().acknowledged, false); assert.deepEqual((h.calls as unknown), []);
});

test('unsupported name, size and malformed pack fail without reading too much or adopting', async () => {
  const h = intake(); let read = 0;
  for (const bad of [{ name: 'archive.zip', size: 1 }, { name, size: 0 }, { name, size: 7 * 1024 * 1024 + 1 }]) {
    assert.equal(await h.controller.preview({ ...bad, arrayBuffer: async () => { read++; return new ArrayBuffer(1); } }), false);
  }
  assert.equal(read, 0); assert.equal(await h.controller.preview(file(Buffer.from('bad'))), false);
  assert.equal(h.state().phase, 'error'); assert.deepEqual((h.calls as unknown), []);
});

test('adoption uses immutable captured bytes, not a second caller-controlled read', async () => {
  const h = intake(), mutable = Uint8Array.from(bytes); let reads = 0;
  assert.equal(await h.controller.preview({ name, size: mutable.length, arrayBuffer: async () => { reads++; return mutable.buffer; } }), true);
  mutable.fill(0); h.controller.acknowledge(true); assert.equal(await h.controller.adopt(), true); assert.equal(reads, 1);
  assert.deepEqual(Buffer.from(await h.calls[0].arrayBuffer()), bytes);
});

test('duplicate adoption and cancellation during accepted action cannot create another request', async () => {
  const d = gate<boolean>(); let count = 0; const h = intake({ adopt: async () => { count++; return d.promise; } });
  await h.controller.preview(file()); h.controller.acknowledge(true); const first = h.controller.adopt();
  assert.equal(await h.controller.adopt(), false); assert.equal(h.controller.cancel(), false);
  assert.equal(await h.controller.preview(file()), false); (d.resolve)!(false); assert.equal(await first, false);
  assert.equal(h.state().phase, 'error'); assert.equal(await h.controller.adopt(), false); assert.equal(count, 1);
});

test('scope switch after adoption never shows success in the next project', async () => {
  const d = gate<boolean>(), h = intake({ adopt: async () => d.promise }); await h.controller.preview(file()); h.controller.acknowledge(true);
  const pending = h.controller.adopt(); h.setScope('next-project'); h.controller.refresh(); (d.resolve)!(true);
  assert.equal(await pending, false); assert.equal(h.state().phase, 'idle'); assert.equal(h.state().inspection, null);
});

const id = (n: number) => `80000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function lutHarness() {
  let scope = { scope: 'w:p', projectId: id(1), timelineId: id(2), clipId: id(3), assetId: id(4), assetSha256: 'a'.repeat(64), blocked: false };
  const storage = new Map<string, string>(), calls: [string, Record<string, unknown>][] = [], imports = new Map<string, ClipLutImportRecord>(); let uncertain = false;
  const recovery = createClipLutRecovery({ storage: () => ({ getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) }), lock: async (_k, action) => action() });
  const controller = createClipLutController({ getContext: () => scope, imports, recovery, newRequestId: () => id(9), edit: () => assert.fail('Pack import must not edit clip'),
    readWorkspace: async key => ({ supported: true, workspaceScope: 'a'.repeat(64), instanceId: id(8), key, revision: 0, targetStatus: 'matching', draft: null }),
    rpc: async (operation, input) => { calls.push([operation, input]);
      if (operation === 'lut.list') return { projectId: scope.projectId, items: [], nextAfter: null };
      if (operation === 'timeline.colour.source.inspect') throw Error('Not needed for resource adoption');
      if (operation !== 'lut.import') throw Error('Unexpected operation');
      if (uncertain) throw Error('Lost acknowledgement');
      const content = Buffer.from(input.dataBase64 as string, 'base64');
      return { requestId: input.requestId, resource: { id: id(10), projectId: input.projectId, name: input.name, kind: 'cube3d', sha256: createHash('sha256').update(content).digest('hex'), sizeBytes: content.length, profile: 'mioon-cube3d-normalized-tetrahedral-v1', metadata: parseCube3D(content.toString()).metadata, createdAt: '2026-10-15T00:00:00.000Z', colourCompatibility: 'unverified', renderBinding: 'not_implemented' } };
    } });
  return { controller, calls, uncertain: (value: boolean) => { uncertain = value; } };
}
async function ready(h: ReturnType<typeof lutHarness>) { h.controller.open(); for (let i = 0; i < 50; i++) await Promise.resolve(); assert.equal(h.controller.getState().recoveryPhase, 'ready'); }

test('plain import cannot bypass pack preview even renamed to an ordinary Cube filename', async () => {
  const h = lutHarness(); await ready(h);
  for (const filename of [name, 'renamed.cube']) assert.equal(await h.controller.importFile(file(bytes, filename)), false);
  assert.equal(h.calls.filter(c => c[0] === 'lut.import').length, 0);
  assert.match(h.controller.getState().importError, /单 Look 数据包/u);
  assert.equal(await h.controller.importFile(file(), { lookPackConfirmed: true }), true);
  assert.equal(h.calls.filter(c => c[0] === 'lut.import').length, 1); h.controller.dispose();
});

test('pack unknown outcome retains the unchanged exact LUT request and explicit retry', async () => {
  const h = lutHarness(); await ready(h); h.uncertain(true);
  assert.equal(await h.controller.importFile(file(), { lookPackConfirmed: true }), false);
  assert.equal((h.controller.getState().importRecord)!.phase, 'unknown');
  assert.equal(await h.controller.importFile(file(), { lookPackConfirmed: true }), false);
  h.uncertain(false); assert.equal(await h.controller.retryImport(), true);
  const submitted = h.calls.filter(c => c[0] === 'lut.import'); assert.equal(submitted.length, 2); assert.deepEqual(submitted[0], submitted[1]);
  assert.deepEqual(Buffer.from(submitted[0][1].dataBase64 as string, 'base64'), bytes); h.controller.dispose();
});

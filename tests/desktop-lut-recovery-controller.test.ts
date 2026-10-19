import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as storage from '@mioon/contracts/private-storage';
import { createClipLutController } from '../apps/web/src/clip-lut-state.ts';
import { createDesktopOrBrowserLutRecovery } from '../apps/web/src/clip-lut-recovery.ts';
import { createDesktopLutRecoveryHost } from '../apps/desktop/src/lut-recovery-host.ts';
import { createDesktopLutRecoveryStore } from '../apps/desktop/src/lut-recovery-store.ts';
import { createDesktopLutRecoveryBridge } from '../apps/desktop/src/lut-recovery-preload.ts';
const id = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), clipId = id(2), assetId = id(3), timelineId = id(4), trackId = id(5), stamp = '2026-10-14T18:00:00.000Z';
const hash = 'a'.repeat(64);
const context = (patch: Record<string, unknown> = {}) => ({ scope: 'workspace:project', projectId, timelineId, clipId, assetId, assetSha256: hash, blocked: false, ...patch });
const inspection = (patch: Record<string, unknown> = {}) => ({ projectId, assetId, assetSha256: hash, streamIndex: 0, evidence: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'limited', pixelFormat: 'yuv420p', bitDepth: 8, hdrMetadata: false }, status: 'compatible', reason: null, ...patch });
const resource = (patch: Record<string, unknown> = {}) => ({ id: id(10), projectId, name: 'look.cube', kind: 'cube3d', sha256: 'b'.repeat(64), sizeBytes: 65, profile: 'mioon-cube3d-normalized-tetrahedral-v1', metadata: { profileId: 'mioon-cube3d-normalized-tetrahedral-v1', size: 2, title: null, domainMin: [0, 0, 0], domainMax: [1, 1, 1], rowCount: 8, rowOrder: 'red-fastest', interpolation: 'tetrahedral', numericPrecision: 'float64' }, createdAt: stamp, colourCompatibility: 'unverified', renderBinding: 'not_implemented', ...patch });
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const cube = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
const file = () => new File([cube], 'look.cube');
const importResponse = (input: {requestId: string; name: string; dataBase64: string}) => ({ requestId: input.requestId, resource: resource({ name: input.name, sha256: createHash('sha256').update(Buffer.from(input.dataBase64, 'base64')).digest('hex'), sizeBytes: Buffer.from(input.dataBase64, 'base64').length }) });

interface NativeSessionOptions {port: number; partition: string; importResult: (input: {requestId: string; name: string; dataBase64: string}) => unknown; bridgeMissing?: boolean}
function nativeSession(t: TestContext, userData: string, { port, partition, importResult, bridgeMissing = false }: NativeSessionOptions) {
  let alive = true;
  const calls: Array<[string, Record<string, unknown>]> = [], edits: unknown[] = [], metadataWrites: unknown[] = [];
  // Port and partition are intentionally new for every synthetic app lifetime;
  // neither is a persistence key or an authority source.
  const event = { url: `http://127.0.0.1:${port}/?project=${projectId}`, partition };
  const host = createDesktopLutRecoveryHost({
    ownerForEvent: (input: unknown) => input === event ? { projectId, isCurrent: () => alive } : null,
    currentWorkspaceScope: () => { if (!alive) throw Error('old backend'); return hash; },
    createStore: (guard: () => void) => {
      const store = createDesktopLutRecoveryStore({ userData, storage: storage as unknown as Parameters<typeof createDesktopLutRecoveryStore>[0]['storage'], guard });
      return { read: identity => store.read(identity), verify: value => store.verify(value),
        reserve: value => { metadataWrites.push('reserve'); store.reserve(value); },
        complete: value => { metadataWrites.push('complete'); store.complete(value); } };
    },
  });
  const bridge = createDesktopLutRecoveryBridge({ invoke: (_channel, input) => host.dispatch(event, input) });
  const recovery = createDesktopOrBrowserLutRecovery({ __mioonDesktop: true, ...(!bridgeMissing ? { __mioonLutRecovery: bridge } : {}) });
  const controller = createClipLutController({ getContext: () => context(), imports: new Map(), recovery, newRequestId: () => id(port),
    readWorkspace: async key => ({ supported: true, workspaceScope: hash, instanceId: id(port + 1), key, revision: 0, targetStatus: 'matching', draft: null }),
    rpc: async (op: string, input: unknown) => {
      calls.push([op, structuredClone(input) as Record<string, unknown>]);
      if (op === 'timeline.colour.source.inspect') return inspection();
      if (op === 'lut.list') return { projectId, items: [], nextAfter: null };
      if (op === 'lut.import') return importResult(input as {requestId: string; name: string; dataBase64: string});
      throw Error('Unexpected mutation');
    }, edit: (value: unknown) => edits.push(value),
  });
  t.after(() => { alive = false; controller.dispose(); });
  return { controller, calls, edits, metadataWrites, close: () => { alive = false; controller.dispose(); } };
}

test('fresh app/partition/port restores original LUT request; open/recheck/exact reselect are read-only', async t => {
  const userData = mkdtempSync(path.join(tmpdir(), 'mioon-lut-controller-'));
  t.after(() => rmSync(userData, { recursive: true, force: true }));
  const first = nativeSession(t, userData, { port: 31301, partition: 'random-session-A', importResult: () => { throw Error('lost response'); } });
  first.controller.open(); await tick(); await first.controller.checkRecovery();
  assert.equal(await first.controller.importFile(file()), false);
  assert.equal(first.controller.getState().importRecord!.phase, 'unknown');
  const original = first.calls.find(([op]) => op === 'lut.import')![1];
  const pendingPath = path.join(userData, 'lut-import-pending-v1.json'), before = readFileSync(pendingPath, 'utf8'), inode = statSync(pendingPath).ino;
  assert.deepEqual(Object.keys(JSON.parse(before).records[0]), ['version', 'workspaceScope', 'projectId', 'requestId', 'name', 'sizeBytes', 'sha256']);
  assert.ok(!before.includes(String(original.dataBase64)));
  first.close();
  const second = nativeSession(t, userData, { port: 41819, partition: 'random-session-B', importResult: importResponse });
  second.controller.open(); await tick(); await second.controller.checkRecovery();
  assert.equal(second.controller.getState().recovery!.requestId, original.requestId);
  assert.equal(await second.controller.retryImport(), false, 'no retry until exact bytes reselected');
  assert.equal(await second.controller.reselectImportFile(new File([cube.replace('0 0 0', '0 0 1')], 'look.cube')), false);
  assert.equal(await second.controller.reselectImportFile(file()), true);
  assert.equal(readFileSync(pendingPath, 'utf8'), before);
  assert.equal(statSync(pendingPath).ino, inode, 'read/recheck/reselect must not publish even identical bytes');
  assert.deepEqual(second.metadataWrites, []);
  assert.equal(second.calls.filter(([op]) => op === 'lut.import').length, 0);
  assert.deepEqual(second.edits, []);
  assert.equal(await second.controller.retryImport(), true);
  assert.deepEqual(second.calls.find(([op]) => op === 'lut.import')![1], original);
  assert.deepEqual(second.metadataWrites, ['complete']);
  assert.deepEqual(JSON.parse(readFileSync(pendingPath, 'utf8')).records, []);
  assert.deepEqual(second.edits, []);
});

test('missing desktop bridge blocks controller import without transient browser fallback or mutations', async t => {
  const userData = mkdtempSync(path.join(tmpdir(), 'mioon-lut-controller-'));
  t.after(() => rmSync(userData, { recursive: true, force: true }));
  const session = nativeSession(t, userData, { port: 42001, partition: 'random-session', bridgeMissing: true, importResult: importResponse });
  session.controller.open(); await tick(); await session.controller.checkRecovery();
  assert.equal(session.controller.getState().recoveryPhase, 'error');
  assert.equal(await session.controller.importFile(file()), false);
  assert.equal(session.calls.filter(([op]) => op === 'lut.import').length, 0);
  assert.deepEqual(session.edits, []); assert.deepEqual(readdirSync(userData), []);
});

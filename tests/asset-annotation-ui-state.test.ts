import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssetAnnotationController, annotationMatches, annotationRow, ANNOTATION_DRAFT_LIMIT } from '../apps/web/src/asset-annotation-state.ts';
import { createNativeCloseRegistry, createNativeCloseAdmission } from '../apps/web/src/native-close-state.ts';
const projectId = '00000000-0000-4000-8000-000000000001';
const assetId = '00000000-0000-4000-8000-000000000002';
interface RowValue { id: string; assetId: string; projectId: string; revision: number; note: string; tags: string[] }
type EntryView = { draft: { note: string; tags: string[] } | null; row: RowValue | null; conflict: boolean; dirty: boolean; uncertain?: boolean; verified?: boolean }
type Controller = ReturnType<typeof createAssetAnnotationController>
const idAt = (n: number): string => `00000000-0000-4000-8000-${String(n + 10).padStart(12, '0')}`;
const row = (id: string = assetId, revision = 0, note = '', tags: string[] = []): RowValue => ({ id, assetId: id, projectId, revision, note, tags });
const deferred = <T = unknown>(): { promise: Promise<T>; resolve: (value: T) => void } => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const tick = (): Promise<void> => new Promise<void>(resolve => { setImmediate(resolve); });
const entryOf = (controller: Controller, id: string): EntryView => { const entry = (controller.getState().entries as Record<string, EntryView | undefined>)[id]; assert.ok(entry); return entry; };
interface HarnessOptions {
  read?: (input: { assetIds: string[]; projectId?: string }) => Promise<{ projectId: string; items: RowValue[] }>;
  save?: (input: Record<string, unknown>) => Promise<unknown>;
  pendingAssetIds?: () => string[];
  hasPending?: (projectId?: string, assetId?: string, owner?: string) => boolean;
  ids?: string[];
}
function harness(options: HarnessOptions = {}) {
  let rows = new Map<string, RowValue>([[assetId, row()]]), pending = false, blocked = false, changed = 0;
  const calls: Record<string, unknown>[] = [];
  const ownerScope = JSON.stringify(['normal', projectId]);
  const controller = createAssetAnnotationController({
    read: options.read ?? (async (input: { assetIds: string[] }) => ({ projectId, items: input.assetIds.map((id: string) => rows.get(id) ?? row(id)) })),
    save: options.save ?? (async (input: Record<string, unknown>) => { calls.push(structuredClone(input)); const result = row(String(input.assetId), Number(input.expectedRevision) + 1, String(input.note), input.tags as string[]); rows.set(String(input.assetId), result); return { result }; }),
    pendingAssetIds: options.pendingAssetIds, canSave: () => !blocked, hasPending: options.hasPending ?? (() => pending), newRequestId: () => 'exact-request-0001', onChange: () => { changed++; },
  } as unknown as Parameters<typeof createAssetAnnotationController>[0]);
  controller.setContext({ scope: 'scope-1', ownerScope, projectId, assetIds: options.ids ?? [assetId] });
  return { controller, rows, ownerScope, calls, pending: (value: boolean) => { pending = value; }, blocked: (value: boolean) => { blocked = value; }, changed: () => changed };
}
test('bounded canonical tags, literal plain text, clear stages draft and independent revision save', async () => {
  const h = harness(); await tick(); const c = h.controller;
  c.editTagInput(assetId, ' e\u0301 '); c.addTag(assetId); c.editNote(assetId, '<b>literal</b>\n\tline');
  assert.deepEqual(entryOf(c,assetId).draft?.tags, ['é']);
  assert.equal(h.calls.length, 0); await c.save(assetId);
  assert.equal(h.calls[0]?.requestId, 'exact-request-0001'); assert.equal(h.calls[0]?.expectedRevision, 0);
  assert.equal(entryOf(c,assetId).row?.note, '<b>literal</b>\n\tline');
  c.clear(assetId); assert.equal(h.calls.length, 1); assert.equal(entryOf(c,assetId).dirty, true);
  await c.save(assetId); assert.equal(h.calls[1]?.expectedRevision, 1); assert.deepEqual(h.calls[1]?.tags, []); assert.equal(h.calls[1]?.note, '');
});
test('draft survives asset filtering, project navigation, stale reads, and explicit refresh never merges', async () => {
  const h = harness(); await tick(); const c = h.controller;
  c.editNote(assetId, 'my draft');
  c.setContext({ scope: 'other', ownerScope: 'other-project', projectId, assetIds: [idAt(1)] }); await tick();
  assert.equal(c.getState().dirtyCount, 1); assert.equal((c.getState().entries as Record<string, unknown>)[assetId], undefined);
  h.rows.set(assetId, row(assetId, 1, 'someone else'));
  c.setContext({ scope: 'returned', ownerScope: h.ownerScope, projectId, assetIds: [assetId] }); await tick();
  const e = entryOf(c,assetId); assert.ok(e.draft); assert.ok(e.row); assert.equal(e.draft.note, 'my draft'); assert.equal(e.row.note, 'someone else'); assert.equal(e.conflict, true);
  await c.save(assetId); assert.equal(h.calls.length, 0);
  c.discard(assetId); assert.ok(e.draft); assert.equal(e.draft.note, 'someone else'); assert.equal(e.conflict, false);
});
test('delayed historical ACK never regresses newer read and cannot silently overwrite it', async () => {
  const ack = deferred<{ result: RowValue }>(); let input: Record<string, unknown> | undefined;
  const h = harness({ save: async (value: Record<string, unknown>) => { input = value; return ack.promise; } }); await tick();
  h.controller.editNote(assetId, 'saved one'); const saving = h.controller.save(assetId);
  h.rows.set(assetId, row(assetId, 2, 'newer two')); await h.controller.refresh();
  assert.equal(entryOf(h.controller,assetId).row?.revision, 2);
  assert.ok(input); ack.resolve({ result: row(assetId, 1, String(input.note), input.tags as string[]) }); await saving;
  assert.equal(entryOf(h.controller,assetId).row?.revision, 2);
  assert.equal(entryOf(h.controller,assetId).draft?.note, 'newer two');
});
test('uncertain request blocks rekey, clear and discard until exact session receipt resolves', async () => {
  let h: ReturnType<typeof harness>; h = harness({ save: async () => { h.pending(true); return { result: null, failure: { error: new Error('lost'), dispatched: true, rejected: false } }; } }); await tick();
  const c = h.controller; c.editNote(assetId, 'keep'); await c.save(assetId);
  assert.equal(entryOf(c,assetId).uncertain, true); assert.equal(c.getCloseState().blocked, true);
  c.clear(assetId); c.discard(assetId); c.discardRetained(c.getState().version); assert.equal(entryOf(c,assetId).draft?.note, 'keep');
  h.rows.set(assetId, row(assetId, 2, 'latest')); h.pending(false); c.syncPending(); await c.refresh();
  assert.equal(entryOf(c,assetId).draft?.note, 'keep'); assert.equal(entryOf(c,assetId).conflict, true);
});
test('old-workspace uncertainty uses its original owner after navigation', async () => {
  const original = JSON.stringify(['normal', projectId]); let uncertain = false; const owners: (string | undefined)[] = [];
  const h = harness({ hasPending: (_project?: string, _asset?: string, owner?: string) => { owners.push(owner); return owner === original && uncertain; }, save: async () => { uncertain = true; return { result: null, failure: { error: {}, dispatched: true, rejected: false } }; } }); await tick();
  h.controller.editNote(assetId, 'preserve'); await h.controller.save(assetId);
  h.controller.setContext({ scope: 'restored', ownerScope: JSON.stringify(['restored:branch', projectId]), projectId, assetIds: [assetId] }); await tick();
  h.controller.syncPending(); h.controller.discardRetained(h.controller.getState().version);
  assert.equal(h.controller.getState().uncertainCount, 1); assert.equal(h.controller.getState().dirtyCount, 1); assert.ok(owners.includes(original));
});
test('32 dirty owner cap blocks new drafts without evicting old ones', async () => {
  const ids = Array.from({ length: 33 }, (_, i) => idAt(i)), h = harness({ ids }); await tick();
  for (const id of ids) h.controller.editNote(id, 'draft');
  assert.equal(h.controller.getState().dirtyCount, ANNOTATION_DRAFT_LIMIT);
  assert.equal(entryOf(h.controller,ids[32]).dirty, false); assert.equal((h.controller.getState().error as { key?: string } | null)?.key, 'annotations.capacity');
});
test('unknown tags stay visible, validation error does not erase verified tags', async () => {
  const h = harness(); await tick(); h.rows.set(assetId, row(assetId, 1, '', ['tag'])); await h.controller.refresh();
  h.controller.editTagInput(assetId, 'tag'); h.controller.addTag(assetId);
  assert.ok(annotationRow(h.controller.getState(), assetId)); assert.equal(annotationMatches(h.controller.getState(), assetId, 'other'), false);
  assert.equal(annotationMatches(h.controller.getState(), 'unknown', 'tag'), true);
});
test('StrictMode cleanup/setup keeps controller usable and does not lose dirty draft', async () => {
  const h = harness(); await tick(); h.controller.editNote(assetId, 'draft'); h.controller.dispose(); h.controller.activate(); await tick();
  assert.equal(entryOf(h.controller,assetId).draft?.note, 'draft'); h.controller.editNote(assetId, 'next'); assert.equal(entryOf(h.controller,assetId).draft?.note, 'next');
});
test('unchanged pending scan does not emit and stale close tickets fail after draft changes', async () => {
  const h = harness(); await tick(); const before = h.changed(); h.controller.syncPending(); assert.equal(h.changed(), before);
  const registry = createNativeCloseRegistry(), source = registry.register('asset-annotations'); source.update(h.controller.getCloseState());
  const settings = { capture: () => [], canLeave: () => true, needsConfirmation: () => false };
  const admission = createNativeCloseAdmission({ registry, settings, readScope: () => 's', readDocumentURL: () => 'app', now: () => 1000, newToken: () => 'token' });
  const ticket = admission.inspect(); assert.equal(ticket.disposition, 'clean');
  h.controller.editNote(assetId, 'changed'); source.update(h.controller.getCloseState());
  assert.equal(admission.commit(ticket.token, { discardDirty: true, allowDrainFailure: false, expiresAt: 2000 }), false);
  assert.equal(admission.inspect().disposition, 'dirty');
});

test('cap includes unloaded pending owners and never evicts preexisting overflow receipts', async () => {
  let pendingIds = [idAt(100)]; const ids = Array.from({ length: 33 }, (_, i) => idAt(i));
  const h = harness({ ids, pendingAssetIds: () => pendingIds }); await tick();
  for (const id of ids) h.controller.editNote(id, 'draft');
  assert.equal(h.controller.getState().dirtyCount, 31); assert.equal(h.controller.getState().retainedCount, 32);
  assert.equal(h.controller.getCloseState().blocked, true);
  pendingIds = Array.from({ length: 40 }, (_, i) => idAt(100 + i)); h.controller.syncPending();
  h.controller.editNote(ids[31], 'not admitted'); assert.equal(entryOf(h.controller,ids[31]).dirty, false);
  h.controller.discardRetained(h.controller.getState().version);
  assert.equal(h.controller.getState().retainedCount, 40); assert.equal(h.controller.getCloseState().blocked, true);
});

test('unchanged metadata refresh does not invalidate native-close draft identity', async () => {
  const h = harness(); await tick(); h.controller.editNote(assetId, 'draft'); const before = h.controller.getCloseState();
  await h.controller.refresh(); assert.deepEqual(h.controller.getCloseState(), before);
  h.controller.editNote(assetId, 'changed draft'); assert.ok(h.controller.getCloseState().version > before.version);
});

test('UI reads every loaded asset in bounded batches and rejects a whole malformed batch', async () => {
  const ids = Array.from({ length: 237 }, (_, i) => idAt(i)), calls: string[][] = [];
  const h = harness({ ids, read: async (input: { assetIds: string[] }) => { calls.push(input.assetIds); return { projectId, items: input.assetIds.map((id: string) => row(id)) }; } }); await tick();
  assert.deepEqual(calls.map(ids => ids.length), [100, 100, 37]); assert.deepEqual(calls.flat(), ids);
  assert.equal(Object.values(h.controller.getState().entries as Record<string, EntryView | undefined>).filter((e: EntryView | undefined) => e?.verified).length, 237);
  const bad = harness({ ids: ids.slice(0, 2), read: async (input: { assetIds: string[] }) => ({ projectId, items: [row(input.assetIds[0] as string)] }) }); await tick();
  assert.equal(Object.values(bad.controller.getState().entries as Record<string, EntryView | undefined>).filter((e: EntryView | undefined) => e?.verified).length, 0);
});
test('repeated save cannot dispatch twice and exact immutable request survives draft identity', async () => {
  const ack = deferred<{ result: RowValue }>(); let input: Record<string, unknown> | undefined, calls = 0;
  const h = harness({ save: async (value: Record<string, unknown>) => { input = value; calls++; return ack.promise; } }); await tick();
  h.controller.editNote(assetId, 'once'); const pending = h.controller.save(assetId); await h.controller.save(assetId);
  assert.equal(calls, 1); assert.ok(input); assert.ok(Object.isFrozen(input)); assert.ok(Object.isFrozen(input.tags));
  h.controller.editNote(assetId, 'not while saving'); assert.equal(input.note, 'once');
  h.rows.set(assetId, row(assetId, 1, 'once')); ack.resolve({ result: row(assetId, 1, 'once') }); await pending;
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createOpacityRestoredApplicationInspection} from '../packages/contracts/src/opacity-restored-application.ts';
import {createRestoredOpacityCandidateClipDraftClient, createOpacityCandidateClipDraftClient,
  isRestoredOpacityCandidateClipDraftClient, matchesRestoredOpacityClipDraftOrigin, clipDraftFailure,
type OpacityCandidateClipDraftClient} from '../apps/web/src/clip-draft-client.ts';
import {createClipDraftController} from '../apps/web/src/clip-draft-state.ts';
import {retainClipInspector} from '../apps/web/src/clip-inspector-retention.ts';

const id = (n: number) => `bc000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspace = () => createOpacityRestoredApplicationInspection({schemaVersion: 43, sourceSchema: 42, profile: 'restored-local-v10',
  workspaceOrigin: id(1), restorationId: id(2), sourceBackupId: id(3), manifestHash: 'a'.repeat(64), sourceDbHash: 'b'.repeat(64), createdAt: '2026-10-16T00:00:00.000Z', heldCounts: {}});
const key = {projectId: id(4), timelineId: id(5), clipId: id(6)}, authority = {workspaceScope: 'c'.repeat(64), instanceId: id(7)};
const source = {assetId: id(8), assetSha256: 'd'.repeat(64)};
const raw = {name: 'Unfinished 日本語', trackId: id(9), startFrame: '0', durationFrames: '10', sourceInFrame: '0', gain: '1', rect: {x: 0, y: 0, width: 720, height: 1280},
  opacityEnvelope: {profileId: 'mioon-clip-linear-opacity-v1', points: [{frame: '0', opacity: '.'}, {frame: '10', opacity: '1'}]}};
const envelope = () => ({supported: true, schemaVersion: 1, profileId: workspace().localClipDrafts!.profileId, workspaceOrigin: id(1), ...authority, key, revision: 1,
  targetStatus: 'matching', draft: {raw: structuredClone(raw), baseRevision: 3, source, updatedAt: '2026-10-16T00:00:00.000Z'}});
const input = () => ({...key, ...authority, expectedRevision: 0, baseRevision: 3, source, raw: structuredClone(raw)});
const response = (data: { key?: { projectId: string; timelineId: string; clipId: string; }; revision?: number; targetStatus?: string; draft?: { raw: { name: string; trackId: string; startFrame: string; durationFrames: string; sourceInFrame: string; gain: string; rect: { x: number; y: number; width: number; height: number; }; opacityEnvelope: { profileId: string; points: { frame: string; opacity: string; }[]; }; }; baseRevision: number; source: { assetId: string; assetSha256: string; }; updatedAt: string; }|null; workspaceScope?: string; instanceId?: string; supported: boolean; schemaVersion?: number; profileId?: "mioon-opacity-restored-draft-v1"; workspaceOrigin?: string; reason?: string; }) => new Response(JSON.stringify({ok: true, data}));
const unknown = (error: unknown) => {assert.equal(clipDraftFailure(error).kind, 'unknown');return true;};
const context = (extra?: OpacityCandidateClipDraftClient|{ workspaceOrigin: string; restored?: undefined; }|{ restored: boolean; workspaceOrigin?: undefined; }|{ workspaceOrigin?: undefined; restored?: undefined; }|undefined) => ({...key, scope: 'owned43', restored: true, workspaceOrigin: id(1), connected: true, visible: true, busy: false,
  opacityEnvelopeEditable: true, timelineRevision: 3, source, saved: {...raw, opacityEnvelope: {...raw.opacityEnvelope, points: [{frame: '0', opacity: '.25'}, {frame: '10', opacity: '1'}]}}, ...extra});

test('fixed43 client injects origin/version on its separate endpoint and validates before projecting the original CAS envelope', async () => {
  const calls: {url: URL|RequestInfo;init:RequestInit|undefined}[] = [], client = createRestoredOpacityCandidateClipDraftClient(workspace(), async (url, init) => {calls.push((({url, init}) as unknown as Parameters<typeof calls.push>[0]));return response(envelope());});
  const expected = envelope(); delete (expected as unknown as Record<PropertyKey,unknown>).schemaVersion;delete (expected as unknown as Record<PropertyKey,unknown>).profileId;delete (expected as unknown as Record<PropertyKey,unknown>).workspaceOrigin;
  assert.deepEqual(await client.get(key), expected);assert.deepEqual(await client.put((input() as unknown as Parameters<typeof client.put>[0])), expected);
  assert.deepEqual(await client.remove({...key, ...authority, expectedRevision: 1}), expected);
  const query = new URL(calls[0].url as string, 'http://synthetic.invalid');assert.equal(query.pathname, '/api/local-drafts/restored43/clip');
  assert.deepEqual(Object.fromEntries(query.searchParams), {...key, schemaVersion: '1', expectedWorkspaceOrigin: id(1)});
  assert.deepEqual(JSON.parse((calls[1].init!.body! as string)), {...input(), schemaVersion: 1, expectedWorkspaceOrigin: id(1)});
  assert.equal(JSON.parse((calls[2].init!.body! as string)).expectedWorkspaceOrigin, id(1));
  assert.deepEqual(expected.draft.raw.opacityEnvelope.points, raw.opacityEnvelope.points);
});

test('43 client requires an exact present capability and its marker cannot be copied or authorized by a context flag', async t => {
  let calls = 0; const fetcher = async () => {calls++;return response(envelope());};
  const old = workspace();delete (old as unknown as Record<PropertyKey,unknown>).localClipDrafts;
  for (const value of [old, {...workspace(), localClipDrafts: {...workspace().localClipDrafts, extra: true}}, {...workspace(), localClipDrafts: null}, {restored: true}] as const)
    assert.throws(() => createRestoredOpacityCandidateClipDraftClient(value, fetcher), {code: 'LOCAL_DRAFT_VALIDATION'});
  const client = createRestoredOpacityCandidateClipDraftClient(workspace(), fetcher);
  assert.equal(matchesRestoredOpacityClipDraftOrigin(client, id(1)), true);
  for (const copied of [{...client}, Object.create(client), new Proxy(client, {})] as const) assert.equal(isRestoredOpacityCandidateClipDraftClient(copied), false);
  for (const [value, extra] of [[client, {workspaceOrigin: id(2)}], [client, {restored: false}], [createOpacityCandidateClipDraftClient(fetcher), {}], [{...client}, {}]] as const) {
    const controller = (createClipDraftController({client: value, context: (context(extra) as unknown as import('../apps/web/src/clip-draft-state.ts').ClipDraftContext), delay: 60000}) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityDraftController);t.after(() => controller.dispose());
    assert.equal(controller.supportsRestoredPersistence(), false);await controller.load();
    controller.edit('name', 'new input');await controller.flush();assert.equal(await controller.flushForClose(), false);
    assert.equal(controller.getState().raw.name, 'new input');
  }
  assert.equal(calls, 0);
  await assert.rejects(client.get((({...key, schemaVersion: 1}) as unknown as Parameters<typeof client.get>[0])), {code: 'LOCAL_DRAFT_VALIDATION'});
  await assert.rejects(client.put((({...input(), expectedWorkspaceOrigin: id(2)}) as unknown as Parameters<typeof client.put>[0])), {code: 'LOCAL_DRAFT_VALIDATION'});assert.equal(calls, 0);
});

test('43 client rejects missing, altered, cross-origin or surplus response metadata as unknown, never accepts v3/unsupported fallback', async () => {
  for (const mutate of [(v: { schemaVersion: unknown; }) => {delete (v as unknown as Record<PropertyKey,unknown>).schemaVersion;}, (v: { profileId: unknown; }) => {delete (v as unknown as Record<PropertyKey,unknown>).profileId;}, (v: { workspaceOrigin: string; }) => {v.workspaceOrigin = id(2);}, (v: { schemaVersion: number; }) => {v.schemaVersion = 3;},
(    v: { profileId: string; }) => {v.profileId = 'mioon-workspace-v42';}, (v: { extra: boolean; }) => {v.extra = true;}] as const) {
    const data = envelope();(mutate as unknown as (value:unknown)=>void)(((((data as unknown as Parameters<typeof mutate>[0])))));let calls = 0;
    const client = createRestoredOpacityCandidateClipDraftClient(workspace(), async () => {calls++;return response(data);});
    await assert.rejects(client.put((input() as unknown as Parameters<typeof client.put>[0])), unknown);assert.equal(calls, 1);
  }
  const client = createRestoredOpacityCandidateClipDraftClient(workspace(), async () => response({supported: false, reason: 'RESTORED_WORKSPACE_UNSUPPORTED'}));
  await assert.rejects(client.get(key), unknown);
});

test('retained43 snapshot keeps its original origin through dirty/composing interruptions and controller refuses a replacement context', async t => {
  const original = {...key, key: 'same-key', scope: 'same-scope', timeline: {id: key.timelineId, revision: 3}, clip: {id: key.clipId, assetId: source.assetId},
    asset: {sha256: source.assetSha256}, restored: true, workspaceOrigin: id(1)};
  const replacement = {...original, workspaceOrigin: id(2)};
  for (const pending of [false, true] as const) {
    const held = retainClipInspector({snapshot: original, retained: false}, replacement, {pending, dirty: true, connected: true});
    assert.equal(held.snapshot, original);assert.equal(held.snapshot.workspaceOrigin, id(1));assert.equal(held.retained, true);
    const settled = retainClipInspector(held, replacement, {pending: false, dirty: false, connected: true});assert.equal(settled.snapshot, replacement);
  }
  const calls: (string|undefined)[] = [], client = createRestoredOpacityCandidateClipDraftClient(workspace(), async (_url, init) => {calls.push(init!.method);return response({...envelope(), revision: 0, draft: null});});
  const controller = (createClipDraftController({client, context: (context() as unknown as import('../apps/web/src/clip-draft-state.ts').ClipDraftContext), delay: 60000}) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityDraftController);t.after(() => controller.dispose());
  await controller.load();controller.edit('name', 'Original dirty owner');const owner = controller.capture();
  controller.setContext((context({workspaceOrigin: id(2)}) as unknown as Parameters<typeof controller.setContext>[0]));await controller.flush();
  assert.equal(controller.isCurrent(owner), false);assert.equal(controller.getState().raw.name, 'Original dirty owner');
  assert.equal(await controller.flushForClose(), false);assert.deepEqual(calls, ['GET']);
});

for (const failure of ['bad-file', 'unknown-put'] as const) test(`43 ${failure} retains raw input through Cancel, business ACK and close`, async t => {
  const calls = [];const client = createRestoredOpacityCandidateClipDraftClient(workspace(), async (_url, init) => {
    calls.push(init!.method);
    if (init!.method === 'GET' && failure !== 'bad-file') return response({...envelope(), revision: 0, draft: null});
    if (failure === 'unknown-put') return response({...envelope(), workspaceOrigin: id(2)});
    return new Response(JSON.stringify({ok: false, error: {code: 'LOCAL_DRAFT_STORAGE_UNAVAILABLE', message: 'Owned bad file', details: {}, retryable: false}}), {status: 503});
  });
  const controller = (createClipDraftController({client, context: (context() as unknown as import('../apps/web/src/clip-draft-state.ts').ClipDraftContext), delay: 60000, validateTimeline: () => true}) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityDraftController);t.after(() => controller.dispose());
  await controller.load();controller.edit('name', 'Retained newer input');if (failure === 'unknown-put') await controller.flush();
  const before = structuredClone(controller.getState().raw), count = calls.length;
  assert.equal(controller.getState().autosavePaused, true);assert.equal(await controller.discard(controller.capture()), false);
  let businessCalls = 0;
  const saved = await controller.save(async (clipId, patch, revision) => {businessCalls++;return {id: key.timelineId, projectId: key.projectId, revision: revision + 1, clips: [{id: clipId, assetId: source.assetId, opacityEnvelope: {profileId: raw.opacityEnvelope.profileId, points: [{frame: 0, opacity: .25}, {frame: 10, opacity: 1}]}, ...patch}]};});
  assert.ok(saved);assert.equal(businessCalls, 1);assert.equal(controller.getState().dirty, true, 'a business ACK does not erase unresolved local storage evidence');
  assert.equal(await controller.flushForClose(), false);assert.deepEqual(controller.getState().raw, before);
  assert.equal(calls.length, count, 'no implicit retry, DELETE or fallback');assert.equal(controller.hasUnpersisted(), true);
});

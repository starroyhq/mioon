import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { createClipDraftClient } from '../apps/web/src/clip-draft-client.ts';
import { createClipDraftController } from '../apps/web/src/clip-draft-state.ts';

const id = (n: number) => `c9000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = { projectId: id(1), timelineId: id(2), clipId: id(3) };
const source = { assetId: id(5), assetSha256: 'a'.repeat(64) };
const raw = { name: 'Saved', trackId: id(4), startFrame: 0, durationFrames: 60, sourceInFrame: 0, gain: 1,
  rect: { x: 0, y: 0, width: 1280, height: 720 } };
interface StoredDraft {baseRevision?: unknown; source?: unknown; raw: {name: string}; updatedAt: string}
type Stored = Omit<typeof initialBase, 'draft'> & {draft: StoredDraft | null};
const initialBase = { supported: true, workspaceScope: 'b'.repeat(64), instanceId: id(6), key,
  revision: 0, targetStatus: 'matching', draft: null as StoredDraft | null };
const initial: Stored = initialBase;
const response = (data: unknown) => new Response(JSON.stringify({ ok: true, data }));
const turn = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('real bounded client timeout keeps controller unknown through empty GET and later original PUT commit', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const gate = Promise.withResolvers<void>(), calls: Array<{method?: string; input: {baseRevision?: unknown; source?: unknown; raw?: unknown; expectedRevision?: unknown} | null; signal?: AbortSignal}> = []; let stored: Stored = structuredClone(initial);
  const client = createClipDraftClient((async (_url: string, init: {body?: string; method?: string; signal?: AbortSignal} = {}) => {
    const input = init.body ? JSON.parse(init.body) as {baseRevision?: unknown; source?: unknown; raw?: unknown; expectedRevision?: unknown} : null;
    calls.push({ method: init.method, input, signal: init.signal });
    if (init.method === 'GET') return response(stored);
    assert.equal(init.method, 'PUT');
    await gate.promise;
    // The synthetic server still commits the originally accepted bytes after
    // transport timeout. An AbortSignal does not revoke server authority.
    assert.equal(input!.expectedRevision, stored.revision);
    stored = { ...stored, revision: stored.revision + 1, draft: {
      baseRevision: input!.baseRevision, source: input!.source, raw: input!.raw as {name: string}, updatedAt: '2026-10-12T21:00:00.000Z',
    } };
    return response(stored);
  }) as unknown as typeof fetch, { timeoutMs: 25 });
  const controller = createClipDraftController({ client, delay: 250, context: { ...key, scope: 'same-owner',
    restored: false, connected: true, busy: false, visible: true, timelineRevision: 7, source, saved: raw } });
  t.after(() => controller.dispose());
  await controller.load(); controller.edit('name', 'Original uncertain input');
  const writing = controller.flushForClose(); await turn();
  const original = structuredClone(calls.find(call => call.method === 'PUT')!.input);
  t.mock.timers.tick(25); await turn(); assert.equal(await writing, false);
  assert.equal((controller.getState().failure as {kind: string}).kind, 'unknown');
  assert.equal((controller.getState().failure as {code: string}).code, 'LOCAL_DRAFT_TIMEOUT_UNKNOWN');
  assert.equal(calls.find(call => call.method === 'PUT')!.signal!.aborted, true);
  await controller.load(); assert.equal(stored.draft, null);
  assert.equal(controller.getState().autosavePaused, true, 'Empty observation cannot revoke original PUT');
  assert.equal(await controller.flushForClose(), false);
  gate.resolve(); await turn();
  assert.equal(stored.revision, 1); assert.equal(stored.draft!.raw.name, 'Original uncertain input');
  assert.equal((controller.getState().failure as {kind: string}).kind, 'unknown', 'Late client ACK is not accepted as new authority');
  assert.equal((controller.getState().raw as {name: string}).name, 'Original uncertain input');
  assert.deepEqual(calls.filter(call => call.method === 'PUT').map(call => call.input), [original]);
  t.mock.timers.tick(1000); await turn();
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
  assert.equal(calls.some(call => call.method === 'DELETE' || call.method === 'POST'), false);
});

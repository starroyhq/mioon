import test from 'node:test';
import assert from 'node:assert/strict';
import { createComparisonPlayback } from '../apps/web/src/comparison-playback.ts';
import { comparisonDetailRows } from '../apps/web/src/comparison-details.ts';
import { captureComparison } from '../apps/web/src/version-comparison-state.ts';

interface Deferred<T> {readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void}
const deferred = <T = void>(): Deferred<T> => { let resolve!: (value: T)=>void, reject!: (error: unknown)=>void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
interface FixturePlayer {isConnected: boolean; paused: boolean; ended: boolean; duration: number; currentTime: number; plays: number; pauses: number; play(): Promise<void>; pause(): void}
interface FixtureState {pending?: boolean; playing?: boolean}
function fixture() {
  let valid = true, owner = 0, errors = 0;
  const states: FixtureState[] = [], holds: Deferred<void>[] = [deferred(), deferred()];
  const players: [FixturePlayer, FixturePlayer] = holds.map((hold): FixturePlayer => ({ isConnected: true, paused: true, ended: false, duration: 4, currentTime: 0, plays: 0, pauses: 0,
    play() { this.plays++; this.paused = false; return hold.promise; }, pause() { this.pauses++; this.paused = true; } })) as unknown as [FixturePlayer, FixturePlayer];
  const pair = { key: 'exact-pair-1', players };
  const controller = createComparisonPlayback({ isCurrent: (value: unknown) => valid && value === pair, beforePlay: () => owner++, onChange: (state: FixtureState) => states.push(state), onError: () => errors++ });
  return { controller, pair, players, holds, states, owner: () => owner, errors: () => errors, valid: (value: boolean) => { valid = value; } };
}
test('explicit shared start owns both players once and a partial play rejection pauses both', async () => {
  const h = fixture(), playing = h.controller.play(h.pair); await tick();
  assert.equal(h.owner(), 1); assert.deepEqual(h.players.map((player: FixturePlayer) => player.plays), [1, 1]);
  assert.equal(h.controller.guard(h.players[0] as never), true); assert.equal(h.states.at(-1)?.pending, true);
  await h.controller.play(h.pair); assert.equal(h.owner(), 1);
  h.holds[1]!.reject(Error('decoder unavailable')); await tick();
  assert.ok(h.players.every((player: FixturePlayer) => player.paused), 'first failure pauses the peer before its promise settles');
  h.holds[0]!.resolve(undefined); await playing;
  assert.ok(h.players.every((player: FixturePlayer) => player.paused)); assert.equal(h.errors(), 1);
  assert.deepEqual(h.states.at(-1), { pending: false, playing: false });
});
test('closing, source change, or explicit pause fences late success and cancellation is not a media error', async () => {
  for (const retire of ['scope', 'pause']) {
    const h = fixture(), playing = h.controller.play(h.pair); await tick();
    if (retire === 'scope') h.valid(false);
    h.controller.stop(); assert.ok(h.players.every((player: FixturePlayer) => player.paused));
    assert.equal(h.controller.guard(h.players[0] as never), false);
    await h.controller.play(h.pair); assert.equal(h.owner(), 1, 'a pending old play cannot overlap the same decoders');
    h.holds[0]!.resolve(undefined); h.holds[1]!.reject(Error('AbortError after cancellation')); await playing;
    assert.equal(h.errors(), 0); assert.ok(h.players.every((player: FixturePlayer) => player.paused));
    assert.equal(h.states.at(-1)?.playing, false);
  }
});
test('owner callback revalidation prevents either decoder from starting after navigation', async () => {
  let current = true, plays = 0;
  const player: FixturePlayer = { isConnected: true, paused: true, ended: false, duration: 4, currentTime: 0, plays: 0, pauses: 0, play: async () => { plays++; }, pause() {} };
  const controller = createComparisonPlayback({ isCurrent: () => current, beforePlay: () => { current = false; }, onChange() {}, onError() {} });
  await controller.play({ key: 'pair', players: [player, player] } as never); assert.equal(plays, 0);
});
test('shared seek uses the shorter source and a seek failure stops both sources', async () => {
  const h = fixture(); h.players[1].duration = 3;
  assert.equal(h.controller.seek(h.pair, 99), true); assert.deepEqual(h.players.map((player: FixturePlayer) => player.currentTime), [3, 3]);
  Object.defineProperty(h.players[1], 'currentTime', { set() { throw Error('unseekable'); } });
  assert.equal(h.controller.seek(h.pair, 1), false); assert.equal(h.errors(), 1);
  h.valid(false); assert.equal(h.controller.seek(h.pair, 2), false);
});

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('parameter differences use frozen source references and seed without current shot fallbacks', () => {
  interface SnapshotShape {prompt: string; duration: number; referenceAssetIds: string[]; parameters: {seed: number}}
  interface VersionShape {id: string; projectId: string; shotId: string; assetId: string; sha256: string; number: number; model: string; snapshot: SnapshotShape}
  const context = { scope: 'project:epoch', projectId: id(1), workspaceOrigin: 'normal', connected: true, visible: true, restored: false,
    shot: { id: id(2), projectId: id(1), prompt: 'mutable prompt', duration: 100 },
    versions: [3, 4].map((n: number): VersionShape => ({ id: id(n), projectId: id(1), shotId: id(2), assetId: id(n + 10), sha256: 'a'.repeat(64), number: n, model: 'same-model', snapshot: { prompt: `saved ${n}`, duration: 4, referenceAssetIds: [id(n + 20)], parameters: { seed: n } } })),
    assets: [13, 14].map((n: number) => ({ id: id(n), projectId: id(1), sha256: 'a'.repeat(64), mimeType: 'video/mp4' })) };
  const a = captureComparison(context as never, id(3)), b = captureComparison(context as never, id(4));
  const rows = comparisonDetailRows(a as never, b as never) as unknown as {key: string; different: boolean; values: unknown[]}[];
  assert.equal(rows.find((row: {key: string}) => row.key === 'model')!.different, false);
  assert.deepEqual(rows.filter((row: {different: boolean}) => row.different).map((row: {key: string}) => row.key), ['references', 'prompt', 'seed']);
  assert.equal(rows.find((row: {key: string}) => row.key === 'duration')!.values[0], 4);
  context.versions[0]!.snapshot.parameters.seed = 10;
  assert.equal((a as {metadata: {seed: unknown}}).metadata.seed, 3); assert.notEqual((captureComparison(context as never, id(3)) as {key: unknown}).key, (a as {key: unknown}).key);
});

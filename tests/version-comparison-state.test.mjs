import test from 'node:test';
import assert from 'node:assert/strict';
import { captureComparison, comparisonAvailable, comparisonCurrent, comparisonOptions, comparisonPairCurrent } from '../apps/web/src/version-comparison-state.ts';
import { comparisonMessages } from '../packages/i18n/src/catalogs/comparison.ts';
import { validateCatalogs } from '../packages/i18n/src/index.ts';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = 'a'.repeat(64);
export function fixture() {
  return { scope: 'project:epoch:normal', projectId: id(1), workspaceOrigin: 'normal', connected: true, visible: true, restored: false,
    shot: { id: id(2), projectId: id(1), title: 'Current mutable title', selectedVersionId: id(3), duration: 99, aspectRatio: 'mutable' },
    versions: [3, 4, 5].map((n, at) => ({ id: id(n), projectId: id(1), shotId: id(2), assetId: id(n + 10), sha256: hash, number: at + 1, providerId: 'mock', model: 'fixed-model', isMock: true, createdAt: '2026-10-15T00:00:00Z', url: 'https://untrusted.invalid/media', snapshot: { prompt: `literal <script> ${n}`, duration: n, aspectRatio: '16:9' } })),
    assets: [13, 14, 15].map(n => ({ id: id(n), projectId: id(1), sha256: hash, mimeType: 'video/mp4', url: 'https://untrusted.invalid/asset' })) };
}
test('explicit pair preserves nonlatest identities and frozen metadata across list/new-current changes', () => {
  const c = fixture(), a = captureComparison(c, id(3)), b = captureComparison(c, id(4));
  assert.equal(a.number, 1); assert.equal(a.metadata.duration, 3); assert.ok(comparisonPairCurrent(a, b, c));
  assert.equal(captureComparison(c, ''), null); assert.equal(comparisonPairCurrent(a, a, c), false);
  c.versions.reverse(); c.shot.selectedVersionId = id(5); c.shot.duration = 555; c.shot.title = 'new mutable title';
  assert.ok(comparisonCurrent(a, c)); assert.ok(comparisonCurrent(b, c)); assert.deepEqual(comparisonOptions(c).map(v => v.number), [3, 2, 1]);
  assert.ok(Object.isFrozen(a)); assert.ok(Object.isFrozen(a.metadata));
  assert.ok(a.url.startsWith('/api/version-comparison/media?')); assert.doesNotMatch(a.url, /untrusted/);
  const parsed = new URL(a.url, 'http://local'); assert.equal(parsed.searchParams.get('versionId'), id(3)); assert.equal(parsed.searchParams.get('assetId'), id(13)); assert.equal(parsed.searchParams.get('workspaceOrigin'), 'normal');
});
test('each cross-scope and malformed identity fails closed', () => {
  const mutations = [c => c.projectId = id(90), c => c.shot.projectId = id(90), c => c.shot.id = id(90),
    c => c.versions[0].projectId = id(90), c => c.versions[0].shotId = id(90), c => c.versions[0].assetId = id(90),
    c => c.versions[0].sha256 = 'b'.repeat(64), c => c.assets[0].projectId = id(90), c => c.assets[0].sha256 = 'bad', c => c.assets[0].mimeType = 'image/png',
    c => c.versions.push(c.versions[0]), c => c.assets.push(c.assets[0]), c => c.versions[0].number = NaN, c => c.versions[0].id = '../bad'];
  for (const mutate of mutations) { const c = fixture(); mutate(c); assert.equal(captureComparison(c, id(3)), null); }
});
test('offline hidden restored unknown-workspace and scope changes revoke earlier bindings', () => {
  for (const patch of [{ connected: false }, { visible: false }, { restored: true }, { workspaceOrigin: null }, { workspaceOrigin: 'restored:any' }, { scope: null }, { shot: null }]) {
    const c = fixture(), a = captureComparison(c, id(3)); Object.assign(c, patch); assert.equal(comparisonAvailable(c), false); assert.equal(comparisonCurrent(a, c), false);
  }
  const c = fixture(), a = captureComparison(c, id(3)); c.scope = 'new epoch'; assert.equal(comparisonCurrent(a, c), false);
});
test('changed immutable metadata is stale; missing fields never use mutable shot defaults', () => {
  for (const mutate of [c => c.versions[0].snapshot.prompt = 'changed', c => c.versions[0].snapshot.duration = 99, c => c.versions[0].model = 'changed', c => c.versions.shift(), c => c.assets.shift()]) {
    const c = fixture(), a = captureComparison(c, id(3)); mutate(c); assert.equal(comparisonCurrent(a, c), false);
  }
  const c = fixture(); c.versions[0].snapshot = {}; delete c.versions[0].model; delete c.versions[0].createdAt;
  const a = captureComparison(c, id(3)); assert.equal(a.metadata.duration, null); assert.equal(a.metadata.aspectRatio, null); assert.equal(a.metadata.model, null); assert.equal(a.metadata.createdAt, null);
});
test('four-locale comparison copy has exact placeholder parity', () => { assert.deepEqual(validateCatalogs(comparisonMessages), []); });

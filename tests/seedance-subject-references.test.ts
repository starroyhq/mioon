import test from 'node:test';
import assert from 'node:assert/strict';
import * as contracts from '@mioon/contracts';
import * as settings from '../apps/web/src/generation-settings.ts';
import {seedanceReferenceRules, subjectReferenceLabel, subjectReferencePlan} from '../apps/web/src/subject-video.ts';
import type {SubjectReferenceRules, SubjectReferenceStateLike} from '../apps/web/src/subject-video.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), shotId = id(2);
const rules: SubjectReferenceRules = {mimeTypes: ['image/png', 'image/jpeg'], maxBytes: 10 * 1024 * 1024, minDimension: 300, maxDimension: 6000,
  minAspectRatio: .4, maxAspectRatio: 2.5, maxImages: 30, maxEncodedBytes: 60_000_000};
const asset = (n: number, patch: Record<string, unknown> = {}) => ({id: id(n), projectId, name: `素材 ${n}`, mimeType: 'image/png', sha256: String(n % 10).repeat(64), width: 900, height: 1600, sizeBytes: 1000, ...patch});
const version = (subject: number, n: number, number: number, patch: Record<string, unknown> = {}) => {
  const image = asset(n, patch);
  return {id: id(1000 + n), subjectId: id(subject), projectId, number, assetId: image.id, sha256: image.sha256, mimeType: image.mimeType, width: image.width, height: image.height};
};
const subject = (n: number, name: string, kind: string, head: ReturnType<typeof version>) => ({id: id(n), projectId, name, kind, revision: head.number, headVersionId: head.id, headVersion: head});
const binding = (n: number, subjectN: number, role: string, versionId: string | null, createdAt: string, needsReview = false) =>
  ({id: id(500 + n), subjectId: id(subjectN), role, subjectVersionId: versionId, needsReview, createdAt});
function fixture() {
  // Bound in this order: style first, then the product, a location, the character.
  const look = version(10, 11, 1), product = version(20, 21, 3), place = version(30, 31, 1, {mimeType: 'image/webp'}), hero = version(40, 41, 2), heroOld = version(40, 42, 1);
  const assets = [asset(11), asset(21), asset(31, {mimeType: 'image/webp'}), asset(41), asset(42)];
  const state: SubjectReferenceStateLike = {
    subjects: {[id(10)]: subject(10, '胶片风格', 'look', look), [id(20)]: subject(20, '保温杯', 'product', product), [id(30)]: subject(30, '雨夜街道', 'location', place), [id(40)]: subject(40, '林夏', 'character', hero)},
    versions: {[id(40)]: {known: {[heroOld.id]: heroOld}}},
    bindings: {[shotId]: {phase: 'ready', nextCursor: null, items: [
      binding(1, 10, 'style', look.id, '2026-10-01T00:00:01Z'), binding(2, 20, 'subject', product.id, '2026-10-01T00:00:02Z', true),
      binding(3, 30, 'subject', place.id, '2026-10-01T00:00:03Z'), binding(4, 40, 'subject', heroOld.id, '2026-10-01T00:00:04Z'),
      binding(5, 50, 'subject', null, '2026-10-01T00:00:05Z'),
    ]}},
  };
  return {state, assets, ids: {look: look.assetId, product: product.assetId, place: place.assetId, heroOld: heroOld.assetId}};
}

test('subject prefill orders characters, products, locations, then looks, at each pinned version', () => {
  const {state, assets, ids} = fixture(), plan = subjectReferencePlan(state, shotId, assets, projectId, rules);
  assert.equal(plan.phase, 'ready');
  assert.deepEqual(plan.candidates.map(item => [item.name, item.versionNumber, item.issue]), [['林夏', 1, null], ['保温杯', 3, null], ['雨夜街道', 1, 'format'], ['胶片风格', 1, null]],
    'The unlinked binding is left out; the character keeps its pinned V1 although V2 is the head');
  assert.deepEqual(plan.images, [ids.heroOld, ids.product, ids.look].map(assetId => ({role: 'reference_image', assetId})));
  assert.equal(plan.candidates[1]!.needsReview, true);
  assert.equal(subjectReferenceLabel(plan, ids.heroOld), '林夏 V1'); assert.equal(subjectReferenceLabel(plan, ids.place), '雨夜街道 V1');
  assert.equal(subjectReferenceLabel(plan, id(99)), null);
});

test('subject prefill waits for a complete binding page and never guesses a missing version', () => {
  const {state, assets} = fixture();
  for (const entry of [undefined, {phase: 'loading', nextCursor: null, items: []}, {phase: 'ready', nextCursor: 'more', items: []}]) {
    const plan = subjectReferencePlan({...state, bindings: {[shotId]: entry}}, shotId, assets, projectId, rules);
    assert.deepEqual(plan, {phase: 'loading', candidates: [], images: []});
  }
  assert.equal(subjectReferencePlan(null, shotId, assets, projectId, rules).phase, 'loading');
  const unknown = subjectReferencePlan({...state, versions: {}}, shotId, assets, projectId, rules);
  assert.equal(unknown.candidates[0]!.issue, 'version', 'A pinned version that is not loaded is never replaced by the head');
  assert.equal(unknown.images.some(image => image.assetId === fixture().ids.heroOld), false);
});

test('subject prefill lists unusable images with their reason and converts nothing', () => {
  const {state, ids} = fixture();
  const cases: Array<[Record<string, unknown>, string]> = [[{sizeBytes: 10 * 1024 * 1024 + 1}, 'size'], [{width: 299, height: 600}, 'dimensions'], [{width: 3000, height: 1000}, 'ratio'], [{sha256: 'f'.repeat(64)}, 'changed'], [{projectId: id(9)}, 'asset']];
  for (const [patch, issue] of cases) {
    const assets = [asset(11), asset(21, patch), asset(31, {mimeType: 'image/webp'}), asset(41), asset(42)];
    // A changed size or ratio must also appear in the version record to reach those checks.
    const changedVersion = issue === 'dimensions' || issue === 'ratio' ? {...state, subjects: {...state.subjects, [id(20)]: subject(20, '保温杯', 'product', version(20, 21, 3, patch))}} : state;
    const plan = subjectReferencePlan(changedVersion, shotId, assets, projectId, rules);
    assert.equal(plan.candidates[1]!.issue, issue, issue);
    assert.equal(plan.images.some(image => image.assetId === ids.product), false, issue);
  }
});

test('subject prefill stops at the image count and the encoded request budget, and keeps one entry per image', () => {
  const {state, assets, ids} = fixture();
  const counted = subjectReferencePlan(state, shotId, assets, projectId, {...rules, maxImages: 2});
  assert.deepEqual(counted.candidates.map(item => item.issue), [null, null, 'format', 'count']);
  // Each 1000-byte PNG is 22 + 1336 encoded bytes.
  const budget = subjectReferencePlan(state, shotId, assets, projectId, {...rules, maxEncodedBytes: 2 * 1358});
  assert.deepEqual(budget.candidates.map(item => item.issue), [null, null, 'format', 'budget']);
  assert.deepEqual(budget.images.map(image => image.assetId), [ids.heroOld, ids.product]);
  const shared = {...state, subjects: {...state.subjects, [id(10)]: subject(10, '胶片风格', 'look', {...version(10, 11, 1), assetId: ids.product, sha256: asset(21).sha256})}};
  const once = subjectReferencePlan(shared, shotId, assets, projectId, rules);
  assert.deepEqual(once.images.map(image => image.assetId), [ids.heroOld, ids.product], 'Two subjects sharing one image add it once');
  assert.equal(once.candidates[3]!.issue, null);
});

test('reference rules come from the exact Seedance 2.5 profile and need the saved reference mode', () => {
  const provider = (patch: Partial<contracts.VideoModelEntry> = {}) => {
    const entry = {...contracts.defaultVideoModels('ark')[0]!, ...patch};
    const binding = {version: 1 as const, connectionId: id(62), configurationRevision: 2, providerId: 'ark', region: 'cn-beijing', workspaceId: '', endpoint: contracts.resolveVideoEndpoint('ark', 'cn-beijing'), credentialRef: id(63), model: entry, outputHosts: []};
    const connection = settings.videoConnectionProviders([{connectionId: binding.connectionId, providerId: 'ark', configurationRevision: 2, name: 'Ark account', enabled: true, configured: true, archived: false, models: [{entry, capabilities: contracts.videoBindingCapabilities(binding as Parameters<typeof contracts.videoBindingCapabilities>[0])}]}])[0];
    return settings.generationProviderForModel(connection, entry.modelId, entry.id);
  };
  const exact = provider();
  assert.deepEqual(seedanceReferenceRules(exact, contracts.SEEDANCE25_MODEL_ID, settings.seedanceGenerationCapabilities(exact)), rules);
  const saved = provider({inputModes: ['text', 'image', 'frames', 'subject']});
  assert.equal(seedanceReferenceRules(saved, contracts.SEEDANCE25_MODEL_ID, settings.seedanceGenerationCapabilities(saved)), null);
  assert.equal(seedanceReferenceRules(exact, contracts.SEEDANCE25_MODEL_ID, null), null);
});

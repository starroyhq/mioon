import { translate } from '../packages/i18n/src/index.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { component, nodes, textOf } from './fixtures/export-range-ui-harness.ts';

const id = (n: number) => `da000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const prior = { intentId: id(1), timelineId: id(2), baseRevision: 4, input: { projectId: id(3), requestId: 'old-accepted-request', purpose: 'export', expectedRevision: 4, deliveryName: 'OLD TITLE', exportRange: { startFrame: 0, endFrame: 30 } }, outcome: { status: 'accepted' } };
const retained = { intentId: id(4), timelineId: id(5), baseRevision: 8, input: { projectId: id(3), requestId: 'new-unknown-request', purpose: 'export', expectedRevision: 8, deliveryName: 'NEW TITLE', exportRange: { startFrame: 30, endFrame: 90 } } };

test('uncertain newer preparation displays the coherent request that recovery will resume, not the old accepted intent', () => {
  const View = component('DeliveryDraftRecovery.tsx').default;
  const state = { phase: 'ready', busy: false, intent: prior, retainedPreparation: retained, intentUncertain: true, intentPhase: 'error', pending: true };
  const before = structuredClone(state), tree = View({ state, controller: new Proxy({}, { get: () => () => assert.fail('Passive recovery view invoked a controller') }) });
  const section = nodes(tree).find(node => node.props['data-testid'] === 'delivery-original-intent'), text = textOf(section);
  assert.match(text, /NEW TITLE/); assert.match(text, /new-unknown-request/); assert.match(text, new RegExp(id(5))); assert.ok(text.includes(translate('zh-Hans', 'export.revision', { revision: 8 })));
  assert.doesNotMatch(text, /OLD TITLE|old-accepted-request|修订版 4|已确认接受/);
  assert.match(text, /"startFrame": 30/); assert.match(text, /"endFrame": 90/);
  assert.match(text, /保存结果待确认/); assert.match(text, /确认恢复同一原请求/); assert.deepEqual(state, before);
});

test('pending retention is handled in step 1, not duplicated in the passive recovery panel', () => {
  const Recovery = component('DeliveryDraftRecovery.tsx').default, Controls = component('ExportRangeControls.tsx').default;
  const original = { ...retained, outcome: { status: 'pending' } };
  const recovery = Recovery({ state: { phase: 'ready', busy: false, intent: original, retainedPreparation: null, intentUncertain: false, intentPhase: 'pending', pending: true }, controller: {} });
  const form = Controls({ draft: { mode: 'whole', startText: '', endText: '' }, durationFrames: 999 });
  assert.equal(nodes(recovery).some(node => node.props['data-testid'] === 'delivery-original-intent'), false);
  assert.equal(nodes(recovery).some(node => node.props['data-testid'] === 'delivery-original-range'), false);
  assert.equal(nodes(form).find(node => node.props['data-testid'] === 'export-range-whole')!.props['aria-pressed'], true);
  assert.doesNotMatch(textOf(recovery), /已保存原导出请求，结果待确认|恢复可能会首次提交原导出/);
});

test('terminal intents no longer render a duplicate range or recovery panel', () => {
  const View = component('DeliveryDraftRecovery.tsx').default;
  const legacy = { ...prior, input: { ...prior.input } }; delete (legacy.input as {exportRange?: unknown}).exportRange;
  for (const intent of [legacy, prior]) {
    const tree = View({ state: { phase: 'ready', busy: false, intent, intentPhase: 'accepted' }, controller: {} });
    assert.equal(nodes(tree).some(node => node.props['data-testid'] === 'delivery-original-intent'), false);
    assert.equal(nodes(tree).some(node => node.props['data-testid'] === 'recover-original-delivery'), false);
  }
});

test('not-applied outcome is concluded in step 1 without a duplicate step-2 re-export entry', () => {
  const View = component('DeliveryDraftRecovery.tsx').default;
  const notApplied = { ...prior, outcome: { status: 'not_applied', code: 'REVISION_CONFLICT' } };
  const state = { phase: 'ready', busy: false, intent: notApplied, retainedPreparation: null, intentUncertain: false, intentPhase: 'idle', pending: false };
  const tree = View({ state, controller: {} });
  assert.equal(nodes(tree).some(node => node.props['data-testid'] === 'delivery-original-intent'), false);
  assert.equal(nodes(tree).some(node => node.props['data-testid'] === 'reexport-not-applied-delivery'), false);
  assert.equal(nodes(tree).some(node => node.props['data-testid'] === 'recover-original-delivery'), false);
});

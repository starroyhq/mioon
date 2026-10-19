import { translate } from '../packages/i18n/src/index.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { component, nodes, textOf } from './fixtures/export-range-ui-harness.ts';

const id = n => `da000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
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

test('recovered pending intent shows its frozen selected range while the current session form is whole timeline', () => {
  const Recovery = component('DeliveryDraftRecovery.tsx').default, Controls = component('ExportRangeControls.tsx').default;
  const original = { ...retained, outcome: { status: 'pending' } };
  const recovery = Recovery({ state: { phase: 'ready', busy: false, intent: original, retainedPreparation: null, intentUncertain: false, intentPhase: 'pending', pending: true }, controller: {} });
  const form = Controls({ draft: { mode: 'whole', startText: '', endText: '' }, durationFrames: 999 });
  const frozen = nodes(recovery).find(node => node.props['data-testid'] === 'delivery-original-range');
  assert.match(textOf(frozen), /第 30 帧（含）至第 90 帧（不含）.*60 帧.*2.00 秒/);
  assert.doesNotMatch(textOf(frozen), /999/);
  assert.equal(nodes(form).find(node => node.props['data-testid'] === 'export-range-whole').props['aria-pressed'], true);
  assert.match(textOf(recovery), /已保存原导出请求，结果待确认/); assert.match(textOf(recovery), /不会改用当前范围/);
});

test('legacy original range omission stays whole-original without borrowing current bounds, and terminal range never implies recovery', () => {
  const View = component('DeliveryDraftRecovery.tsx').default;
  const legacy = { ...prior, input: { ...prior.input } }; delete legacy.input.exportRange;
  const tree = View({ state: { phase: 'ready', busy: false, intent: legacy, intentPhase: 'accepted' }, controller: {} });
  assert.equal(textOf(nodes(tree).find(node => node.props['data-testid'] === 'delivery-original-range')), '原请求范围：全部原时间线');
  assert.equal(nodes(tree).some(node => node.props['data-testid'] === 'recover-original-delivery'), false);
  assert.match(textOf(tree), /已确认接受/);
  const terminal = View({ state: { phase: 'ready', busy: false, intent: prior, intentPhase: 'accepted' }, controller: {} });
  assert.match(textOf(nodes(terminal).find(node => node.props['data-testid'] === 'delivery-original-range')), /第 0 帧.*第 30 帧/);
});

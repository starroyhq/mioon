import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as i18n from './helpers/i18n.ts';
import * as stateModule from '../apps/web/src/timeline-clip-loudness-state.ts';
import * as contract from '@mioon/contracts/timeline-clip-loudness';
import { report } from './helpers/timeline-clip-loudness-ui-fixture.ts';
import { fixture } from './helpers/strict-timeline-audio-types.ts';
import type {LoudnessComponent, TestElement} from './helpers/strict-timeline-audio-types.ts';
import type {Locale} from '../packages/i18n/src/index.ts';
import { clipLoudnessMatchMessages } from '../packages/i18n/src/catalogs/clip-loudness-match.ts';
import { validateCatalogs } from '../packages/i18n/src/index.ts';

const flatten = (value: unknown): TestElement[] => Array.isArray(value) ? value.flatMap(flatten) : value && typeof value === 'object' ? [value as TestElement, ...flatten((value as TestElement).props?.children)] : [];
const byTest = (tree: unknown, id: string) => flatten(tree).find(item => item.props?.['data-testid'] === id)!
const text = (tree: unknown) => flatten(tree).flatMap(item => item.props?.children ?? []).filter(item => typeof item === 'string').join(' ');
function component(locale: Locale = 'zh-Hans') {
  const react: {createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => unknown; default?: unknown} = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) }; react.default = react;
  const module = { exports: {} as {default: LoudnessComponent} };
  Function('module', 'exports', 'require', transformSync(readFileSync(new URL('../apps/web/src/TimelineClipLoudness.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code)(module, module.exports,
    (name: string) => name.includes('I18nProvider') ? i18n.i18nTestModule(locale) : name === 'react' ? react : name.includes('/button') ? { Button: 'button' } : name.includes('/input') ? { Input: 'input' } : name.includes('/label') ? { Label: 'label' } : name.startsWith('@mioon/contracts') ? contract : stateModule);
  return module.exports.default;
}
function matching() { const gains: number[] = [], f = fixture({}, { onMatchGain(gain) { gains.push(gain); return true; } }); return { ...f, gains }; }
async function ready(f: ReturnType<typeof matching>, peak = -10, residual = 0, target = -20) {
  f.controller.editTarget(f.state(), 'integratedLufs', String(target)); f.controller.editTarget(f.state(), 'truePeakCeilingDbtp', String(peak));
  const work = f.prepare(), value = report(f.calls.at(-1)!.input);
  value.measurement.integratedLufs = target + residual; value.measurement.relativeGateLufs = target + residual - 10;
  const requiredGainDb = target - value.measurement.integratedLufs, gainMultiplier = 10 ** (requiredGainDb / 20),
    samplePeakLinear = Math.fround(value.measurement.samplePeakLinear * gainMultiplier), truePeakLinear = value.measurement.truePeakLinear * gainMultiplier;
  (value as typeof value & {candidate?: unknown}).candidate = { status: 'measured', reason: null, beforeGain: .75, afterGain: .75 * gainMultiplier, requiredGainDb, gainMultiplier,
    measurement: { ...value.measurement, integratedLufs: target, relativeGateLufs: target - 10, samplePeakLinear, samplePeakDbfs: 20 * Math.log10(samplePeakLinear), truePeakLinear, truePeakDbtp: 20 * Math.log10(truePeakLinear) }, measuredPcmBytes: value.checks.pcmBytes, meetsTarget: true, meetsTruePeak: 20 * Math.log10(truePeakLinear) <= peak - .5, marginDb: .5, applyAllowed: false };
  (value as typeof value & {loudnessRange?: unknown}).loudnessRange = { profile: 'ebu3342-2023-48k-stereo-3s-100ms-complete-v1', sampleRate: 48000, channels: 2, sampleFrames: 48000,
    decodedDurationSeconds: 1, state: 'too_short', samplePeakLinear: .5, loudnessRangeLu: null, lowPercentileLufs: null, highPercentileLufs: null,
    shortTermBlockCount: 0, absoluteGatedBlockCount: 0, relativeGatedBlockCount: 0, relativeGateLufs: null };
  f.reads.at(-1)!.resolve(value); await work; assert.equal(f.state().phase, 'ready');
}

test('actual matching card controls explicit target and blocks accidental form submit without interfering with native IME', () => {
  const C = component(), f = matching(), render = () => C({ loudness: { state: f.state(), controller: f.controller } });
  let tree = render(); const target = byTest(tree, 'clip-loudness-target-integratedLufs');
  assert.equal(target.props.value, '-14'); assert.equal(byTest(tree, 'clip-loudness-target-truePeakCeilingDbtp').props.value, '-1'); assert.equal(f.calls.length, 0);
  let prevented = 0, stopped = 0;
  target.props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: false }, stopPropagation() { stopped++; }, preventDefault() { prevented++; } });
  target.props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, stopPropagation() { stopped++; }, preventDefault() { prevented++; } });
  assert.equal(stopped, 2); assert.equal(prevented, 1);
  target.props.onChange({ target: { value: '' } }); tree = render(); assert.equal(byTest(tree, 'clip-loudness-analyze').props.disabled, true);
  assert.ok(byTest(tree, 'clip-loudness-target-invalid')); assert.equal(f.calls.length, 0);
});

test('actual matching card explains a measured peak conflict and short LRA without inventing zero or enabling Match', async () => {
  const C = component(), f = matching(); await ready(f);
  const tree = C({ loudness: { state: f.state(), controller: f.controller } });
  assert.equal(byTest(tree, 'clip-loudness-lra').props.children[0], '不足 3 秒');
  assert.match(text(tree), /0\.5 dB 余量/); assert.match(text(tree), /候选响度/); assert.equal(byTest(tree, 'clip-loudness-match').props.disabled, true);
  byTest(tree, 'clip-loudness-match').props.onClick(); assert.deepEqual(f.gains, []);
  assert.doesNotMatch(text(tree), /未实现逐段响度统一/); assert.match(text(tree), /保存后才改变时间线/);
});

test('a saved −26 LUFS match shows positive zero and already matched for float32 residue instead of another gain edit', async () => {
  const C = component(), f = matching(); await ready(f, -1, 1e-8, -26);
  assert.notEqual(f.state().report!.candidate!.afterGain, f.state().report!.candidate!.beforeGain);
  const tree = C({ loudness: { state: f.state(), controller: f.controller } }), visible = text(tree);
  assert.match(visible, /当前增益已达到目标/); assert.match(visible, /0\.00 dB/); assert.doesNotMatch(visible, /[-−]0\.00 dB/);
  assert.equal(byTest(tree, 'clip-loudness-match').props.disabled, true);
  byTest(tree, 'clip-loudness-match').props.onClick(); assert.deepEqual(f.gains, []);
});

test('matching labels, units, limitations and invalid-target feedback are localized in all four catalogs', () => {
  assert.deepEqual(validateCatalogs(clipLoudnessMatchMessages), []);
  for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const) {
    const C = component(locale), f = matching(), tree = C({ loudness: { state: f.state(), controller: f.controller } });
    assert.ok(byTest(tree, 'clip-loudness-targets')); assert.match(text(tree), /LUFS/); assert.match(text(tree), /dBTP/);
    assert.match(text(tree), /0\.5 dB/);
    for (const node of flatten(tree)) if (typeof node.props?.children?.[0] === 'string') assert.doesNotMatch(node.props.children[0], /^audio\.loudness\.match\./);
  }
});

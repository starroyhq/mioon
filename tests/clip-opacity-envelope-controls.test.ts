import type {RawOpacityEnvelope, OpacityEnvelopeComposition} from '../apps/web/src/clip-opacity-envelope-state.ts';
import type {Locale} from '../packages/i18n/src/index.ts';
type ObservedComposition = OpacityEnvelopeComposition & {text?: string; target?: 'ducking'};
type ControlProps = Parameters<typeof import('../apps/web/src/ClipOpacityEnvelopeControls.tsx').default>[0];
import type { TestNode, TestTree, TestElementProps, TestComponent, HookCell } from './helpers/strict-timeline-ui-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import * as state from '../apps/web/src/clip-opacity-envelope-state.ts';
import * as contract from '../packages/contracts/src/timeline-opacity-envelope.ts';
import { i18nTestModule } from './helpers/i18n.ts';
import { validateCatalogs, translate, LOCALES } from '../packages/i18n/src/index.ts';
import { opacityEnvelopeMessages } from '../packages/i18n/src/catalogs/opacity-envelope.ts';

const envelope = <Point>(points: Point[]): {profileId: typeof contract.OPACITY_ENVELOPE_PROFILE;points: Point[]} => ({ profileId: contract.OPACITY_ENVELOPE_PROFILE, points });
const raw = (points: readonly (readonly string[])[]) => ({ opacityEnvelope: envelope(points.map(([frame, opacity]) => ({ frame, opacity }))) });
test('opacity form text keeps its lexical limits while incomplete values cannot Save', () => {
  for (const field of ['frame', 'opacity'] as const) {
    const limit = state.RAW_OPACITY_ENVELOPE_LIMITS[field];
    for (const text of ['', '.', '-', '1e', '1e-', '+.eE-', '9'.repeat(limit)] as const) {
      const value = raw([['0', '1']]).opacityEnvelope; value.points[0][field] = text;
      assert.equal(state.acceptsOpacityEnvelopeText(field, text), true);
      assert.equal(state.isRawOpacityEnvelope(value), true);
    }
    for (const text of ['9'.repeat(limit + 1), '１', '1 2', ' 1', '1\n', 'Infinity', 'NaN', '1,2', '1\0', 'n/10'] as const) {
      const value = raw([['0', '1']]).opacityEnvelope; value.points[0][field] = text;
      assert.equal(state.acceptsOpacityEnvelopeText(field, text), false);
      assert.equal(state.isRawOpacityEnvelope(value), false);
    }
  }
  for (const text of ['', '.', '-', '1e', '1e-'] as const) assert.equal(state.validateRawOpacityEnvelope(raw([[text, text]]), 10).valid, false);
  assert.equal(state.isRawOpacityEnvelope(envelope([])), true);
  assert.equal(state.validateRawOpacityEnvelope({ opacityEnvelope: envelope([]) }, 10).valid, false);
});
test('final opacity uses proposed duration, exact clip-local points, absence and explicit clear', () => {
  assert.deepEqual(state.rawOpacityEnvelopeFields({ durationFrames: 10 }), {});
  assert.deepEqual(state.rawOpacityEnvelopeFields({ durationFrames: 10, opacityEnvelope: null }), { opacityEnvelope: null });
  for (const points of [[], [['-0', '1']], [['0', '-0']], [['0', '1.1']], [['0', '1e999']], [['0.5', '1']], [['11', '1']], [['2', '1'], ['1', '1']], [['1', '1'], ['1', '0']], Array.from({ length: 8 }, (_, i) => [String(i), '1'])] as const) assert.equal(state.validateRawOpacityEnvelope(raw(points), 10).valid, false);
  const saved = { durationFrames: 10, opacityEnvelope: envelope([{ frame: 0, opacity: 0 }, { frame: 10, opacity: 1 }]) };
  const draft = state.rawOpacityEnvelopeFields(saved);
  assert.deepEqual(state.opacityEnvelopeChange(draft, saved, 10), { valid: true, fields: {} });
  assert.equal(state.opacityEnvelopeChange(draft, saved, 9).valid, false);
  assert.deepEqual(state.opacityEnvelopeChange({ opacityEnvelope: null }, saved, 9), { valid: true, fields: { opacityEnvelope: null } });
  assert.equal(state.opacityEnvelopeChange({}, saved, 10).valid, false);
  assert.equal(state.validateRawOpacityEnvelope(raw(Array.from({ length: 7 }, (_, i) => [String(i), '1'])), 7).valid, true);
  for (const duration of [0, -0, 18001, 1.5, NaN, Infinity] as const) assert.equal(state.validateRawOpacityEnvelope({}, duration).valid, false);
  assert.equal(state.rawOpacityEnvelopeChanged({}, { opacityEnvelope: null }), true);
  assert.equal(state.rawOpacityEnvelopeChanged(draft, raw([['0', '0.0'], ['10', '1']])), true);
  assert.deepEqual(state.opacityEnvelopeChange(raw([['0', '0.0'], ['10', '1']]), saved, 10), { valid: true, fields: {} });
});
test('stored opacity double values round trip without percentage rounding', () => {
  let seed = 123456789;
  const values = [0, 1, Number.MIN_VALUE, 0.9999999999999999, 0.0000009999999999999997];
  for (let i = 0; i < 1000; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; values.push(seed / 2 ** 32); }
  for (const opacity of values) {
    const saved = { durationFrames: 18000, opacityEnvelope: envelope([{ frame: 18000, opacity }]) };
    const draft = state.rawOpacityEnvelopeFields(saved);
    assert.equal(draft.opacityEnvelope!.points[0].opacity, String(opacity));
    assert.deepEqual(state.validateRawOpacityEnvelope(draft, 18000), { valid: true, fields: { opacityEnvelope: saved.opacityEnvelope } });
  }
});

const nodes = (tree: TestTree): TestNode[] => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
const event = (value: string) => ({ currentTarget: { value } });
const compiled = transformSync(readFileSync(new URL('../apps/web/src/ClipOpacityEnvelopeControls.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code;
function load(react: unknown, locale: Locale) {
  const module = { exports: {} as {default: TestComponent<ControlProps>} };
  Function('require', 'module', 'exports', compiled)((name: string) => name === 'react' ? react : name.includes('I18nProvider') ? i18nTestModule(locale) : name.endsWith('clip-opacity-envelope-state.ts') ? state : name.endsWith('timeline-opacity-envelope.ts') ? contract : assert.fail(name), module, module.exports);
  return module.exports.default;
}
function harness(locale: Locale = 'en', initial: RawOpacityEnvelope | null | undefined = raw([['0', '1']]).opacityEnvelope) {
  const hooks: HookCell[] = []; let cursor = 0, tree: TestTree;
  const edits: {value: RawOpacityEnvelope | null | undefined; session?: symbol}[] = [], events: (string | OpacityEnvelopeComposition)[] = [];
  const react = { createElement: (type: unknown, props: TestElementProps, ...children: TestTree[]) => ({ type, props: { ...props, children } }), useId: () => 'test-opacity', useRef: (initial: unknown) => hooks[cursor++] ??= ({ current: initial }), useState(initial: unknown) { const at = cursor++; hooks[at] ??= { value: initial }; return [hooks[at].value, (value: unknown) => { hooks[at].value = value; }]; } }; (react as typeof react & {default: unknown}).default = react;
  const Control = load(react, locale);
  const props: ControlProps = { value: initial, proposedDuration: 10, onEdit(value, session) { edits.push({ value, session }); props.value = value; events.push('edit'); }, onCompositionChange(value) { events.push(value); } };
  const h = { props, edits, events, render(patch: Partial<ControlProps> = {}) { Object.assign(props, patch); cursor = 0; tree = Control(props); return tree; }, input(field: string = 'frame', row = 0) { return nodes(tree).find(node => node.props?.['data-testid'] === `opacity-envelope-${row}-${field}`); }, buttons() { return nodes(tree).filter(node => node.type === 'button'); }, all() { return nodes(tree); } }; h.render(); return h;
}
test('four locale catalogs and installed React render accessible numeric-text controls', () => {
  assert.deepEqual(validateCatalogs(opacityEnvelopeMessages), []);
  assert.deepEqual(LOCALES, ['zh-Hans', 'zh-Hant', 'en', 'ja']);
  const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
  for (const locale of LOCALES) {
    const Control = load(React, locale);
    const html = renderToStaticMarkup(React.createElement(Control, { value: raw([['0', '0.1234567890123456']]).opacityEnvelope, proposedDuration: 10, onEdit() { assert.fail('Render edited input'); }, onCompositionChange() { assert.fail('Render changed composition'); } }));
    assert.ok(html.includes(translate(locale, 'opacity.envelope.title')));
    assert.ok(html.includes(translate(locale, 'opacity.envelope.bounds', { duration: 10 })));
    assert.match(html, /value="0.1234567890123456"/);
    assert.equal((html.match(/type="text"/g) || []).length, 2);
    assert.equal((html.match(/type="button"/g) || []).length, 3);
    assert.doesNotMatch(html, /maxlength=|<script|<audio|<video|type="number"/);
    const h = harness(locale);
    for (const input of h.all().filter(node => node.type === 'input')) assert.ok(h.all().some(node => node.type === 'label' && node.props.htmlFor === input.props.id));
    h.buttons().at(-1)!.props.onClick(); assert.equal(h.edits.at(-1)!.value, null);
  }
});
test('real React renders incomplete and nonfinite duration recovery in four locales without accepting the invalid draft', () => {
  const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
  for (const locale of LOCALES) for (const proposedDuration of [Number('1e-'), NaN, Infinity, -Infinity, 0, 1.5, 18001] as const) {
    const value = raw([['0', '.5']]).opacityEnvelope;
    const before = structuredClone(value), Control = load(React, locale);
    const html = renderToStaticMarkup(React.createElement(Control, { value, proposedDuration,
      onEdit() { assert.fail('Invalid-duration render edited the draft'); }, onCompositionChange() { assert.fail('Invalid-duration render changed composition'); } }));
    assert.ok(html.includes(translate(locale, 'opacity.envelope.durationInvalid')));
    assert.match(html, /role="alert"/); assert.doesNotMatch(html, /NaN|Infinity/);
    assert.match(html, /value=".5"/); assert.deepEqual(value, before);
    assert.deepEqual(state.validateRawOpacityEnvelope({ opacityEnvelope: value }, proposedDuration), { valid: false, reason: 'duration' });
  }
});
test('bounded structure never normalizes absence and rejects retained stale click handlers', () => {
  const h = harness('en', raw(Array.from({ length: 7 }, (_, i) => [String(i), '1'])).opacityEnvelope);
  assert.equal(h.all().filter(node => node.type === 'input').length, 14);
  assert.equal(h.buttons().at(-2)!.props.disabled, true); h.buttons().at(-2)!.props.onClick(); assert.equal(h.edits.length, 0);
  const absent = harness(); absent.render({ value: undefined }); const stale = absent.buttons().at(-2); absent.render(); stale!.props.onClick(); assert.equal(absent.edits.length, 0);
  absent.buttons().at(-2)!.props.onClick(); assert.deepEqual(absent.edits[0].value!.points, [{ frame: '', opacity: '' }]);
});
test('whole pasted events reject visibly in all languages and retain incomplete draft values', () => {
  for (const locale of LOCALES) for (const [field, text] of [['frame', '１'], ['frame', '9'.repeat(9)], ['opacity', '9'.repeat(33)], ['opacity', '0.5*2']] as const) {
    const h = harness(locale), e = event(text); h.input(field)!.props.onChange(e); h.render();
    assert.equal(h.edits.length, 0); assert.equal(e.currentTarget.value, field === 'frame' ? '0' : '1');
    assert.ok(h.all().some(node => node.props?.role === 'alert' && node.props.children[0] === translate(locale, 'opacity.envelope.rejected', { limit: state.RAW_OPACITY_ENVELOPE_LIMITS[field] })));
  }
  const h = harness(); h.input('opacity')!.props.onChange(event('1e-')); assert.equal(h.edits[0].value!.points[0].opacity, '1e-');
});
test('IME guards structure synchronously and admits one owner-tagged edit before releasing pending', () => {
  const h = harness(), input = h.input('opacity'), buttons = h.buttons(); input!.props.onCompositionStart(event('1'));
  for (const button of buttons) button.props.onClick(); assert.equal(h.edits.length, 0);
  input!.props.onChange(event('一')); h.render(); assert.equal(h.input('opacity')!.props.value, '一'); assert.ok(h.buttons().every(button => button.props.disabled));
  const pending = (h.events.at(-1) as Extract<OpacityEnvelopeComposition,{pending:true}>); assert.equal(pending!.pending, true); assert.equal(pending!.dirty, true); assert.equal(pending!.text, '一');
  h.input('opacity')!.props.onCompositionEnd(event('.5')); h.render(); assert.equal(h.edits[0].value!.points[0].opacity, '.5'); assert.equal(h.edits[0].session, pending!.session);
  assert.deepEqual(h.events.slice(-2), ['edit', { session: pending!.session, pending: false, dirty: false }]);
  h.input('opacity')!.props.onChange(event('.5')); assert.equal(h.edits.length, 1);
});
test('IME rejection rolls back, cancellation retains original, disabled controls cannot edit', () => {
  const h = harness(); h.input()!.props.onCompositionStart(event('0')); h.input()!.props.onChange(event('１２')); h.render();
  const e = event('１２'); h.input()!.props.onCompositionEnd(e); h.render(); assert.equal(e.currentTarget.value, '0'); assert.equal(h.edits.length, 0); assert.equal(h.input()!.props['aria-invalid'], true);
  h.input()!.props.onCompositionStart(event('0')); h.input()!.props.onChange(event('2')); h.render(); h.input()!.props.onCompositionEnd(event('0')); h.render(); assert.equal(h.edits.length, 0);
  h.render({ disabled: true }); h.input()!.props.onChange(event('3')); for (const button of h.buttons()) button.props.onClick(); assert.equal(h.edits.length, 0);
});
test('retained handlers cannot edit or settle a newer same-row IME session', () => {
  const h = harness(); h.input()!.props.onCompositionStart(event('0')); h.render(); const old = h.input();
  old!.props.onCompositionEnd(event('1')); h.render(); h.input()!.props.onCompositionStart(event('1')); h.render();
  const current = h.input(), session = (h.events.at(-1)! as ObservedComposition).session, before = h.edits.length;
  old!.props.onChange(event('99')); old!.props.onCompositionEnd(event('99')); h.render();
  assert.equal(h.edits.length, before); assert.equal((h.events.at(-1)! as ObservedComposition).pending, true); assert.equal((h.events.at(-1)! as ObservedComposition).session, session);
  current!.props.onCompositionEnd(event('2')); h.render(); assert.equal(h.edits.at(-1)!.value!.points[0].frame, '2'); assert.equal((h.events.at(-1)! as ObservedComposition).pending, false);
});
test('IME synchronous start/change/end before React rerender still forwards its session', () => {
  const h = harness(), input = h.input(); input!.props.onCompositionStart(event('0')); input!.props.onChange(event('2')); input!.props.onCompositionEnd(event('2')); h.render();
  assert.equal(h.edits.at(-1)!.value!.points[0].frame, '2'); assert.equal(typeof h.edits.at(-1)!.session, 'symbol'); assert.equal((h.events.at(-1)! as ObservedComposition).pending, false);
});

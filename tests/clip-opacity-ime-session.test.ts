import type { TestNode, TestEvent, ClipDraftEnvelope, ClipDraftState } from './helpers/strict-timeline-ui-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {LOCALES, translate} from '../packages/i18n/src/index.ts';
import {opacityInspectorImeFixture as fixture, deferred, turn} from './helpers/opacity-inspector-ime-fixture.ts';
type StrictFixture = Omit<ReturnType<typeof fixture>, 'input' | 'all' | 'button' | 'cancel' | 'form' | 'row' | 'event'> & { input(field?: string, row?: number): TestNode; all(): TestNode[]; button(id: string): TestNode; cancel(): TestNode; form(): TestNode; row(): ClipDraftEnvelope; event(...args: Parameters<ReturnType<typeof fixture>['event']>): TestEvent };


for (const restored of [false, true] as const) test(`synthetic IME Enter commits text without implicitly saving ${restored ? '43 memory input' : '42 v3 draft'} in all locales`, async t => {
  for (const locale of LOCALES) {
    const h = (fixture as unknown as (...args: Parameters<typeof fixture>) => StrictFixture)(t, {locale, restored});await h.ready();
    h.event('onCompositionStart', '0.25');h.render();h.event('onChange', locale === 'ja' ? 'いち' : '一');h.render();
    const key = h.key('Enter', {isComposing: true, keyCode: 229});
    h.event('onCompositionEnd', '.5');h.render();
    // A native default submission can run after compositionend. Execute that
    // event order against the actual form handler, without claiming OS input.
    if (!key.defaultPrevented) await h.submit();
    assert.equal(h.saves.length, 0, `${locale}: candidate confirmation must not Save`);
    assert.equal(h.state.raw.opacityEnvelope!.points[0].opacity, '.5');assert.equal(h.state.dirty, true);
    h.keyUp();await turn();await h.submit();assert.equal(h.saves.length, 1);assert.equal(h.state.dirty, false);
    assert.equal(h.requests.filter(item => item.method === 'PUT').length, restored ? 0 : 1);
  }
});

test('42 Save cannot enter while Cancel is deleting a persisted draft or waiting on its earlier PUT', async t => {
  for (const waitingPut of [false, true] as const) {
    const putGate = waitingPut ? (deferred as unknown as () => Omit<ReturnType<typeof deferred>, 'resolve'> & {resolve(value?: unknown): void})() : undefined, deleteGate = (deferred as unknown as () => Omit<ReturnType<typeof deferred>, 'resolve'> & {resolve(value?: unknown): void})(), h = (fixture as unknown as (...args: Parameters<typeof fixture>) => StrictFixture)(t, {putGate, deleteGate});await h.ready();
    h.event('onChange', '.5');h.render();const flushing = h.controller.flush();await turn();
    if (!waitingPut) await flushing;
    const cancelling = h.controller.discard(h.controller.capture());await turn();
    const saving = h.submit();if (putGate) putGate.resolve();await flushing;await turn();
    const dispatched = h.saves.length;h.render();assert.equal(h.button('save-clip').props.disabled, true);assert.equal(h.cancel().props.disabled, true);
    deleteGate.resolve();await cancelling;await saving;h.render();
    assert.equal(dispatched, 0, 'Save must not race Cancel or publish a timeline receipt');
    assert.equal(h.state.submitting, false);assert.equal(h.state.businessPending, false);assert.equal(h.controller.getEditorCloseSnapshot().inflight, false);
    assert.equal(h.state.dirty, false);assert.deepEqual(h.requests.map(item => item.method), ['GET', 'PUT', 'DELETE']);
  }
});

for (const restored of [false, true] as const) test(`synthetic Chinese/Japanese update, blur and Escape preserve the input owner until compositionend in ${restored ? '43' : '42'}`, async t => {
  for (const locale of LOCALES) for (const text of ['一', 'いち', '１'] as const) {
    const h = (fixture as unknown as (...args: Parameters<typeof fixture>) => StrictFixture)(t, {locale, restored});await h.ready();
    h.event('onCompositionStart', '0.25');h.render();h.event('onCompositionUpdate', text);h.render();
    assert.equal(h.input().props.value, text, 'compositionupdate text survives a component render without a change event');
    assert.equal(h.controller.hasPendingComposition(), true);assert.equal(h.button('save-clip').props.disabled, true);
    assert.equal(await h.controller.flushForClose(), false);
    h.event('onBlur', text);h.render();assert.equal(h.controller.hasPendingComposition(), true, 'blur cannot invent a missing confirmation');
    const escape = h.key('Escape', {isComposing: true, keyCode: 229});
    assert.equal(escape.defaultPrevented, false, 'the IME retains its native candidate cancellation');assert.equal(escape.propagationStopped, true);
    await h.submit();assert.equal(h.saves.length, 0);
    h.event('onCompositionEnd', '0.25');h.render();
    assert.equal(h.controller.hasPendingComposition(), false);assert.equal(h.state.dirty, false);assert.equal(h.input().props.value, '0.25');
    assert.deepEqual(h.requests.map(item => item.method), restored ? [] : ['GET']);
    h.event('onChange', '.6');h.render();await h.submit();assert.equal(h.saves.length, 1, 'candidate Escape does not leave a later explicit Save blocked');
  }
});

test('synthetic Enter229 after compositionend and stale keyup remain fenced, while a later ordinary Enter keeps explicit form behavior', async t => {
  const h = (fixture as unknown as (...args: Parameters<typeof fixture>) => StrictFixture)(t);await h.ready();h.event('onCompositionStart', '0.25');h.render();h.event('onCompositionEnd', '.4');h.render();
  h.key('Enter', {isComposing: false, keyCode: 229});await h.submit();assert.equal(h.saves.length, 0, 'Safari-style229 remains an IME confirmation');
  h.keyUp();
  h.event('onCompositionStart', '.4');h.render();h.key('Enter', {isComposing: true, keyCode: 229});h.event('onCompositionEnd', '.5');h.render();
  await turn();await h.submit();assert.equal(h.saves.length, 0, 'queued keyup from the old confirmation cannot release the new owner');
  h.keyUp();await turn();h.key('Enter', {isComposing: false, keyCode: 13});await h.submit();assert.equal(h.saves.length, 1);
});

for (const restored of [false, true] as const) test(`synthetic Process229 cannot block a later mouse-focused field Enter Save in ${restored ? '43' : '42'}`, async t => {
  for (const locale of LOCALES) {
    const h = (fixture as unknown as (...args: Parameters<typeof fixture>) => StrictFixture)(t, {locale, restored});await h.ready();h.event('onCompositionStart', '0.25');h.render();
    h.key('Process', {isComposing: true, keyCode: 229});h.event('onCompositionEnd', '.5');h.render();h.keyUp('Process');await turn();
    const target = {getAttribute: () => null, closest: () => null};
    h.form().props.onPointerDownCapture({target});
    h.all().find(node => node.props?.id === 'clip-name')!.props.onChange({target: {value: 'Explicit keyboard Save after mouse focus'}});h.render();
    h.form().props.onKeyDownCapture({key: 'Enter', target, nativeEvent: {keyCode: 13, isComposing: false, repeat: false}, stopPropagation() {}});
    assert.equal(h.controller.hasPendingComposition(), false);assert.equal(h.button('save-clip').props.disabled, false);
    await h.submit();assert.equal(h.saves.length, 1);assert.equal(h.state.dirty, false);
  }
});

for (const restored of [false, true] as const) test(`synthetic held confirmation Enter repeats cannot Save after compositionend in ${restored ? '43' : '42'}`, async t => {
  const h = (fixture as unknown as (...args: Parameters<typeof fixture>) => StrictFixture)(t, {restored});await h.ready();h.event('onCompositionStart', '0.25');h.render();h.key('Enter', {isComposing: true, keyCode: 229});
  h.event('onCompositionEnd', '.5');h.render();
  for (let count = 0; count < 2; count++) {h.key('Enter', {repeat: true});await h.submit();}
  assert.equal(h.saves.length, 0, 'held repeats are still the original confirmation, not a new Save');
  h.keyUp();await turn();h.key('Enter');await h.submit();assert.equal(h.saves.length, 1);
});

test('synthetic final nonnumeric composition is visibly rejected in four locales without normalizing or saving', async t => {
  for (const locale of LOCALES) for (const restored of [false, true] as const) {
    const h = (fixture as unknown as (...args: Parameters<typeof fixture>) => StrictFixture)(t, {locale, restored});await h.ready();
    h.event('onCompositionStart', '0.25');h.render();h.event('onCompositionUpdate', locale === 'ja' ? '１２' : '一');h.render();
    const event = h.event('onCompositionEnd', locale === 'ja' ? '１２' : '一');h.render();
    assert.equal(event.currentTarget.value, '0.25');assert.equal(h.input().props['aria-invalid'], true);
    assert.ok(h.text().includes(translate(locale, 'opacity.envelope.rejected', {limit: 32})));
    assert.equal(h.controller.hasPendingComposition(), false);assert.equal(h.state.dirty, false);
    await h.submit();assert.equal(h.saves.length, 0);
  }
});

test('synthetic stale update/end handlers cannot settle or overwrite a later opacity session', async t => {
  for (const restored of [false, true] as const) {
    const h = (fixture as unknown as (...args: Parameters<typeof fixture>) => StrictFixture)(t, {restored});await h.ready();h.event('onCompositionStart', '0.25');h.render();const old = h.input().props;
    h.event('onCompositionEnd', '.5');h.render();h.event('onCompositionStart', '.5');h.render();h.event('onCompositionUpdate', 'に');h.render();
    for (const name of ['onCompositionUpdate', 'onChange', 'onCompositionEnd'] as const) old[name]?.({currentTarget: {value: '.9'}});
    h.render();assert.equal(h.controller.hasPendingComposition(), true);assert.equal(h.input().props.value, 'に');assert.equal(await h.controller.flushForClose(), false);
    h.event('onCompositionEnd', '.7');h.render();assert.equal(h.state.raw.opacityEnvelope!.points[0].opacity, '.7');assert.equal(h.controller.hasPendingComposition(), false);
  }
});

test('42 delayed GET, PUT and DELETE acknowledgments do not release a newer composition or replace its raw draft', async t => {
  for (const method of ['GET', 'PUT', 'DELETE'] as const) {
    const gate = (deferred as unknown as () => Omit<ReturnType<typeof deferred>, 'resolve'> & {resolve(value?: unknown): void})(), h = (fixture as unknown as (...args: Parameters<typeof fixture>) => StrictFixture)(t, {[method === 'GET' ? 'getGate' : method === 'PUT' ? 'putGate' : 'deleteGate']: gate});
    let flight;
    if (method === 'GET') {flight = h.controller.load();await turn();}
    else {
      await h.ready();h.event('onChange', '.5');h.render();const flush = h.controller.flush();await turn();
      if (method === 'PUT') flight = flush;
      else {await flush;flight = h.controller.discard(h.controller.capture());await turn();}
    }
    // Retained callbacks can run before React has rendered a newly busy form.
    // They still belong to this original input; late responses cannot release it.
    h.event('onCompositionStart', '.5');h.render();h.event('onCompositionUpdate', '七');h.render();
    assert.equal(h.controller.hasPendingComposition(), true);gate.resolve();await flight;h.render();
    assert.equal(h.controller.hasPendingComposition(), true);assert.equal(h.input().props.value, '七');assert.equal(await h.controller.flushForClose(), false);
    h.event('onCompositionEnd', '.7');h.render();assert.equal(h.state.raw.opacityEnvelope!.points[0].opacity, '.7');assert.equal(h.state.dirty, true);
    await h.controller.flush();assert.equal(h.row().draft!.raw.opacityEnvelope!.points[0].opacity, '.7');assert.equal(h.saves.length, 0);
  }
});

for (const restored of [false, true] as const) test(`repeated Save/Cancel and a late business ACK retain newer Chinese/Japanese input in ${restored ? '43' : '42'}`, async t => {
  for (const locale of LOCALES) {
    const saveGate = (deferred as unknown as () => Omit<ReturnType<typeof deferred>, 'resolve'> & {resolve(value?: unknown): void})(), h = (fixture as unknown as (...args: Parameters<typeof fixture>) => StrictFixture)(t, {locale, restored, saveGate});await h.ready();h.event('onChange', '.5');h.render();
    const saving = h.submit();await turn();h.render();assert.equal(h.saves.length, 1);assert.equal(h.cancel().props.disabled, true);
    await h.submit();await h.controller.discard(h.controller.capture());assert.equal(h.saves.length, 1);
    const newer = locale === 'ja' ? '新しい入力' : '新的输入';assert.equal(h.controller.edit('name', newer), true);h.render();
    saveGate.resolve();await saving;h.render();assert.equal(h.state.raw.name, newer);assert.equal(h.state.dirty, true);assert.equal(h.state.conflict, true);
    assert.equal(h.state.submitting, false);assert.equal(h.state.businessPending, false);assert.equal(h.requests.some(item => item.method === 'DELETE'), false);
    assert.deepEqual(h.requests.map(item => item.method), restored ? [] : ['GET', 'PUT']);
  }
});

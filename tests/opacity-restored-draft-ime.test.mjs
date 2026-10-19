import test from 'node:test';
import assert from 'node:assert/strict';
import {LOCALES} from '../packages/i18n/src/index.ts';
import {opacityInspectorImeFixture as fixture, deferred, turn} from './helpers/opacity-inspector-ime-fixture.mjs';

for (const locale of LOCALES) test(`synthetic ${locale} composition uses the exact43 new-origin client without persisting partial composition or implicit Save`, async t => {
  const h = fixture(t, {locale, restored: true, restoredPersistence: true});await h.ready();
  assert.equal(h.controller.supportsRestoredPersistence(h.props.draftContext.workspaceOrigin), true);
  h.event('onCompositionStart', '0.25');h.render();h.event('onCompositionUpdate', locale === 'ja' ? 'に' : '一');h.render();
  h.event('onBlur', locale === 'ja' ? 'に' : '一');h.render();await h.controller.flush();
  assert.equal(await h.controller.flushForClose(), false);assert.deepEqual(h.requests.map(r => r.method), ['GET']);
  const escape = h.key('Escape', {isComposing: true, keyCode: 229});assert.equal(escape.defaultPrevented, false);
  h.key('Enter', {isComposing: true, keyCode: 229});h.event('onCompositionEnd', '.5');h.render();await h.submit();
  assert.equal(h.saves.length, 0);assert.equal(h.state.raw.opacityEnvelope.points[0].opacity, '.5');
  h.keyUp();await turn();await h.controller.flush();assert.equal(h.row().draft.raw.opacityEnvelope.points[0].opacity, '.5');
  assert.equal(await h.controller.flushForClose(), true);assert.equal(h.state.dirty, true, 'local ACK cannot mark the timeline saved');
  h.key('Enter');await h.submit();assert.equal(h.saves.length, 1);assert.equal(h.state.dirty, false);
  assert.deepEqual(h.requests.map(r => r.method), ['GET', 'PUT', 'DELETE']);
});

test('synthetic43 late GET/PUT/DELETE responses retain a later Chinese/Japanese composition and fresh raw owner', async t => {
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const gate = deferred(), h = fixture(t, {restored: true, restoredPersistence: true, [method === 'GET' ? 'getGate' : method === 'PUT' ? 'putGate' : 'deleteGate']: gate});
    let flight;
    if (method === 'GET') {flight = h.controller.load();await turn();}
    else {await h.ready();h.event('onChange', '.5');h.render();const writing = h.controller.flush();await turn();
      if (method === 'PUT') flight = writing;else {await writing;flight = h.controller.discard(h.controller.capture());await turn();}}
    h.event('onCompositionStart', '.5');h.render();h.event('onCompositionUpdate', '新しい');h.render();gate.resolve();await flight;h.render();
    assert.equal(h.controller.hasPendingComposition(), true);assert.equal(h.input().props.value, '新しい');assert.equal(await h.controller.flushForClose(), false);
    h.event('onCompositionEnd', '.7');h.render();await h.controller.flush();
    assert.equal(h.state.raw.opacityEnvelope.points[0].opacity, '.7');assert.equal(h.row().draft.raw.opacityEnvelope.points[0].opacity, '.7');assert.equal(h.saves.length, 0);
  }
});

test('synthetic43 repeated Save cannot race an active Cancel waiting for PUT/DELETE', async t => {
  const putGate = deferred(), deleteGate = deferred(), h = fixture(t, {restored: true, restoredPersistence: true, putGate, deleteGate});await h.ready();
  h.event('onChange', '.5');h.render();const writing = h.controller.flush();await turn();const cancelling = h.controller.discard(h.controller.capture());await turn();
  await h.submit();await h.submit();putGate.resolve();await writing;await turn();h.render();
  assert.equal(h.button('save-clip').props.disabled, true);assert.equal(h.cancel().props.disabled, true);assert.equal(h.saves.length, 0);
  deleteGate.resolve();await cancelling;assert.equal(h.state.dirty, false);assert.equal(h.row().draft, null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {opacityInspectorImeFixture as fixture} from './helpers/opacity-inspector-ime-fixture.mjs';

const source = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  const guardRetainedInputInteraction = event => {');
const end = source.indexOf('  if (auth === false', start);
assert.ok(start >= 0 && end > start, 'Extract the actual App ancestor capture guard');
assert.equal(source.indexOf('  const guardRetainedInputInteraction = event => {', start + 1), -1);
const guardSource = source.slice(start, end);
function ancestorGuard({blocked = true, retained = true} = {}) {
  return Function('clipConnectionBlocked', 'retainWorkbenchForClip', `${guardSource};return guardRetainedInputInteraction;`)({current: blocked}, retained);
}
// A tiny attribute-only ancestor lookup for synthetic event routing. The
// Inspector/controls and capture functions are real; no native DOM/IME is used.
function target(ancestors, testId) {
  return {
    getAttribute: name => name === 'data-testid' ? testId : null,
    closest(selector) {
      return ancestors.find(attributes => selector.split(',').some(part => {
        const match = /^\s*\[([^=\]]+)(?:="([^"]*)")?\]\s*$/u.exec(part);
        return match && Object.hasOwn(attributes, match[1]) && (match[2] === undefined || attributes[match[1]] === match[2]);
      })) ?? null;
    },
  };
}
function event(type, element, key) {
  return {type, key, target: element, keyCode: 229, isComposing: true, nativeEvent: {keyCode: 229, isComposing: true},
    defaultPrevented: false, propagationStopped: false,
    preventDefault() {this.defaultPrevented = true;}, stopPropagation() {this.propagationStopped = true;}};
}

test('actual App installs the same retained-input guard before descendant key, click and submit handlers', () => {
  assert.match(source, /data-testid="workbench" onClickCapture=\{guardRetainedInputInteraction\} onKeyDownCapture=\{guardRetainedInputInteraction\} onSubmitCapture=\{guardRetainedInputInteraction\}/u);
});

for (const mode of [{name: '42', restored: false}, {name: '43 memory fallback', restored: true}, {name: '43 persisted', restored: true, restoredPersistence: true}]) {
  for (const key of ['Enter', 'Escape']) test(`actual App ancestor preserves native ${key} during retained disconnected opacity composition in ${mode.name}`, async t => {
    const h = fixture(t, mode);await h.ready();
    h.event('onCompositionStart', '0.25');h.render();h.event('onCompositionUpdate', '一');h.render();
    h.render({draftConnected: false});
    const section = h.all().find(node => node.props?.['data-testid'] === 'clip-opacity-envelope');assert.ok(section);
    const element = target([h.input().props, section.props], h.input().props['data-testid']);
    const observation = event('keydown', element, key);
    ancestorGuard()(observation);
    assert.equal(observation.defaultPrevented, false, 'The App ancestor must preserve native IME confirmation/cancellation');
    assert.equal(observation.propagationStopped, false, 'The Inspector must receive its retained composing key');
    h.form().props.onKeyDownCapture(observation);
    assert.equal(observation.defaultPrevented, false);assert.equal(observation.propagationStopped, true, 'The Inspector still fences workbench shortcuts');
    assert.equal(await h.controller.flushForClose(), false);
    const before = h.requests.length;
    h.event('onCompositionEnd', key === 'Enter' ? '.5' : '0.25');h.render();
    await h.submit();await h.controller.flush();
    assert.equal(h.controller.hasPendingComposition(), false);assert.equal(h.saves.length, 0, 'Disconnected settlement cannot submit a business mutation');
    assert.equal(h.requests.length, before, 'Settling composition cannot persist while disconnected');
    assert.equal(h.state.raw.opacityEnvelope.points[0].opacity, key === 'Enter' ? '.5' : '0.25');
    assert.equal(h.state.dirty, key === 'Enter');
  });
}

test('actual App retained gate continues allowing volume input and explicit abandonment while blocking unrelated actions', () => {
  const guard = ancestorGuard();
  for (const type of ['keydown', 'click', 'submit']) {
    for (const attributes of [{'data-testid': 'clip-volume-envelope'}, {'data-retained-input-action': 'abandon'}]) {
      const observation = event(type, target([attributes]), 'Escape');guard(observation);
      assert.equal(observation.defaultPrevented, false);assert.equal(observation.propagationStopped, false);
    }
    for (const element of [target([{'data-testid': 'save-clip'}]), target([{'data-testid': 'timeline-render-preview'}]), {}, null]) {
      const observation = event(type, element, 'Enter');guard(observation);
      assert.equal(observation.defaultPrevented, true);assert.equal(observation.propagationStopped, true);
    }
  }
});

test('actual App guard does not intercept ordinary interaction without a blocked retained owner', () => {
  for (const state of [{blocked: false, retained: true}, {blocked: true, retained: false}, {blocked: false, retained: false}]) {
    const observation = event('keydown', target([{'data-testid': 'save-clip'}]), 'Enter');ancestorGuard(state)(observation);
    assert.equal(observation.defaultPrevented, false);assert.equal(observation.propagationStopped, false);
  }
});

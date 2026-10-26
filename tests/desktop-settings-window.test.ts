import test from 'node:test';
import assert from 'node:assert/strict';
import {settingsWindowOptions} from '../apps/desktop/src/settings-window.ts';
import {isProjectWindowContext, isProjectWindowRequest} from '../apps/desktop/src/project-window-protocol.ts';

test('settings are a smaller native modal centered inside the actual parent content area', () => {
  for (const bounds of [{x: 120, y: 100, width: 1500, height: 960}, {x: -1500, y: 40, width: 1050, height: 640}]) {
    const parent = {isDestroyed: () => false, getContentBounds: () => bounds};
    const options = settingsWindowOptions(parent);
    assert.equal(options.parent, parent); assert.equal(options.modal, true); assert.equal(options.show, false);
    assert.ok(options.width < bounds.width && options.height < bounds.height);
    assert.ok(options.width <= 1000 && options.height <= 720);
    assert.equal(options.x, bounds.x + (bounds.width - options.width) / 2);
    assert.equal(options.y, bounds.y + (bounds.height - options.height) / 2);
    assert.equal(options.resizable, false); assert.equal(options.minimizable, false);
    assert.equal(options.maximizable, false); assert.equal(options.fullscreenable, false);
    assert.ok(options.minWidth <= options.width && options.minHeight <= options.height);
  }
});

test('settings cannot become an orphan or use invalid native geometry', () => {
  assert.throws(() => settingsWindowOptions(undefined));
  assert.throws(() => settingsWindowOptions({isDestroyed: () => true, getContentBounds: () => assert.fail('Destroyed parent has no bounds')}));
  for (const width of [0, -1, NaN, Infinity]) {
    assert.throws(() => settingsWindowOptions({isDestroyed: () => false, getContentBounds: () => ({x: 0, y: 0, width, height: 600})}));
  }
});

test('modal presentation state is host-owned, strict and compatible with old v2 contexts', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const legacy = {version: 2, role: 'launcher', windowId: id, contextId: id, backendId: id, initialProjectId: null, autoOpen: false,
    editorProjectId: null, editorPhase: 'none', editorCount: 0, entryMode: null, entryVersion: 0, entryReceipt: null,
    settingsSlot: null, settingsVersion: 0, selectionProjectId: null, selectionVersion: 0, locatorStatus: null, locatorIntent: null, quitting: false};
  assert.equal(isProjectWindowContext(legacy), true);
  for (const settingsModalOpen of [true, false]) assert.equal(isProjectWindowContext({...legacy, settingsModalOpen}), true);
  for (const settingsModalOpen of [null, undefined, 1, 'true', {}]) assert.equal(isProjectWindowContext({...legacy, settingsModalOpen}), false);
  assert.equal(isProjectWindowContext({...legacy, role: 'settings', settingsModalOpen: true}), false);
  assert.equal(isProjectWindowContext({...legacy, settingsModalOpen: false, parentId: id}), false);
  assert.equal(isProjectWindowRequest({action: 'settings', contextId: id, slot: 'agent', settingsModalOpen: true}), false);
});

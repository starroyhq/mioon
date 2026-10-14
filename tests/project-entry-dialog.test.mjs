import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync, transformSync } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const renderer = join(root, 'apps/web/src');
const require = createRequire(import.meta.url);
const entrySource = readFileSync(process.env.MIOON_PROJECT_ENTRY_SOURCE || join(renderer, 'ProjectEntry.tsx'), 'utf8');
const css = readFileSync(join(renderer, 'styles.css'), 'utf8');
const output = buildSync({ stdin: { contents: entrySource + '\nexport { React, Dialog, DialogContent, ProjectHome };', loader: 'tsx', resolveDir: renderer },
  bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'transform', loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"' } });
const module = { exports: {} };
Function('require', 'module', 'exports', output.outputFiles[0].text)(require, module, module.exports);
const { default: ProjectEntry, React, Dialog, DialogContent, ProjectHome } = module.exports;
const elements = value => Array.isArray(value) ? value.flatMap(elements) : value && typeof value === 'object' ? [value, ...elements(value.props?.children)] : [];
function zIndex(selector) {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(match => match[1].trim() === selector);
  assert.equal(rules.length, 1, `One existing application stacking rule: ${selector}`);
  const value = rules[0][2].match(/(?:^|;)z-index:(\d+)(?:;|$)/);
  assert.ok(value, `${selector} has an explicit z-index`); return Number(value[1]);
}
function fixture(patch = {}) {
  const state = { shown: true, mode: 'open', projects: [], workspace: { restored: false }, phase: 'home',
    creating: false, sealed: false, createUnknown: false, openUnknown: false, listBusy: false, listError: '',
    error: '', notice: '', formIntent: 0, ...patch };
  const calls = [];
  const controller = { getState: () => state, getContext: () => ({ quitting: false }),
    dismiss: async () => { calls.push('dismiss'); return false; }, create: async () => { calls.push('create'); return false; },
    canMutate: () => state.shown, reportCreate() {}, open() { calls.push('open'); },
    refresh() { calls.push('refresh'); }, interacted() { calls.push('interacted'); }, reconcileOpen() { calls.push('reconcile'); } };
  return { state, calls, controller, render: (editor = true) => ProjectEntry({ controller, editor, onSettings() { calls.push('settings'); } }) };
}
function dialogParts(tree) {
  assert.equal(tree.type, Dialog);
  const content = tree.props.children; assert.equal(content.type, DialogContent);
  const portal = content.type(content.props), [overlay, popup] = portal.props.children;
  return { content, portal, overlay: overlay.type(overlay.props), popup };
}

test('real ProjectEntry shared Dialog output opts into the existing modal stack above its global backdrop', () => {
  const f = fixture(), { popup, overlay } = dialogParts(f.render());
  assert.equal(popup.props['data-slot'], 'dialog-content'); assert.equal(overlay.props['data-slot'], 'dialog-overlay');
  assert.ok(popup.props.className.split(/\s+/).includes('project-entry-dialog'));
  assert.ok(popup.props.className.split(/\s+/).includes('modal'), 'The real popup must use the existing modal stacking rule, not only shadcn z-50');
  const backdrop = zIndex('[data-slot="dialog-overlay"]'), picker = zIndex('.modal[data-slot="dialog-content"]');
  assert.equal(backdrop, 80); assert.equal(picker, 90); assert.ok(picker > backdrop);
  assert.equal(popup.props.style.width, 'min(980px, 94vw)'); assert.equal(popup.props.style.maxHeight, '90vh');
  assert.equal(Object.hasOwn(popup.props.style, 'zIndex'), false, 'Use the established CSS class, not a competing inline/global restyle');
  assert.deepEqual(f.calls, []);
});

test('real hidden picker remains a controlled inert keepMounted dialog with the same form callbacks', () => {
  const f = fixture(), openTree = f.render(), open = dialogParts(openTree);
  f.state.shown = false; const closedTree = f.render(), closed = dialogParts(closedTree);
  assert.equal(openTree.props.open, true); assert.equal(closedTree.props.open, false);
  assert.equal(openTree.type, closedTree.type); assert.equal(open.content.type, closed.content.type);
  assert.equal(closed.portal.props.keepMounted, true); assert.equal(closed.content.props.showCloseButton, false);
  assert.equal(closed.popup.props.hidden, true); assert.equal(closed.popup.props.inert, true); assert.equal(closed.popup.props.style.display, 'none');
  const form = elements(closed.popup).find(element => element.type === ProjectHome); assert.ok(form);
  assert.equal(form.props.onCreate, f.controller.create); assert.equal(form.props.onCreateStateChange, f.controller.reportCreate);
  assert.equal(form.props.canMutateEntry, f.controller.canMutate); assert.deepEqual(f.calls, []);
  assert.notEqual(f.render(false).type, Dialog, 'The launcher remains a page, not a new modal');
});

test('real picker Escape or outside-dismiss callback cancels primitive dismissal before asking its retained owner', () => {
  const f = fixture(), tree = f.render();
  tree.props.onOpenChange(false, { cancel() { f.calls.push('cancel'); } });
  assert.deepEqual(f.calls, ['cancel', 'dismiss']); assert.equal(f.state.shown, true);
  tree.props.onOpenChange(true, { cancel() { assert.fail('An open notification is not a dismissal'); } });
  assert.deepEqual(f.calls, ['cancel', 'dismiss']);
});

function confirmationHarness() {
  const source = readFileSync(join(root, 'packages/ui/src/components/workbench-confirm.tsx'), 'utf8');
  const slots = []; let cursor = 0;
  const react = { ...React,
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { slots[index] = value; }]; },
    useRef(initial) { return slots[cursor++] ||= { current: initial }; },
    useCallback(callback) { cursor++; return callback; }, useEffect() { cursor++; },
  };
  const module = { exports: {} };
  Function('require', 'module', 'exports', transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code)(name => {
    if (name === 'react') return react;
    if (name === '@mioon/ui/components/dialog') return { Dialog, DialogContent, DialogTitle: 'h2', DialogDescription: 'p' };
    if (name === '@mioon/ui/components/button') return { Button: 'button' };
    assert.fail(`Unexpected confirmation dependency ${name}`);
  }, module, module.exports);
  return () => { cursor = 0; return module.exports.ConfirmationProvider({ children: null }); };
}
test('existing nested confirmation output layers above both picker and raised backdrop and cancellation never approves departure', async () => {
  const render = confirmationHarness(), pending = render().props.value('Retain this input?');
  const confirmation = render().props.children[1]; assert.equal(confirmation.type, Dialog); assert.equal(confirmation.props.open, true);
  const { content, popup } = dialogParts(confirmation);
  assert.ok(popup.props.className.split(/\s+/).includes('workbench-confirm'));
  assert.equal(content.props.showCloseButton, false); assert.ok(content.props.initialFocus);
  const picker = zIndex('.modal[data-slot="dialog-content"]');
  const backdrop = zIndex('body:has(.workbench-confirm) [data-slot="dialog-overlay"]');
  const confirmationZ = zIndex('.workbench-confirm[data-slot="dialog-content"]');
  assert.equal(backdrop, 110); assert.equal(confirmationZ, 120); assert.ok(picker < backdrop && backdrop < confirmationZ);
  confirmation.props.onOpenChange(false); assert.equal(await pending, false);
  assert.equal(render().props.children[1].props.open, false);
});

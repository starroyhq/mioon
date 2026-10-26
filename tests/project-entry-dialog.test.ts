interface DialogNode{type:unknown;props:DialogProps}
interface DialogProps extends Record<string,unknown>{children:unknown;className:string;style:{display:string};onOpenChange(open:boolean,details?:{cancel():void}):void}
type DialogComponent=(props:unknown)=>DialogNode;
interface EntryModule{default:DialogComponent;Dialog:unknown;DialogContent:DialogComponent;ProjectHome:unknown;React:typeof import('react')&{__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE:{H:unknown}}}
interface ConfirmationTree{props:{value(message:string):Promise<boolean>;children:[unknown,DialogNode]}}
import type {HookSlot} from './helpers/strict-timeline-audio-harness-types.ts';
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
const homeCss = readFileSync(join(renderer, 'project-home-redesign.css'), 'utf8');
const output = buildSync({ stdin: { contents: entrySource.replace("import { useI18n } from './i18n/I18nProvider.tsx';", "import { createI18nTestContext } from '../../../tests/helpers/i18n.ts'; const useI18n = () => createI18nTestContext();") + '\nexport { React, Dialog, DialogContent, ProjectHome };', loader: 'tsx', resolveDir: renderer },
  bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'transform', loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"' } });
const module = { exports: {} as EntryModule };
Function('require', 'module', 'exports', output.outputFiles[0].text)(require, module, module.exports);
const { default: ProjectEntry, React, Dialog, DialogContent, ProjectHome } = module.exports;
const elements = (value: unknown): DialogNode[] => Array.isArray(value) ? value.flatMap(elements) : value && typeof value === 'object' ? [value as DialogNode, ...elements((value as DialogNode).props?.children)] : [];
function zIndex(selector: string) {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(match => match[1].trim() === selector);
  assert.equal(rules.length, 1, `One existing application stacking rule: ${selector}`);
  const value = rules[0][2].match(/(?:^|;)z-index:(\d+)(?:;|$)/);
  assert.ok(value, `${selector} has an explicit z-index`); return Number(value[1]);
}
function fixture(patch = {}) {
  const state = { shown: true, mode: 'open', projects: [], workspace: { restored: false }, phase: 'home',
    creating: false, sealed: false, createUnknown: false, openUnknown: false, listBusy: false, listError: '',
    error: '', notice: '', formIntent: 0, ...patch };
  const calls: string[] = [];
  const controller = { getState: () => state, getContext: () => ({ quitting: false }),
    dismiss: async () => { calls.push('dismiss'); return false; }, create: async () => { calls.push('create'); return false; },
    canMutate: () => state.shown, reportCreate() {}, open() { calls.push('open'); },
    refresh() { calls.push('refresh'); }, interacted() { calls.push('interacted'); }, reconcileOpen() { calls.push('reconcile'); } };
  return { state, calls, controller, render: (editor = true, presentation = {}) => ProjectEntry({ controller, editor, ...presentation, onSettings() { calls.push('settings'); } }) };
}
function dialogParts(tree: DialogNode) {
  assert.equal(tree.type, Dialog);
  const content = tree.props.children as DialogNode & {type: DialogComponent}; assert.equal(content.type, DialogContent);
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const previous = internals.H;
  internals.H = { useContext: (context: { _currentValue: unknown; }) => context._currentValue };
  let portal; try { portal = content.type(content.props); } finally { internals.H = previous; }
  const [overlay, popup] = portal!.props.children as [DialogNode & {type: DialogComponent}, DialogNode];
  return { content, portal, overlay: overlay.type(overlay.props), popup };
}

test('real ProjectEntry shared Dialog output opts into the existing modal stack above its global backdrop', () => {
  const f = fixture(), { popup, overlay } = dialogParts(f.render());
  assert.equal(popup.props['data-slot'], 'dialog-content'); assert.equal(overlay.props['data-slot'], 'dialog-overlay');
  assert.ok(popup.props.className.split(/\s+/).includes('project-entry-dialog'));
  assert.ok(popup.props.className.split(/\s+/).includes('modal'), 'The real popup must use the existing modal stacking rule, not only shadcn z-50');
  const backdrop = zIndex('[data-slot="dialog-overlay"]'), picker = zIndex('.modal[data-slot="dialog-content"]');
  assert.equal(backdrop, 80); assert.equal(picker, 90); assert.ok(picker > backdrop);
  assert.equal(popup.props['data-testid'], 'project-entry-dialog');
  assert.equal(popup.props.style, undefined, 'Geometry belongs to the zoom-aware scoped stylesheet');
  assert.match(homeCss, /\.project-entry-dialog\.modal\[data-slot="dialog-content"\] \{[^}]*display: flex;[^}]*height: min\(640px, calc\(var\(--mioon-viewport-height\) - 40px\)\)/);
  assert.deepEqual((f.calls as unknown), []);
});

test('real hidden picker remains a controlled inert keepMounted dialog with the same form callbacks', () => {
  const f = fixture(), openTree = f.render(), open = dialogParts(openTree);
  f.state.shown = false; const closedTree = f.render(), closed = dialogParts(closedTree);
  assert.equal(openTree.props.open, true); assert.equal(closedTree.props.open, false);
  assert.equal(openTree.type, closedTree.type); assert.equal(open.content.type, closed.content.type);
  assert.equal(closed.portal.props.keepMounted, true); assert.equal(closed.content.props.showCloseButton, false);
  assert.equal(closed.popup.props.hidden, true); assert.equal(closed.popup.props.inert, true); assert.equal(closed.popup.props.style.display, 'none');
  const form = elements(closed.popup).find((element: { type: unknown; }) => element.type === ProjectHome); assert.ok(form);
  assert.equal(form.props.onCreate, f.controller.create); assert.equal(form.props.onCreateStateChange, f.controller.reportCreate);
  assert.equal(form.props.presentation, 'embedded');
  assert.equal(form.props.canMutateEntry, f.controller.canMutate); assert.deepEqual((f.calls as unknown), []);
  assert.notEqual(f.render(false).type, Dialog, 'The launcher remains a page, not a new modal');
  assert.equal(elements(f.render(false)).find((element: { type: unknown; }) => element.type === ProjectHome)!.props.presentation, 'page');
});

test('the retained embedded catalog has one full-width scrolling column and bounded error text', () => {
  assert.match(homeCss, /\.project-home-screen > \.project-home > \.project-home-layout \{[^}]*display: block/);
  assert.match(homeCss, /\.project-entry-dialog > \.project-home-embedded \{[^}]*flex: 1; min-height: 0; overflow: hidden/);
  assert.match(homeCss, /\.project-home-embedded > \.project-home \{ height: 100%; min-height: 0;/);
  assert.match(homeCss, /\.project-home-embedded > \.project-home \.project-home-feedback > strong \{ flex: 1 1 320px; min-width: 0;/);
  assert.doesNotMatch(readFileSync(join(renderer, 'viewport-scale.css'), 'utf8'), /\.workbench, \.project-home,/);
});

test('entry keeps recovery status visible and passes quiet workspace details to the home help dialog', () => {
  const f = fixture(), status = React.createElement('span', null, 'Recovery required'), help = React.createElement('span', null, 'Workspace details');
  for (const editor of [false, true]) {
    const home = elements(f.render(editor, { status, help })).find((element: { type: unknown; }) => element.type === ProjectHome);
    assert.equal(home!.props.status, status); assert.equal(home!.props.help, help);
    const quiet = elements(f.render(editor, { help })).find((element: { type: unknown; }) => element.type === ProjectHome);
    assert.equal(quiet!.props.status, undefined); assert.equal(quiet!.props.help, help);
  }
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
  const slots: unknown[] = []; let cursor = 0;
  const react = { ...React,
    useState(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (value: unknown) => { slots[index] = value; }]; },
    useRef(initial: unknown) { return slots[cursor++] ||= { current: initial }; },
    useCallback(callback: unknown) { cursor++; return callback; }, useEffect() { cursor++; },
  };
  const module = { exports: {} as {ConfirmationProvider: (props: {children:null})=>ConfirmationTree} };
  Function('require', 'module', 'exports', transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code)((name: string) => {
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
  const backdrop = zIndex('body:has(.workbench-confirm[data-open]) [data-slot="dialog-overlay"]');
  const confirmationZ = zIndex('.workbench-confirm[data-slot="dialog-content"]');
  assert.equal(backdrop, 110); assert.equal(confirmationZ, 120); assert.ok(picker < backdrop && backdrop < confirmationZ);
  confirmation.props.onOpenChange(false); assert.equal(await pending, false);
  assert.equal(render().props.children[1].props.open, false);
});

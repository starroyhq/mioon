import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

// Exercise the app adapters' real callback/effect code. Actual portal rendering
// and focus movement are verified separately in browser acceptance.
const source = readFileSync(new URL('../apps/web/src/WorkspaceControls.tsx', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'tsx', format: 'cjs' }).code;
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const element = (type, props = {}, ...children) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children } });
const equalDeps = (left, right) => left?.length === right?.length && left.every((value, index) => Object.is(value, right[index]));
function harness(name) {
  const slots = [], refs = new Map(), document = { body: {}, activeElement: null };
  document.activeElement = document.body;
  let cursor = 0, effects = [], tree;
  const h = { visible: true, document };
  const react = {
    createElement: element,
    Children: { toArray: children => children == null ? [] : (Array.isArray(children) ? children.flat(Infinity) : [children]) },
    isValidElement: child => Boolean(child && typeof child === 'object' && child.props),
    useState(initial) { const index = cursor++; slots[index] ||= { value: initial }; return [slots[index].value, next => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useMemo(factory, deps) { const index = cursor++; if (!slots[index] || !equalDeps(deps, slots[index].deps)) slots[index] = { value: factory(), deps }; return slots[index].value; },
    useLayoutEffect(callback, deps) { const index = cursor++, old = slots[index]; if (old && equalDeps(deps, old.deps)) return; slots[index] = { callback, deps, cleanup: old?.cleanup }; effects.push(index); },
  };
  react.default = react;
  const primitive = new Proxy({}, { get: (_, key) => String(key) });
  const module = { exports: {} };
  Function('module', 'exports', 'require', code)(module, module.exports, id => {
    if (id === 'react') return react;
    if (id === './workspace-visibility.tsx') return { useWorkspaceVisibility: () => h.visible };
    if (id.startsWith('@mioon/ui/components/')) return primitive;
    throw Error(`Unexpected adapter dependency ${id}`);
  });
  Object.assign(h, {
    render(props) {
      cursor = 0; effects = []; tree = module.exports[name](props);
      for (const node of nodes(tree)) if (node.props.ref) {
        if (!refs.has(node.type)) refs.set(node.type, { isConnected: true, ownerDocument: document, children: new Set(), contains(child) { return this === child || this.children.has(child); } });
        node.props.ref.current = refs.get(node.type);
      }
      for (const index of effects) { const slot = slots[index]; slot.cleanup?.(); slot.cleanup = slot.callback(); }
      return tree;
    },
    find: type => nodes(tree).find(node => node.type === type),
    unmount() { for (const slot of slots) slot.cleanup?.(); for (const ref of refs.values()) ref.isConnected = false; },
  });
  return h;
}
const selectProps = patch => ({ value: 2, name: 'duration', required: true, id: 'shot-duration', 'data-testid': 'shot-duration', className: 'custom-select', children: [element('option', { value: 2 }, 'Two'), element('option', { value: 4, disabled: true }, 'Four ', 'seconds')], ...patch });

test('Select preserves scalar values, option labels, disabled options, trigger props, and onChange shape', () => {
  const h = harness('WorkbenchSelect'), changes = [], props = selectProps({ onChange: event => changes.push(event) });
  const root = h.render(props), trigger = h.find('SelectTrigger');
  assert.equal(root.props.value, '2'); assert.equal(root.props.name, 'duration'); assert.equal(root.props.required, true);
  assert.deepEqual(root.props.items, [{ value: '2', label: 'Two', disabled: false }, { value: '4', label: 'Four seconds', disabled: true }]);
  assert.equal(trigger.props.id, 'shot-duration'); assert.equal(trigger.props['data-testid'], 'shot-duration'); assert.equal(trigger.props.className, 'workbench-select custom-select');
  assert.equal(h.find('SelectContent').props.alignItemWithTrigger, false);
  root.props.onValueChange(4); root.props.onValueChange(null);
  assert.deepEqual(changes, [{ target: { value: '4' } }]);
  h.render({ ...props, disabled: true }); h.find('Select').props.onValueChange(2);
  assert.equal(h.find('Select').props.disabled, true); assert.equal(changes.length, 1);
});

test('Select hides an open portal immediately, disables hidden controls, and rejects old open/value callbacks across hide and re-show', () => {
  const h = harness('WorkbenchSelect'), changes = [], props = selectProps({ onChange: event => changes.push(event.target.value) });
  const initial = h.render(props), oldOpen = initial.props.onOpenChange, oldValue = initial.props.onValueChange;
  oldOpen(true); assert.equal(h.render(props).props.open, true);
  h.visible = false;
  let root = h.render(props), popup = h.find('SelectContent');
  assert.equal(root.props.open, false); assert.equal(root.props.disabled, true);
  assert.equal(popup.props.hidden, true); assert.equal(popup.props.inert, true); assert.equal(popup.props['aria-hidden'], true); assert.equal(popup.props.finalFocus, false);
  oldOpen(true); oldValue(4); root.props.onOpenChange(true); root.props.onValueChange(4);
  assert.deepEqual(changes, []); assert.equal(h.render(props).props.open, false);
  h.visible = true; root = h.render(props); assert.equal(root.props.open, false); assert.equal(root.props.value, '2');
  oldOpen(true); oldValue(4); assert.equal(h.render(props).props.open, false); assert.deepEqual(changes, []);
  root.props.onOpenChange(true); assert.equal(h.render(props).props.open, true);
  root.props.onValueChange(4); assert.deepEqual(changes, ['4']);
});

test('Select callback captured while hidden cannot reopen or change the field after reveal', () => {
  const h = harness('WorkbenchSelect'), changes = [], props = selectProps({ onChange: event => changes.push(event) });
  h.visible = false; const hidden = h.render(props);
  h.visible = true; h.render(props);
  hidden.props.onOpenChange(true); hidden.props.onValueChange(4);
  assert.equal(h.render(props).props.open, false); assert.deepEqual(changes, []);
});

test('Select final-focus callback follows current visibility and respects newer outside focus', () => {
  const h = harness('WorkbenchSelect'), props = selectProps();
  h.render(props).props.onOpenChange(true); h.render(props);
  const trigger = h.find('SelectTrigger').props.ref.current, popup = h.find('SelectContent').props.ref.current, finalFocus = h.find('SelectContent').props.finalFocus;
  assert.equal(finalFocus(), true);
  h.document.activeElement = trigger; assert.equal(finalFocus(), true);
  const option = {}; popup.children.add(option); h.document.activeElement = option; assert.equal(finalFocus(), true);
  h.document.activeElement = {}; assert.equal(finalFocus(), false);
  h.document.activeElement = h.document.body;
  h.visible = false; h.render(props); assert.equal(finalFocus(), false); assert.equal(h.find('SelectContent').props.finalFocus, false);
  h.visible = true; h.render(props); assert.equal(finalFocus(), false, 'A focus cleanup from before hide stays obsolete after reveal');
  assert.equal(h.find('SelectContent').props.finalFocus(), false, 'The latest callback also stays disarmed until a fresh open');
  h.find('Select').props.onOpenChange(true); h.render(props);
  assert.equal(h.find('SelectContent').props.finalFocus(), true);
  h.find('Select').props.onOpenChange(false); h.render(props);
  assert.equal(h.find('SelectContent').props.finalFocus(), true, 'Normal visible keyboard close may return focus to its trigger');
});

test('Select unmount invalidates pending open, value, and final-focus callbacks', () => {
  const h = harness('WorkbenchSelect'), changes = [], props = selectProps({ onChange: event => changes.push(event) });
  const root = h.render(props), finalFocus = h.find('SelectContent').props.finalFocus;
  h.unmount(); root.props.onOpenChange(true); root.props.onValueChange(4);
  assert.deepEqual(changes, []); assert.equal(finalFocus(), false);
});

test('Tooltip retains ordinary visible behavior outside panels and preserves its trigger and content', () => {
  const h = harness('WorkbenchTooltip'), trigger = element('button', {}, 'Action'), props = { children: trigger, content: 'Helpful text' };
  let root = h.render(props); assert.equal(root.props.disabled, false); assert.equal(root.props.open, false);
  assert.equal(h.find('TooltipTrigger').props.render, trigger); assert.equal(h.find('TooltipContent').props.children, 'Helpful text');
  root.props.onOpenChange(true); root = h.render(props); assert.equal(root.props.open, true);
  root.props.onOpenChange(false); assert.equal(h.render(props).props.open, false);
});

test('Tooltip hides its portal and rejects delayed hover/open callbacks after hide, reveal, or unmount', () => {
  const h = harness('WorkbenchTooltip'), props = { children: element('button'), content: 'Helpful text' };
  const old = h.render(props); old.props.onOpenChange(true); assert.equal(h.render(props).props.open, true);
  h.visible = false; const hidden = h.render(props), popup = h.find('TooltipContent');
  assert.equal(hidden.props.open, false); assert.equal(hidden.props.disabled, true); assert.equal(popup.props.hidden, true); assert.equal(popup.props.inert, true); assert.equal(popup.props['aria-hidden'], true);
  old.props.onOpenChange(true); hidden.props.onOpenChange(true); assert.equal(h.render(props).props.open, false);
  h.visible = true; let root = h.render(props); assert.equal(root.props.open, false);
  old.props.onOpenChange(true); hidden.props.onOpenChange(true); assert.equal(h.render(props).props.open, false);
  root.props.onOpenChange(true); root = h.render(props); assert.equal(root.props.open, true);
  h.unmount(); root.props.onOpenChange(false); old.props.onOpenChange(true);
});

test('all panel Select/Tooltip consumers use the app visibility-aware adapters without modifying shared primitives', () => {
  for (const filename of ['App.tsx', 'AssetLibrary.tsx', 'Inspector.tsx', 'ProviderSettings.tsx', 'ReferenceConnections.tsx', 'TimelineInspector.tsx']) {
    const text = readFileSync(new URL(`../apps/web/src/${filename}`, import.meta.url), 'utf8');
    assert.match(text, /from '\.\/WorkspaceControls\.tsx'/, filename);
    assert.doesNotMatch(text, /from '@mioon\/ui\/components\/workbench-(?:select|tooltip)'/, filename);
  }
  assert.match(source, /from '@mioon\/ui\/components\/select'/); assert.match(source, /from '@mioon\/ui\/components\/tooltip'/);
});

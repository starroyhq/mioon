import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { createSettingsNavigationRegistry, type SettingsNavigationCapture, type SettingsNavigationState } from '../apps/web/src/settings-navigation-state.ts';

const source = readFileSync(new URL('../apps/web/src/SettingsNavigationSlot.tsx', import.meta.url), 'utf8');
const state = (version: number, patch: { dirty?: boolean; busy?: boolean; }|undefined = {}) => ({ dirty: false, busy: false, blocked: false, version, ...patch });
// Execute the real component with an explicit insertion-before-layout cleanup
// schedule. This is a component lifecycle contract, not a browser/native test.
function fixture() {
  type Report = (state: SettingsNavigationState) => void;
  interface Child {type: string;props: {value: string;onClick(): void}}
  interface Hook {value?: unknown;deps: readonly unknown[];cleanup?: void | (() => void)}
  const hooks: Hook[] = []; let cursor = 0, insertion: (() => void)[] = [], layouts: (() => void)[] = [], report!: Report, output!: (Child | null)[];
  function memo<T>(factory: () => T, deps: readonly unknown[]): T { const i = cursor++, old = hooks[i]; if (!old || deps.some((x, j) => x !== old.deps[j])) hooks[i] = { value: factory(), deps }; return hooks[i].value as T; }
  function effect(queue: (() => void)[], callback: () => void | (() => void), deps: readonly unknown[]) { const i = cursor++, old = hooks[i]; if (!old || deps.some((x, j) => x !== old.deps[j])) { queue.push(() => { old?.cleanup?.(); hooks[i] = { deps, cleanup: callback() }; }); } }
  const react = { createElement: (_type: unknown, _props: unknown, ...children: unknown[]) => children, Fragment: 'fragment', useMemo: memo,
    useCallback: <T>(callback: T, deps: readonly unknown[]) => memo(() => callback, deps),
    useInsertionEffect: (callback: () => void | (() => void), deps: readonly unknown[]) => effect(insertion, callback, deps),
    useLayoutEffect: (callback: () => void | (() => void), deps: readonly unknown[]) => effect(layouts, callback, deps),
  };
  const module = { exports: {} as {default(props: {registry?: ReturnType<typeof createSettingsNavigationRegistry>;slot: string;children(report: Report): Child | null}): (Child | null)[]} };
  Function('require', 'module', 'exports', transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code)((name: string) => {
    if (name === 'react') return react;
    if (name === './settings-navigation-state.ts') return { createSettingsNavigationRegistry };
    assert.fail(`Unexpected dependency: ${name}`);
  }, module, module.exports);
  return {
    render(registry?: ReturnType<typeof createSettingsNavigationRegistry>, slot: string = 'home:agent', child: Child | null = null) { cursor = 0; insertion = []; layouts = []; output = module.exports.default({ registry, slot, children: next => { report = next; return child; } }); for (const fn of insertion) fn(); for (const fn of layouts) fn(); return report; },
    get output() { return output; },
    retireBeforeChildCleanup(childCleanup: () => void) { for (const item of hooks) item.cleanup?.(); childCleanup(); },
  };
}

test('settings slot owns monotonic metadata and never clears an unchanged mounted form', () => {
  const f = fixture(), registry = createSettingsNavigationRegistry(), report = f.render(registry);
  report(state(1, { dirty: true })); const captured = registry.capture();
  assert.equal(registry.needsConfirmation(captured), true); assert.equal(registry.canLeave(captured), true);
  assert.equal(f.render(registry), report); assert.deepEqual(registry.capture(), captured);
  report(state(2, { busy: true })); assert.equal(registry.canLeave(captured), false); assert.equal(registry.canLeave(registry.capture()), false);
});

test('insertion cleanup retires report before a descendant cleanup or late ACK can register again', () => {
  const f = fixture(), registry = createSettingsNavigationRegistry(), report = f.render(registry);
  report(state(1, { dirty: true }));
  f.retireBeforeChildCleanup(() => report(state(2)));
  report(state(3, { busy: true }));
  assert.deepEqual((registry.capture() as unknown), []); assert.equal(registry.canLeave(registry.capture()), true);
  assert.match(source, /useInsertionEffect\(\(\) =>/);
});

test('registry or slot replacement retires the old callback without erasing the new owner', () => {
  const f = fixture(), first = createSettingsNavigationRegistry(), second = createSettingsNavigationRegistry();
  const oldReport = f.render(first); oldReport(state(1, { dirty: true }));
  const nextReport = f.render(second, 'home:custom'); nextReport(state(1, { dirty: true }));
  oldReport(state(2)); assert.deepEqual((first.capture() as unknown), []);
  const current = second.capture(); assert.equal(current.length, 1); assert.equal(current[0].slot, 'home:custom'); assert.equal(current[0].dirty, true);
});

test('retired owner cannot release or overwrite a replacement using the same registry slot', () => {
  const old = fixture(), next = fixture(), registry = createSettingsNavigationRegistry();
  const oldReport = old.render(registry); oldReport(state(1, { dirty: true }));
  const nextReport = next.render(registry); nextReport(state(1, { busy: true }));
  old.retireBeforeChildCleanup(() => oldReport(state(2)));
  assert.equal(registry.capture().length, 1); assert.equal(registry.capture()[0].busy, true);
  nextReport(state(2)); assert.equal(registry.canLeave(registry.capture()), true);
});

test('an omitted registry preserves legacy optional-consumer behavior', () => {
  const f = fixture(), report = f.render(undefined); assert.doesNotThrow(() => report(state(1, { dirty: true })));
  assert.doesNotThrow(() => f.retireBeforeChildCleanup(() => report(state(2))));
});

test('actual slot without a registry retains the exact child, input value and explicit handler', () => {
  const f = fixture(), calls: unknown[] = [];
  const click = () => { calls.push('explicit click'); };
  const child = { type: 'Settings', props: { value: 'retained input', onClick: click } };
  const report = f.render(undefined, 'workbench:official', child);
  assert.deepEqual(f.output, [child]); assert.equal(f.output[0], child);
  assert.equal(f.output[0].props.value, 'retained input');
  assert.equal(f.output[0].props.onClick, click); assert.deepEqual((calls as unknown), []);
  report(state(1, { dirty: true, busy: true }));
  assert.equal(f.render(undefined, 'workbench:official', child), report);
  assert.equal(f.output[0], child); assert.deepEqual((calls as unknown), []);
  f.output[0].props.onClick(); assert.deepEqual(calls, ['explicit click']);
  f.retireBeforeChildCleanup(() => report(state(2)));
  assert.deepEqual(calls, ['explicit click']);
});

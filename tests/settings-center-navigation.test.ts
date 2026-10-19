import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';
import { createSettingsWindowNavigation } from '../apps/web/src/settings-window-state.ts';
import { createWebSettingsNavigation } from '../apps/web/src/web-settings-navigation.ts';
import { LOCALES, renderMessage, translate } from '../packages/i18n/src/index.ts';
import type {ProjectWindowContext, ProjectWindowSettingsSlot} from '../apps/web/src/desktop-window-client.ts';
import type {SettingsNavigationState} from '../apps/web/src/settings-navigation-state.ts';

const slots: ProjectWindowSettingsSlot[] = ['agent', 'official', 'custom', 'comfy'];
const uuid = (n: number) => `69000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = (patch: Record<string, unknown>): ProjectWindowContext => ({ version: 2, role: 'settings', windowId: uuid(1), contextId: uuid(2), backendId: uuid(3),
  initialProjectId: null, autoOpen: false, editorProjectId: null, editorPhase: 'none', editorCount: 1,
  entryMode: null, entryVersion: 0, entryReceipt: null, settingsSlot: 'agent', settingsVersion: 1,
  selectionProjectId: null, selectionVersion: 0, locatorStatus: null, locatorIntent: null, quitting: false, ...patch } as ProjectWindowContext);
const state = (version: number, patch: Record<string, unknown> = {}): SettingsNavigationState => ({ dirty: false, busy: false, blocked: false, version, ...patch } as SettingsNavigationState);
const tick = () => new Promise(setImmediate);
type NavRegistry = ReturnType<typeof createSettingsNavigationRegistry>;
type NavWindow = ReturnType<typeof createSettingsWindowNavigation>;
interface NavFixture {registry: NavRegistry; owners: Map<string, ReturnType<NavRegistry['register']>>; confirmations: unknown[]; changes: {page: unknown; selected: unknown}[]; navigation: NavWindow}
function fixture({ confirm = async () => true, initial = {} }: {confirm?: (value: unknown) => Promise<unknown>; initial?: Record<string, unknown>} = {}): NavFixture {
  const registry = createSettingsNavigationRegistry(), owners = new Map<string, ReturnType<NavRegistry['register']>>(), confirmations: unknown[] = [], changes: {page: unknown; selected: unknown}[] = [];
  for (const slot of slots) { const owner = registry.register(slot); owner.update(state(1) as never); owners.set(slot, owner); }
  const navigation = createSettingsWindowNavigation({ context: context(initial), registry,
    confirm: (message) => { confirmations.push(message); return confirm(message) as Promise<boolean>; },
    onChange: () => changes.push({ page: navigation.page, selected: navigation.selected }),
  });
  return { registry, owners, confirmations, changes, navigation };
}

test('General is a presentation page and preserves the last connection slot and every mounted owner', async () => {
  for (const slot of slots) {
    const f = fixture({ initial: { settingsSlot: slot } }), captured = f.registry.capture();
    assert.equal(f.navigation.page, slot); assert.equal(f.navigation.selected, slot);
    assert.equal(await f.navigation.selectPage('general'), true);
    assert.equal(f.navigation.page, 'general'); assert.equal(f.navigation.selected, slot);
    assert.deepEqual(f.registry.capture(), captured); assert.equal(f.registry.canLeave(captured), true);
    assert.equal(f.confirmations.length, 0);
    assert.equal(await f.navigation.select(slot), true, 'Same-slot connection requests must leave General');
    assert.equal(f.navigation.page, slot); assert.equal(f.navigation.selected, slot);
    assert.deepEqual(f.registry.capture(), captured);
  }
});

test('missing initial slot retains the existing agent default rather than creating an IPC General slot', () => {
  const f = fixture({ initial: { settingsSlot: null } });
  assert.equal(f.navigation.selected, 'agent'); assert.equal(f.navigation.page, 'agent');
});

test('cancelled dirty navigation into or out of General leaves page, connection and ownership unchanged', async () => {
  for (const startingPage of ['agent', 'general']) {
    const f = fixture({ confirm: async () => false });
    if (startingPage === 'general') await f.navigation.selectPage('general');
    f.owners.get('custom')!.update(state(2, { dirty: true }) as never);
    const captured = f.registry.capture(), changes = f.changes.length;
    assert.equal(await f.navigation.selectPage(startingPage === 'general' ? 'official' : 'general'), false);
    assert.equal(f.navigation.page, startingPage); assert.equal(f.navigation.selected, 'agent');
    assert.equal(f.confirmations.length, 1); assert.equal(f.changes.length, changes);
    assert.deepEqual(f.registry.capture(), captured); assert.equal(f.registry.canLeave(captured), true);
  }
});

test('accepted dirty page changes retain the registry and dirty draft metadata without clearing or saving it', async () => {
  const f = fixture(); f.owners.get('agent')!.update(state(2, { dirty: true }) as never);
  const captured = f.registry.capture();
  assert.equal(await f.navigation.selectPage('general'), true);
  assert.equal(f.navigation.page, 'general'); assert.equal(f.navigation.selected, 'agent');
  assert.deepEqual(f.registry.capture(), captured); assert.equal(f.registry.needsConfirmation(captured), true);
  assert.equal(await f.navigation.selectPage('comfy'), true);
  assert.equal(f.navigation.page, 'comfy'); assert.equal(f.navigation.selected, 'comfy');
  assert.deepEqual(f.registry.capture(), captured); assert.equal(f.confirmations.length, 2);
});

test('a second dirty edit while General confirmation is open invalidates the exact captured version', async () => {
  const answer = Promise.withResolvers<boolean>(), f = fixture({ confirm: () => answer.promise });
  f.owners.get('agent')!.update(state(2, { dirty: true }));
  const pending = f.navigation.selectPage('general');
  f.owners.get('agent')!.update(state(3, { dirty: true }));
  answer.resolve(true);
  assert.equal(await pending, false); assert.equal(f.navigation.page, 'agent');
  assert.equal(f.navigation.selected, 'agent'); assert.equal(f.changes.length, 0);
  assert.equal((f.registry.capture().find(entry => entry.slot === 'agent') as {version: number}).version, 3);
});

test('replacement or release of an owner during confirmation cannot authorize a stale page change', async () => {
  for (const change of ['replace', 'release']) {
    const answer = Promise.withResolvers<boolean>(), f = fixture({ confirm: () => answer.promise });
    f.owners.get('custom')!.update(state(2, { dirty: true }) as never);
    const pending = f.navigation.selectPage('general');
    if (change === 'replace') f.registry.register('custom').update(state(1, { dirty: true }));
    else f.owners.get('custom')!.release();
    const captured = f.registry.capture(); answer.resolve(true);
    assert.equal(await pending, false); assert.equal(f.navigation.page, 'agent');
    assert.deepEqual(f.registry.capture(), captured);
  }
});

test('newer page or connection intent wins even when older confirmation resolves last', async () => {
  for (const next of ['custom', 'general']) {
    const answers: {promise: Promise<boolean>; resolve(value: boolean): void}[] = [], f = fixture({ confirm: () => { const answer = Promise.withResolvers<boolean>(); answers.push(answer); return answer.promise; } });
    f.owners.get('agent')!.update(state(2, { dirty: true }));
    const older = f.navigation.selectPage(next === 'general' ? 'official' : 'general');
    const newer = next === 'general' ? f.navigation.selectPage(next as never) : f.navigation.select(next as ProjectWindowSettingsSlot);
    assert.equal(answers.length, 2); answers[1]!.resolve(true); assert.equal(await newer, true);
    answers[0]!.resolve(true); assert.equal(await older, false);
    assert.equal(f.navigation.page, next); assert.equal(f.navigation.selected, next === 'general' ? 'agent' : next);
    assert.equal(f.changes.length, 1);
  }
});

test('a same-page local intent synchronously revokes older pending departure permission', async () => {
  const answer = Promise.withResolvers<boolean>(), f = fixture({ confirm: () => answer.promise });
  await f.navigation.selectPage('general'); f.owners.get('agent')!.update(state(2, { dirty: true }));
  const pending = f.navigation.select('custom');
  assert.equal(await f.navigation.selectPage('general'), true);
  answer.resolve(true); assert.equal(await pending, false);
  assert.equal(f.navigation.page, 'general'); assert.equal(f.navigation.selected, 'agent');
  assert.equal(f.confirmations.length, 1);
});

test('busy, blocked or unreported hidden owners prevent General changes before confirmation', async () => {
  for (const startingPage of ['agent', 'general']) for (const mode of ['busy', 'blocked', 'unreported']) {
    const f = fixture({ confirm: () => assert.fail('Unsafe owners must not be offered discard confirmation') });
    if (startingPage === 'general') await f.navigation.selectPage('general');
    if (mode === 'unreported') f.registry.register('custom');
    else f.owners.get('custom')!.update(state(2, { dirty: true, [mode]: true }));
    const captured = f.registry.capture();
    assert.equal(await f.navigation.selectPage(startingPage === 'general' ? 'comfy' : 'general'), false);
    assert.equal(f.navigation.page, startingPage); assert.equal(f.navigation.selected, 'agent');
    assert.deepEqual(f.registry.capture(), captured); assert.equal(f.confirmations.length, 0);
    assert.deepEqual(f.navigation.notice, { key: 'shell.settingsBusy' });
  }
});

test('busy state arriving during confirmation invalidates permission and does not clear the form', async () => {
  const answer = Promise.withResolvers<boolean>(), f = fixture({ confirm: () => answer.promise });
  f.owners.get('official')!.update(state(2, { dirty: true }));
  const pending = f.navigation.selectPage('general');
  f.owners.get('official')!.update(state(3, { dirty: true, busy: true })); answer.resolve(true);
  assert.equal(await pending, false); assert.equal(f.navigation.page, 'agent');
  const current = f.registry.capture().find(entry => entry.slot === 'official')!;
  assert.equal(current.dirty, true); assert.equal(current.busy, true); assert.equal(current.version, 3);
});

test('newer native same-slot requests leave General without changing the IPC connection slot', async () => {
  for (const slot of slots) {
    const f = fixture({ initial: { settingsSlot: slot } }); await f.navigation.selectPage('general');
    const captured = f.registry.capture();
    f.navigation.receive(context({ settingsSlot: slot, settingsVersion: 2 })); await tick();
    assert.equal(f.navigation.page, slot); assert.equal(f.navigation.selected, slot);
    assert.deepEqual(f.registry.capture(), captured);
  }
});

test('native same-slot requests from General use the same dirty confirmation and stale-version guard', async () => {
  const answer = Promise.withResolvers<boolean>(), f = fixture({ confirm: () => answer.promise });
  await f.navigation.selectPage('general'); f.owners.get('agent')!.update(state(2, { dirty: true }));
  f.navigation.receive(context({ settingsVersion: 2 })); assert.equal(f.confirmations.length, 1);
  f.owners.get('agent')!.update(state(3, { dirty: true })); answer.resolve(true); await tick();
  assert.equal(f.navigation.page, 'general'); assert.equal(f.navigation.selected, 'agent');
  f.navigation.receive(context({ settingsVersion: 2 })); await tick();
  assert.equal(f.confirmations.length, 1, 'A replayed native intent must not ask again');
});

test('foreign, stale and equal-version native selection requests do not pull the user out of General', async () => {
  const f = fixture(); await f.navigation.selectPage('general'); const version = f.navigation.version;
  for (const patch of [{ role: 'editor' }, { windowId: uuid(7) }, { contextId: uuid(8) }, { backendId: uuid(9) }])
    f.navigation.receive(context({ settingsSlot: 'custom', settingsVersion: 2, ...patch }));
  for (const settingsVersion of [0, 1]) f.navigation.receive(context({ settingsSlot: 'custom', settingsVersion }));
  await tick(); assert.equal(f.navigation.page, 'general'); assert.equal(f.navigation.selected, 'agent');
  assert.equal(f.navigation.version, version); assert.equal(f.confirmations.length, 0);
  f.navigation.receive(context({ settingsSlot: 'official', settingsVersion: 2 })); await tick();
  assert.equal(f.navigation.page, 'official'); assert.equal(f.navigation.selected, 'official');
});

test('newer same-slot native intent supersedes a pending General transition synchronously', async () => {
  const answer = Promise.withResolvers<boolean>(), f = fixture({ confirm: () => answer.promise });
  f.owners.get('agent')!.update(state(2, { dirty: true }));
  const pending = f.navigation.selectPage('general');
  f.navigation.receive(context({ settingsSlot: 'agent', settingsVersion: 2 }));
  answer.resolve(true); assert.equal(await pending, false);
  assert.equal(f.navigation.page, 'agent'); assert.equal(f.navigation.selected, 'agent');
  assert.equal(f.confirmations.length, 1);
});

test('confirmation and busy notices remain immutable descriptors that can render in all four locales', async () => {
  const answer = Promise.withResolvers<boolean>(), f = fixture({ confirm: () => answer.promise });
  f.owners.get('agent')!.update(state(2, { dirty: true }));
  const pending = f.navigation.selectPage('general'), descriptor = f.confirmations[0];
  const version = f.navigation.version, captured = f.registry.capture();
  assert.deepEqual(descriptor, { key: 'shell.changeConnectionConfirm' }); assert.equal(Object.isFrozen(descriptor), true);
  for (const locale of LOCALES) assert.equal(renderMessage(locale, descriptor), translate(locale, 'shell.changeConnectionConfirm'));
  assert.equal(f.navigation.version, version); assert.deepEqual(f.registry.capture(), captured);
  answer.resolve(true); assert.equal(await pending, true, 'Language rendering is not a new navigation or form edit');
  f.owners.get('agent')!.update(state(3, { busy: true })); assert.equal(await f.navigation.select('custom'), false);
  const notice = f.navigation.notice; assert.equal(Object.isFrozen(notice), true);
  for (const locale of LOCALES) assert.equal(renderMessage(locale, notice), translate(locale, 'shell.settingsBusy'));
  assert.equal(f.navigation.notice, notice); assert.equal(f.navigation.page, 'general');
});

test('disposal denies page, slot and native navigation and revokes pending consent even after reactivation', async () => {
  const answer = Promise.withResolvers<boolean>(), f = fixture({ confirm: () => answer.promise });
  f.owners.get('agent')!.update(state(2, { dirty: true }));
  const captured = f.registry.capture(), pending = f.navigation.selectPage('general'); f.navigation.dispose();
  assert.equal(await f.navigation.selectPage('general'), false); assert.equal(await f.navigation.select('custom'), false);
  f.navigation.receive(context({ settingsSlot: 'official', settingsVersion: 2 }));
  f.navigation.activate(); answer.resolve(true); assert.equal(await pending, false);
  assert.equal(f.navigation.page, 'agent'); assert.equal(f.navigation.selected, 'agent');
  assert.deepEqual(f.registry.capture(), captured); assert.equal(f.changes.length, 0);
});

test('live same-version quitting updates deny both page navigation and pending confirmation', async () => {
  const answer = Promise.withResolvers<boolean>(), f = fixture({ confirm: () => answer.promise });
  f.owners.get('agent')!.update(state(2, { dirty: true }));
  const pending = f.navigation.selectPage('general'); f.navigation.receive(context({ quitting: true }));
  answer.resolve(true); assert.equal(await pending, false);
  assert.equal(await f.navigation.selectPage('general'), false); assert.equal(await f.navigation.select('custom'), false);
  assert.equal(f.navigation.page, 'agent'); assert.equal(f.navigation.selected, 'agent');
  assert.equal(f.confirmations.length, 1);
});

function webFixture(confirm: (value: unknown) => Promise<unknown> = async () => true) {
  const registry = createSettingsNavigationRegistry(), owner = registry.register('home:agent'), confirmations: unknown[] = [];
  owner.update(state(1));
  const navigation = createWebSettingsNavigation({ registry, confirm: descriptor => { confirmations.push(descriptor); return confirm(descriptor) as Promise<boolean>; } });
  return { registry, owner, navigation, confirmations };
}

test('web center opens General by default and close/reopen preserves selected slot, page and mounted owners', async () => {
  const f = webFixture(), captured = f.registry.capture();
  assert.equal(f.navigation.opened, false); assert.equal(f.navigation.page, 'general'); assert.equal(f.navigation.selected, 'agent');
  assert.equal(await f.navigation.selectPage('custom'), false, 'A hidden UI cannot activate stale page handlers');
  assert.equal(await (f.navigation.open as unknown as (slot?: string)=>Promise<boolean>)(), true); assert.equal(f.navigation.opened, true); assert.equal(f.navigation.page, 'general');
  assert.equal(await f.navigation.selectPage('custom'), true); assert.equal(f.navigation.selected, 'custom');
  assert.equal(await f.navigation.close(), true); assert.equal(f.navigation.opened, false); assert.equal(f.navigation.page, 'custom');
  assert.equal(await (f.navigation.open as unknown as (slot?: string)=>Promise<boolean>)('custom'), true); assert.equal(f.navigation.opened, true); assert.equal(f.navigation.page, 'custom');
  assert.equal(await f.navigation.selectPage('general'), true); assert.equal(f.navigation.selected, 'custom');
  assert.deepEqual(f.registry.capture(), captured); assert.equal(f.confirmations.length, 0);
});

test('web dirty close cancellation leaves the page open and accepted close keeps dirty owners for reopening', async () => {
  for (const accepted of [false, true]) {
    const f = webFixture(async () => accepted); await (f.navigation.open as unknown as (slot?: string)=>Promise<boolean>)('official');
    f.owner.update(state(2, { dirty: true })); const captured = f.registry.capture();
    assert.equal(await f.navigation.close(), accepted); assert.equal(f.navigation.opened, !accepted);
    assert.equal(f.navigation.page, 'official'); assert.equal(f.navigation.selected, 'official');
    assert.deepEqual(f.registry.capture(), captured); assert.equal(f.confirmations.length, 1);
    if (accepted) {
      assert.equal(await (f.navigation.open as unknown as (slot?: string)=>Promise<boolean>)('official'), true); assert.equal(f.navigation.opened, true);
      assert.deepEqual(f.registry.capture(), captured); assert.equal(f.registry.needsConfirmation(captured), true);
    }
  }
});

test('web async close cannot use permission from a previous edit, owner or busy state', async () => {
  for (const transition of ['edit', 'replacement', 'busy']) {
    const answer = Promise.withResolvers<boolean>(), f = webFixture(() => answer.promise); await (f.navigation.open as unknown as (slot?: string)=>Promise<boolean>)('custom');
    f.owner.update(state(2, { dirty: true })); const pending = f.navigation.close();
    if (transition === 'replacement') f.registry.register('home:agent').update(state(1, { dirty: true }));
    else f.owner.update(state(3, { dirty: true, busy: transition === 'busy' }));
    const captured = f.registry.capture(); answer.resolve(true);
    assert.equal(await pending, false); assert.equal(f.navigation.opened, true); assert.equal(f.navigation.page, 'custom');
    assert.deepEqual(f.registry.capture(), captured);
  }
});

test('web newer same-page open supersedes pending close without discarding or recreating owners', async () => {
  const answer = Promise.withResolvers<boolean>(), f = webFixture(() => answer.promise); await (f.navigation.open as unknown as (slot?: string)=>Promise<boolean>)('agent');
  f.owner.update(state(2, { dirty: true })); const captured = f.registry.capture(), pending = f.navigation.close();
  assert.equal(await (f.navigation.open as unknown as (slot?: string)=>Promise<boolean>)('agent'), true); answer.resolve(true);
  assert.equal(await pending, false); assert.equal(f.navigation.opened, true); assert.equal(f.navigation.page, 'agent');
  assert.deepEqual(f.registry.capture(), captured); assert.equal(f.confirmations.length, 1);
});

test('web newer close wins over older pending page selection even when the older confirmation resolves last', async () => {
  const answers: {promise: Promise<boolean>; resolve(value: boolean): void}[] = [], f = webFixture(() => { const answer = Promise.withResolvers<boolean>(); answers.push(answer); return answer.promise; });
  await (f.navigation.open as unknown as (slot?: string)=>Promise<boolean>)('agent'); f.owner.update(state(2, { dirty: true }));
  const page = f.navigation.selectPage('general'), close = f.navigation.close();
  assert.equal(answers.length, 2); answers[1]!.resolve(true); assert.equal(await close, true);
  answers[0]!.resolve(true); assert.equal(await page, false);
  assert.equal(f.navigation.opened, false); assert.equal(f.navigation.page, 'agent'); assert.equal(f.navigation.selected, 'agent');
});

test('web busy or blocked owners deny closing, category changes and reopening before any confirmation', async () => {
  for (const opened of [false, true]) for (const flag of ['busy', 'blocked']) {
    const f = webFixture(() => assert.fail('Unsafe forms cannot be offered a discard prompt'));
    if (opened) await (f.navigation.open as unknown as (slot?: string)=>Promise<boolean>)('agent');
    f.owner.update(state(2, { dirty: true, [flag]: true })); const captured = f.registry.capture();
    assert.equal(await (opened ? f.navigation.close() : (f.navigation.open as unknown as (slot?: string)=>Promise<boolean>)('custom')), false);
    assert.equal(await f.navigation.selectPage('general'), false); assert.equal(f.navigation.opened, opened);
    assert.equal(f.navigation.page, opened ? 'agent' : 'general'); assert.deepEqual(f.registry.capture(), captured);
    assert.deepEqual(f.navigation.notice, { key: 'shell.settingsBusy' }); assert.equal(f.confirmations.length, 0);
  }
});

test('web disposal revokes pending close and denies stale open or page actions after teardown', async () => {
  const answer = Promise.withResolvers<boolean>(), f = webFixture(() => answer.promise); await (f.navigation.open as unknown as (slot?: string)=>Promise<boolean>)('custom');
  f.owner.update(state(2, { dirty: true })); const pending = f.navigation.close(); f.navigation.dispose();
  assert.equal(await (f.navigation.open as unknown as (slot?: string)=>Promise<boolean>)(), false); assert.equal(await f.navigation.selectPage('general'), false);
  f.navigation.activate(); answer.resolve(true); assert.equal(await pending, false);
  assert.equal(f.navigation.opened, true); assert.equal(f.navigation.page, 'custom'); assert.equal(f.navigation.selected, 'custom');
});

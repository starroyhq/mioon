import type {ProjectWindowContext} from '../apps/web/src/desktop-window-client.ts';
import type {useNativeProjectEntry} from '../apps/web/src/native-project-entry.ts';
type Controller=ReturnType<typeof useNativeProjectEntry>;
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { schemas, workspaceRestoreInspectionSchema } from '../packages/contracts/src/index.ts';
import { createLauncherClient } from '../apps/web/src/launcher-state.ts';
import { createProjectEntryController } from '../apps/web/src/project-entry-state.ts';

const uuid = (n: number) => `79000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = (patch?: { autoOpen?: boolean; role?: string; initialProjectId?: string; editorProjectId?: string; editorPhase?: string; editorCount?: number; }|undefined) => ({ version: 2, role: 'launcher', windowId: uuid(1), contextId: uuid(2), backendId: uuid(3), initialProjectId: null, autoOpen: false,
  editorProjectId: null, editorPhase: 'none', editorCount: 0, entryMode: null, entryVersion: 0, entryReceipt: null,
  settingsSlot: null, settingsVersion: 0, selectionProjectId: null, selectionVersion: 0, locatorStatus: null, locatorIntent: null, quitting: false, ...patch });
const project = (n: number) => ({ id: uuid(n), name: `Project ${n}`, description: '', revision: 1, createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z' });
const tick = () => new Promise(setImmediate);
const source = readFileSync(new URL('../apps/web/src/native-project-entry.ts', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;

/** Run the real renderer hook and controller; only React scheduling, the DOM,
 * read-only RPC transport and native bridge are synthetic. */
function fixture({ initialContext = context(), visible = true, list, open, create = async () => { throw new Error('lost create ACK'); } }: {initialContext?:ReturnType<typeof context>;visible?:boolean;list?:()=>unknown;open?:()=>unknown;create?:(input:unknown)=>unknown} = {}) {
  const effects:(()=>void|(()=>void))[] = [], cleanups:(()=>void)[] = [], calls: (string | Error | undefined)[] = [], opens:{projectId:string;remember:boolean;entryToken:string}[] = [], listeners = new Set<(value:ReturnType<typeof context>)=>void>();
  let current = initialContext, catalog = [project(10), project(11)], controller:Controller;
  const document = new EventTarget() as EventTarget&{visibilityState:string}; document.visibilityState = visible ? 'visible' : 'hidden';
  const window:{location:{search:string};__mioonProjectEntryAdmission?:{consume:Controller['consume']}} = { location: { search: '' } };
  const bridge = {
    context: async () => current,
    subscribe(listener:(value:ReturnType<typeof context>)=>void) { listeners.add(listener); return () => listeners.delete(listener); },
    async openProject(projectId:string,remember:boolean,entryToken:string) {
      opens.push({ projectId, remember, entryToken });
      assert.equal(controller.consume(entryToken, projectId).accepted, true);
      if (open) return open();
      return { ok: true, reason: 'accepted', targetWindowId: uuid(90), targetPhase: 'opening' };
    },
  };
  const locator = { activate() {}, dispose() {}, discover: async () => null, getState: () => ({ identityBlocked: false }),
    invalidateNavigation() {}, rememberOpened() { assert.fail('Visibility refresh must not write a locator'); } };
  const module = {exports:{}} as {exports:typeof import('../apps/web/src/native-project-entry.ts')};
  Function('require', 'module', 'exports', 'window', 'document', code)((name: string) => {
    if (name === 'react') return { useEffect: (callback:()=>void|(()=>void)) => effects.push(callback), useState: (initial: () => unknown) => [typeof initial === 'function' ? initial() : initial, () => {}] };
    if (name === '@mioon/ui/components/workbench-confirm') return { useConfirmation: () => async () => true };
    if (name === './launcher-state.ts') return { createLauncherClient };
    if (name === './project-entry-state.ts') return { createProjectEntryController };
    assert.fail(`Unexpected hook dependency ${name}`);
  }, module, module.exports, window, document);
  controller = module.exports.useNativeProjectEntry(({ context: initialContext, bridge, locator,
    contractChecks: { parseCreateInput: (value: unknown) => schemas['project.create'].parse(value), parseWorkspaceInspection: (value: unknown) => workspaceRestoreInspectionSchema.parse(value) },
    rpc: async (operation: string|Error|undefined, input: unknown) => {
      calls.push(operation);
      if (operation === 'workspace.restore.inspect') return { restored: false };
      if (operation === 'project.list') return list ? list() : catalog;
      if (operation === 'project.create') return create(input);
      assert.fail(operation);
    } } as unknown as Parameters<typeof module.exports.useNativeProjectEntry>[0]));
  effects.forEach(effect => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); });
  return { controller, calls, opens, window,
    catalog(value: { id: string; name: string; description: string; revision: number; createdAt: string; updatedAt: string; }[]) { catalog = value; },
    receive(patch: { editorCount?: number; quitting?: boolean; }) { current = { ...current, ...patch }; listeners.forEach(listener => listener(current)); },
    visibility(value: boolean) { document.visibilityState = value ? 'visible' : 'hidden'; document.dispatchEvent(new Event('visibilitychange')); },
    dispose() { cleanups.forEach(cleanup => cleanup()); },
  };
}

test('returning native launcher refreshes A/B to A/B/C after the last editor closes without a manual click', async () => {
  const f = fixture(); await tick();
  assert.deepEqual(f.controller.getState().projects.map((row: { id: unknown; }) => row.id), [uuid(10), uuid(11)]);
  f.controller.reportCreate({ dirty: true, busy: false, version: 1 });
  const before = f.controller.readCloseSnapshot();
  f.visibility(false); f.receive({ editorCount: 1 });
  f.catalog([project(10), project(11), project(12)]);
  f.receive({ editorCount: 0 }); f.visibility(true); await tick();
  assert.deepEqual(f.controller.getState().projects.map((row: { id: unknown; }) => row.id), [uuid(10), uuid(11), uuid(12)]);
  assert.deepEqual(f.calls, ['workspace.restore.inspect', 'project.list', 'workspace.restore.inspect', 'project.list']);
  assert.deepEqual(f.controller.readCloseSnapshot(), before, 'Read-only refresh must preserve the exact dirty owner and close evidence');
  f.visibility(true); f.visibility(true); await tick();
  assert.equal(f.calls.length, 4, 'Repeated visible events are not another reveal');
  assert.deepEqual((f.opens as unknown), []); f.dispose();
});

test('first reveal keeps the initial boot read and its one-time auto-open instead of superseding it', async () => {
  const pending = Promise.withResolvers();
  const f = fixture({ initialContext: context({ autoOpen: true }), visible: false, list: () => pending.promise }); await tick();
  f.visibility(true); pending.resolve([project(10)]); await tick();
  assert.equal(f.calls.filter(op => op === 'project.list').length, 1);
  assert.equal(f.opens.length, 1); assert.equal(f.opens[0].remember, false);
  f.visibility(false); f.visibility(true); await tick();
  assert.equal(f.calls.filter(op => op === 'project.list').length, 2); assert.equal(f.opens.length, 1);
  f.dispose();
});

test('editor visibility alone never boots or refreshes its retained project picker', async () => {
  const f = fixture({ initialContext: context({ role: 'editor', initialProjectId: uuid(10), editorProjectId: uuid(10), editorPhase: 'ready', editorCount: 1 }) });
  f.visibility(false); f.visibility(true); await tick(); assert.deepEqual((f.calls as unknown), []);
  await f.controller.show('open'); await tick(); const reads = f.calls.length;
  f.visibility(false); f.visibility(true); await tick(); assert.equal(f.calls.length, reads); assert.deepEqual((f.opens as unknown), []); f.dispose();
});

test('an initially hidden launcher whose boot is complete refreshes on its first actual reveal', async () => {
  const f = fixture({ visible: false }); await tick();
  assert.equal(f.calls.filter(op => op === 'project.list').length, 1);
  f.receive({ editorCount: 1 }); f.catalog([project(10), project(11), project(12)]);
  f.receive({ editorCount: 0 }); f.visibility(true); await tick();
  assert.deepEqual(f.controller.getState().projects.map((row: { id: unknown; }) => row.id), [uuid(10), uuid(11), uuid(12)]);
  assert.equal(f.calls.filter(op => op === 'project.list').length, 2); assert.deepEqual((f.opens as unknown), []); f.dispose();
});

test('a later launcher reveal owns its catalog and ignores a superseded success or failure', async () => {
  for (const failure of [false, true]) {
    const older = Promise.withResolvers(); let reads = 0;
    const f = fixture({ list: () => ++reads === 1 ? [project(10)] : reads === 2 ? older.promise : [project(10), project(12)] }); await tick();
    f.visibility(false); f.visibility(true); await tick(); assert.equal(reads, 2);
    f.visibility(false); f.visibility(true); await tick(); assert.equal(reads, 3);
    if (failure) older.reject(new Error('old read failed')); else older.resolve([project(10), project(11)]);
    await tick(); assert.deepEqual(f.controller.getState().projects.map((row: { id: unknown; }) => row.id), [uuid(10), uuid(12)]);
    assert.equal(f.controller.getState().listError, ''); assert.deepEqual((f.opens as unknown), []); f.dispose();
  }
});

test('disposed visibility subscriptions and old lifetime replies cannot mutate a reactivated owner', async () => {
  const older = Promise.withResolvers(); let reads = 0;
  const f = fixture({ list: () => ++reads === 1 ? [project(10)] : reads === 2 ? older.promise : [project(12)] }); await tick();
  f.visibility(false); f.visibility(true); await tick(); assert.equal(reads, 2);
  f.dispose(); f.controller.activate(); await f.controller.refresh();
  older.resolve([project(11)]); await tick();
  assert.deepEqual(f.controller.getState().projects.map((row: { id: unknown; }) => row.id), [uuid(12)]);
  f.visibility(false); f.visibility(true); await tick(); assert.equal(reads, 3);
  assert.equal(f.window.__mioonProjectEntryAdmission, undefined); f.controller.dispose();
});

test('visibility refresh may show a created row but never acknowledges unknown creation or releases its draft', async () => {
  const f = fixture(); await tick();
  f.controller.reportCreate({ dirty: true, busy: false, version: 1 });
  assert.equal(await f.controller.create('Project 12', ''), false);
  const before = f.controller.readCloseSnapshot(), notice = f.controller.getState().notice;
  assert.equal(before.unknown, true); assert.equal(before.dirty, true);
  f.catalog([project(10), project(11), project(12)]); f.visibility(false); f.visibility(true); await tick();
  assert.equal(f.controller.getState().projects.length, 3);
  assert.deepEqual(f.controller.readCloseSnapshot(), before); assert.equal(f.controller.getState().notice, notice);
  assert.equal(f.controller.getState().createdProjectId, null); assert.equal(f.controller.canMutate(), false);
  assert.equal(await f.controller.create('Project 12', ''), false); assert.equal(await f.controller.open(uuid(12)), false);
  assert.equal(f.calls.filter(op => op === 'project.create').length, 1); assert.deepEqual((f.opens as unknown), []); f.dispose();
});

test('failed return refresh retains the old catalog and dirty input and can recover on the next return', async () => {
  let reads = 0;
  const f = fixture({ list: () => ++reads === 2 ? Promise.reject(new Error('offline')) : [project(10)] }); await tick();
  f.controller.reportCreate({ dirty: true, busy: false, version: 1 });
  f.visibility(false); f.visibility(true); await tick();
  assert.equal(f.controller.getState().projects[0].id, uuid(10)); assert.notEqual(f.controller.getState().listError, '');
  assert.equal(f.controller.readCloseSnapshot().dirty, true);
  f.visibility(false); f.visibility(true); await tick(); assert.equal(f.controller.getState().listError, '');
  assert.deepEqual((f.opens as unknown), []); f.dispose();
});

test('return refresh does not acknowledge an unknown open or consume its sealed permit again', async () => {
  const f = fixture({ open: () => Promise.reject(new Error('lost open ACK')) }); await tick();
  f.controller.reportCreate({ dirty: true, busy: false, version: 1 });
  assert.equal(await f.controller.open(uuid(10)), false);
  const before = f.controller.readCloseSnapshot();
  assert.equal(f.controller.getState().openUnknown, true); assert.equal(f.controller.getState().sealed, true);
  f.catalog([project(10), project(12)]); f.visibility(false); f.visibility(true); await tick();
  assert.deepEqual(f.controller.getState().projects.map((row: { id: unknown; }) => row.id), [uuid(10), uuid(12)]);
  assert.deepEqual(f.controller.readCloseSnapshot(), before);
  assert.equal(f.controller.getState().openUnknown, true); assert.equal(f.controller.getState().sealed, true);
  assert.equal(f.controller.consume(f.opens[0].entryToken, uuid(10)).accepted, false);
  assert.equal(f.opens.length, 1); f.dispose();
});

test('entering quit invalidates a pending catalog read even after quit cancellation and suppresses new reads', async () => {
  for (const cancel of [false, true]) {
    const older = Promise.withResolvers(); let reads = 0;
    const f = fixture({ list: () => ++reads === 1 ? [project(10)] : reads === 2 ? older.promise : [project(12)] }); await tick();
    const pending = f.controller.refresh(); await tick();
    f.receive({ quitting: true });
    f.visibility(false); f.visibility(true); await tick(); assert.equal(reads, 2, 'Quitting must not start another read');
    if (cancel) f.receive({ quitting: false });
    older.resolve([project(11)]); await pending;
    assert.deepEqual(f.controller.getState().projects.map((row: { id: unknown; }) => row.id), [uuid(10)], 'Pre-quit response no longer owns the catalog');
    assert.equal(f.controller.getState().listBusy, false);
    if (cancel) { f.visibility(false); f.visibility(true); await tick(); assert.deepEqual(f.controller.getState().projects.map((row: { id: unknown; }) => row.id), [uuid(12)]); }
    assert.deepEqual((f.opens as unknown), []); f.dispose();
  }
});

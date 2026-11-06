import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {startServer} from '../apps/server/src/index.ts';
import {createServerProject} from './helpers/project-database.ts';
import {createProjectEntryControlBroker, createProjectEntryControlClient} from '../apps/desktop/src/project-entry-control.ts';
import {createProjectEntryDesktopHost} from '../apps/desktop/src/project-entry-desktop-host.ts';
import {createProjectEntriesDesktopBridge} from '../apps/desktop/src/project-entry-desktop-preload.ts';
import {PROJECT_ENTRY_DESKTOP_LIMITS} from '../packages/contracts/src/project-entry-desktop.ts';
import {readProjectEntryDesktopClient} from '../apps/web/src/project-entry-desktop-client.ts';
import {createNativeProjectDesktopController} from '../apps/web/src/native-project-desktop-state.ts';
import {createProjectEntryController} from '../apps/web/src/project-entry-state.ts';
import {createProjectEntryIdentityOwner, readProjectEntryIdentity} from '../apps/web/src/project-entry-identity.ts';
import {createLauncherClient} from '../apps/web/src/launcher-state.ts';
import type {ProjectWindowBridge, ProjectWindowContext} from '../apps/web/src/desktop-window-client.ts';
import type {ProjectEntryControlPort} from '../packages/contracts/src/project-entry-native.ts';

const facts = {fileSystem: 'apfs', isLocal: true, volumeReadOnly: false, permissionBits: true, cloud: 'not-reported'} as const;
async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-main-refusal-')), selected = path.join(root, 'selected'); mkdirSync(selected);
  const initial = createServerProject(path.join(root, 'app'), {name: 'Original'}), projectId = initial.projectId, source = initial.store.projectFile; initial.store.close();
  const server = await startServer({dataDir: path.join(root, 'app'), port: 0, token: 'synthetic-main-refusal'});
  const writes: string[] = [], backendId = randomUUID(), contextId = randomUUID(), windowId = randomUUID(), window = {};
  let active = true, failAfterAdopt = false, openFile = source, openHostCalls = 0, releasePicker: (() => void) | null = null;
  let control!: ReturnType<typeof createProjectEntryControlClient>;
  const counted: ProjectEntryControlPort = {...server.projectEntries,
    create: input => {writes.push('createAtSelection'); return server.projectEntries.create(input);},
    duplicate: input => {writes.push('duplicate'); return server.projectEntries.duplicate!(input);},
    copyTo: input => {writes.push('copyTo'); return server.projectEntries.copyTo!(input);},
    instantiateTemplate: input => {writes.push('instantiateTemplate'); return server.projectEntries.instantiateTemplate!(input);},
    adoptCopy: async input => {writes.push('adoptCopy'); const result = await server.projectEntries.adoptCopy!(input); if (failAfterAdopt) active = false; return result;},
  };
  const broker = createProjectEntryControlBroker({backendId, control: counted, send: value => queueMicrotask(() => control.handle(value))});
  control = createProjectEntryControlClient({backendId, send: value => queueMicrotask(() => broker.handle(value))});
  const host = createProjectEntryDesktopHost({ownerForEvent: () => ({window, windowId, backendId, contextId, isCurrent: () => active}), backend: control.api, isReady: () => true,
    chooseDirectory: async () => selected, chooseSaveFile: async () => path.join(selected, 'Copy.mioon'), chooseOpenFile: async () => {if (releasePicker) await new Promise<void>(resolve => {releasePicker = resolve;}); return openFile;},
    probeLocation: async () => facts, admitLocation: async () => true, adoptPrepared: async prepared => ({ok: true, reason: 'accepted', targetWindowId: prepared.windowId}),
    openRecent: async () => {openHostCalls++; return {ok: false, reason: 'unavailable', targetWindowId: null};},
  });
  const preload = createProjectEntriesDesktopBridge((_channel, input) => host.handle(null, input));
  const client = readProjectEntryDesktopClient({__mioonProjectEntries: preload}); assert.ok(client);
  const identity = createProjectEntryIdentityOwner({read: async () => server.projectEntries.listRecent()}); identity.activate(); await identity.discover();
  const desktop = createNativeProjectDesktopController({client, identity, beforeAction: async () => {await readProjectEntryIdentity(identity); return true;}, openCreated: async () => assert.fail('A refused write must not open'), message: () => ''}); desktop.activate(); await desktop.initialize(false);
  t.after(async () => {releasePicker?.(); desktop.dispose(); identity.dispose(); host.close(); control.close(); broker.close(); await server.close(); rmSync(root, {recursive: true, force: true});});
  const context: ProjectWindowContext = {version: 2, role: 'launcher', windowId, contextId, backendId, initialProjectId: null, autoOpen: false, editorProjectId: null, editorPhase: 'none', editorCount: 0, entryMode: null, entryVersion: 0, entryReceipt: null, settingsSlot: null, settingsVersion: 0, selectionProjectId: null, selectionVersion: 0, locatorStatus: null, locatorIntent: null, quitting: false};
  const entry = createProjectEntryController({context, bridge: {context: async () => context} as unknown as ProjectWindowBridge, identity, manageIdentityLifecycle: false, desktopClient: client,
    client: createLauncherClient(async () => assert.fail('No legacy mutation'), {parseCreateInput: value => value, readDirectory: () => readProjectEntryIdentity(identity)}), confirm: async () => true}); entry.activate(); await entry.boot(); t.after(() => entry.dispose());
  return {root, selected, source, projectId, writes, host, client, desktop, entry, get openHostCalls() {return openHostCalls;}, refuseOwner() {active = false;},
    holdPicker() {releasePicker = () => {};}, releasePicker() {releasePicker?.(); releasePicker = null;},
    selectedFile(value: string) {openFile = value;}, failAfterAdopt() {failAfterAdopt = true;}};
}

test('real main rejects expired or wrong-action tickets before every create/duplicate/copyTo/template backend write', async t => {
  for (const action of ['createAtSelection', 'duplicate', 'copyTo', 'instantiateTemplate'] as const) for (const invalid of ['expired', 'wrong-purpose'] as const) await t.test(`${action}/${invalid}`, async t => {
    const f = await fixture(t), selected = await f.client.chooseLocation({purpose: 'create', suggestedName: 'New', message: ''}); assert.ok(selected);
    const body = action === 'createAtSelection' ? {action, token: selected.token, name: 'New', createFolder: true}
      : action === 'duplicate' ? {action, token: selected.token, projectId: f.projectId, requestId: randomUUID()}
        : action === 'copyTo' ? {action, token: selected.token, sourceToken: randomUUID(), requestId: randomUUID()}
          : {action, token: selected.token, templateId: 'timeline-basics', templateVersion: 1, name: 'New', requestId: randomUUID()};
    if (invalid === 'wrong-purpose' && action === 'createAtSelection') {
      const wrong = await f.client.chooseLocation({purpose: 'duplicate', suggestedName: 'New', message: ''}); assert.ok(wrong); body.token = wrong.token;
    }
    if (invalid === 'expired') {const now = Date.now(); t.mock.method(Date, 'now', () => now + PROJECT_ENTRY_DESKTOP_LIMITS.ticketMs + 1);}
    try {await assert.rejects(f.host.dispatch(null, body), {code: 'PROJECT_ENTRY_UNAVAILABLE', status: 409});} finally {t.mock.restoreAll();}
    assert.deepEqual(f.writes, []); assert.deepEqual(readdirSync(f.selected), []); assert.equal(f.openHostCalls, 0);
  });
});
test('an actual expired create ticket becomes a reselectable error without losing input or replaying a cached rejected request', async t => {
  const f = await fixture(t); f.desktop.showCreate(); f.desktop.change({name: 'Keep name', description: 'Keep description'}); await f.desktop.chooseLocation();
  const now = Date.now(); t.mock.method(Date, 'now', () => now + PROJECT_ENTRY_DESKTOP_LIMITS.ticketMs + 1);
  try {assert.equal(await f.desktop.create(), false);} finally {t.mock.restoreAll();}
  assert.deepEqual(f.writes, []); assert.equal(f.desktop.readCloseSnapshot().unknown, false); assert.equal(f.desktop.getState().selection, null); assert.equal(f.desktop.getState().selectionInvalid, true);
  assert.equal(f.desktop.getState().values.name, 'Keep name'); assert.equal(f.desktop.getState().values.description, 'Keep description'); assert.equal(await f.desktop.recheck(), false);
  await f.desktop.chooseLocation(); assert.equal(f.desktop.getState().selectionInvalid, false); assert.ok(f.desktop.getState().selection); f.desktop.closeCreate(); assert.equal(f.desktop.getState().createOpen, false);
});
test('real main may return unavailable after adoptCopy committed, so renderer preserves the original unknown write', async t => {
  const f = await fixture(t), copy = path.join(f.root, 'Finder copy.mioon'); copyFileSync(f.source, copy); const original = readFileSync(f.source), copied = readFileSync(copy);
  f.selectedFile(copy); await f.desktop.openFile(); assert.equal(f.desktop.getState().failure?.issue.code, 'PROJECT_FILE_COPY'); f.failAfterAdopt();
  assert.equal(await f.desktop.adoptCopy(), false); assert.deepEqual(f.writes, ['adoptCopy']); assert.equal(f.desktop.getState().action.kind, 'unknown'); assert.equal(f.desktop.readCloseSnapshot().unknown, true);
  assert.deepEqual(readFileSync(f.source), original); assert.notDeepEqual(readFileSync(copy), copied, 'The selected copy was already adopted before main detected the lost owner');
  f.desktop.closeFailure(); assert.notEqual(f.desktop.getState().failure, null);
});
test('real main busy and owner refusals precede recent-open host admission and do not create an unknown renderer open', async t => {
  for (const reason of ['busy', 'owner'] as const) await t.test(reason, async t => {
    const f = await fixture(t); let held: Promise<unknown> | null = null;
    if (reason === 'busy') {f.holdPicker(); held = f.client.openSelectedFile(); await new Promise(setImmediate);} else f.refuseOwner();
    try {
      assert.equal(await f.entry.open(f.projectId), false); assert.equal(f.openHostCalls, 0); assert.equal(f.entry.getState().sealed, false); assert.equal(f.entry.getState().openUnknown, false); assert.equal(f.entry.readCloseSnapshot().unknown, false); assert.equal(f.entry.canMutate(), true);
    } finally {if (held) {f.releasePicker(); await held;}}
  });
});

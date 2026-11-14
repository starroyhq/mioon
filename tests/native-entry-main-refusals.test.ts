import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {startServer} from './helpers/test-server.ts';
import {createServerProject} from './helpers/project-database.ts';
import {createProjectEntryControlBroker, createProjectEntryControlClient} from '../apps/desktop/src/project-entry-control.ts';
import {createProjectEntryDesktopHost} from '../apps/desktop/src/project-entry-desktop-host.ts';
import {createProjectEntriesDesktopBridge} from '../apps/desktop/src/project-entry-desktop-preload.ts';
import {PROJECT_ENTRY_DESKTOP_LIMITS, PROJECT_ENTRY_DESKTOP_PENDING_OPEN_EVENT} from '../packages/contracts/src/project-entry-desktop.ts';
import type {ProjectLocationFacts} from '../packages/contracts/src/project-entry-desktop.ts';
import {projectEntryControlErrorSchema} from '../packages/contracts/src/project-entry-control.ts';
import {readProjectEntryDesktopClient} from '../apps/web/src/project-entry-desktop-client.ts';
import {createNativeProjectDesktopController} from '../apps/web/src/native-project-desktop-state.ts';
import {createProjectEntryController} from '../apps/web/src/project-entry-state.ts';
import {createProjectEntryIdentityOwner, readProjectEntryIdentity} from '../apps/web/src/project-entry-identity.ts';
import {createLauncherClient} from '../apps/web/src/launcher-state.ts';
import type {ProjectWindowBridge, ProjectWindowContext} from '../apps/web/src/desktop-window-client.ts';
import type {ProjectEntryControlPort} from '../packages/contracts/src/project-entry-native.ts';

const facts = {fileSystem: 'apfs', isLocal: true, volumeReadOnly: false, permissionBits: true, cloud: 'not-reported'} as const;
async function fixture(t: TestContext, {initialize = true} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-main-refusal-')), selected = path.join(root, 'selected'); mkdirSync(selected);
  const initial = createServerProject(path.join(root, 'app'), {name: 'Original'}), projectId = initial.projectId, source = initial.store.projectFile; initial.store.close();
  const server = await startServer({dataDir: path.join(root, 'app'), port: 0, token: 'synthetic-main-refusal'});
  const writes: string[] = [], backendId = randomUUID(), windowId = randomUUID(), window = {};
  let contextId = randomUUID();
  let active = true, visible = true, failAfterAdopt = false, openFile = source, openHostCalls = 0, releasePicker: (() => void) | null = null;
  let locationFacts: ProjectLocationFacts = facts, admission: Promise<void> | null = null, admissionEntered: (() => void) | null = null;
  let pendingDelivery: Promise<void> | null = null, pendingDeliveryEntered: (() => void) | null = null;
  let releaseAdmission: (() => void) | null = null, releaseDelivery: (() => void) | null = null;
  let admissionCalls = 0;
  const owner = () => {const captured = contextId; return {window, windowId, backendId, contextId: captured, isCurrent: () => active && captured === contextId};};
  const listeners = new Set<(event: unknown, value: unknown) => void>(), notifications: unknown[] = [], entryRequests: string[] = [], entryErrors: string[] = [];
  const notify = (value: unknown) => {for (const listener of [...listeners]) queueMicrotask(() => listener({}, value));};
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
  const host = createProjectEntryDesktopHost({ownerForEvent: owner, backend: control.api, isReady: () => true,
    chooseDirectory: async () => selected, chooseSaveFile: async () => path.join(selected, 'Copy.mioon'), chooseOpenFile: async () => {if (releasePicker) await new Promise<void>(resolve => {releasePicker = resolve;}); return openFile;},
    probeLocation: async input => input.purpose === 'open' ? locationFacts : facts, admitLocation: async () => {admissionCalls++; admissionEntered?.(); await admission; return true;}, adoptPrepared: async prepared => ({ok: true, reason: 'accepted', targetWindowId: prepared.windowId}),
    openRecent: async () => {openHostCalls++; return {ok: false, reason: 'unavailable', targetWindowId: null};},
    notifyPendingOpen: (_owner, notice) => {notifications.push(notice); notify(notice);},
  });
  const preload = createProjectEntriesDesktopBridge(async (_channel, input) => {
    assert.ok(input !== null && typeof input === 'object' && 'action' in input && typeof input.action === 'string'); entryRequests.push(input.action);
    const reply = await host.handle(null, input);
    assert.ok(reply !== null && typeof reply === 'object' && 'ok' in reply);
    if (reply.ok === false) {assert.ok('error' in reply); entryErrors.push(projectEntryControlErrorSchema.parse(reply.error).code);}
    if (input.action === 'takePendingOpen' && reply.ok === true && 'data' in reply && reply.data !== null && pendingDelivery) {pendingDeliveryEntered?.(); await pendingDelivery;}
    return reply;
  }, {on: (channel, listener) => {assert.equal(channel, PROJECT_ENTRY_DESKTOP_PENDING_OPEN_EVENT); listeners.add(listener);},
    removeListener: (channel, listener) => {assert.equal(channel, PROJECT_ENTRY_DESKTOP_PENDING_OPEN_EVENT); listeners.delete(listener);},
    context: async () => ({backendId, windowId, contextId}),
  });
  const client = readProjectEntryDesktopClient({__mioonProjectEntries: preload}); assert.ok(client);
  const identity = createProjectEntryIdentityOwner({read: async () => server.projectEntries.listRecent()}); identity.activate(); await identity.discover();
  const desktop = createNativeProjectDesktopController({client, identity, beforeAction: async () => {await readProjectEntryIdentity(identity); return true;}, openCreated: async () => assert.fail('A refused write must not open'), message: () => '', canStart: () => visible}); desktop.activate(); if (initialize) await desktop.initialize(false);
  t.after(async () => {releasePicker?.(); releaseAdmission?.(); releaseDelivery?.(); desktop.dispose(); identity.dispose(); host.close(); control.close(); broker.close(); await server.close(); rmSync(root, {recursive: true, force: true});});
  const context: ProjectWindowContext = {version: 2, role: 'launcher', windowId, contextId, backendId, initialProjectId: null, autoOpen: false, editorProjectId: null, editorPhase: 'none', editorCount: 0, entryMode: null, entryVersion: 0, entryReceipt: null, settingsSlot: null, settingsVersion: 0, selectionProjectId: null, selectionVersion: 0, locatorStatus: null, locatorIntent: null, quitting: false};
  const entry = createProjectEntryController({context, bridge: {context: async () => context} as unknown as ProjectWindowBridge, identity, manageIdentityLifecycle: false, desktopClient: client,
    client: createLauncherClient(async () => assert.fail('No legacy mutation'), {parseCreateInput: value => value, readDirectory: () => readProjectEntryIdentity(identity)}), confirm: async () => true}); entry.activate(); await entry.boot(); t.after(() => entry.dispose());
  return {root, selected, source, projectId, writes, host, client, desktop, entry, owner, notifications, entryRequests, entryErrors,
    get openHostCalls() {return openHostCalls;}, get admissionCalls() {return admissionCalls;}, refuseOwner() {active = false;}, replaceDocument() {contextId = randomUUID();},
    visible(value: boolean) {visible = value;},
    setFacts(value: ProjectLocationFacts) {locationFacts = value;},
    holdAdmission() {const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); admission = held.promise; admissionEntered = () => entered.resolve(); releaseAdmission = () => {admission = null; admissionEntered = null; held.resolve();}; return {entered: entered.promise, release: releaseAdmission};},
    holdPendingDelivery() {const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); pendingDelivery = held.promise; pendingDeliveryEntered = () => entered.resolve(); releaseDelivery = () => {pendingDelivery = null; pendingDeliveryEntered = null; held.resolve();}; return {entered: entered.promise, release: releaseDelivery};},
    holdPicker() {releasePicker = () => {};}, releasePicker() {releasePicker?.(); releasePicker = null;},
    selectedFile(value: string) {openFile = value;}, failAfterAdopt() {failAfterAdopt = true;}};
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function withinOneSecond(promise: Promise<void>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {await Promise.race([promise, new Promise<never>((_resolve, reject) => {timer = setTimeout(() => reject(new Error(label)), 1000);})]);}
  finally {clearTimeout(timer);}
}
async function observedSource(f: Fixture, kind: 'copy' | 'read-only' | 'network') {
  const file = kind === 'copy' ? path.join(f.root, 'Finder Copy.mioon') : f.source;
  if (kind === 'copy') copyFileSync(f.source, file);
  f.setFacts({...facts, ...(kind === 'read-only' ? {volumeReadOnly: true} : kind === 'network' ? {isLocal: false} : {})});
  const result = await f.host.openPath(f.owner(), file);
  assert.equal(result.status, kind === 'copy' ? 'copy' : 'copy-source');
  if (result.status !== 'copy' && result.status !== 'copy-source') assert.fail('The real host must observe a pending copy source');
  return {file, result};
}
function pendingShown(f: Fixture, token: string, started = performance.now()): Promise<number> {
  return new Promise((resolve, reject) => {
    let release = () => {};
    const timeout = setTimeout(() => {release(); reject(new Error('Pending system-open result was not presented within one second'));}, 1000);
    const check = () => {
      const state = f.desktop.getState();
      if (state.failure?.token !== token || state.busy) return;
      const elapsed = performance.now() - started;
      clearTimeout(timeout); release();
      if (elapsed >= 1000) reject(new Error(`Pending system-open result took ${elapsed}ms`)); else resolve(elapsed);
    };
    release = f.desktop.subscribe(check); check();
  });
}

for (const kind of ['copy', 'read-only', 'network'] as const) test(`Q02 real host event presents a ${kind} result after the initial null exactly once`, async t => {
  const f = await fixture(t), {result} = await observedSource(f, kind), beforeTakes = f.entryRequests.filter(value => value === 'takePendingOpen').length;
  assert.equal(beforeTakes, 1); assert.equal(f.desktop.getState().failure, null);
  const presentations = new Set<object>(), release = f.desktop.subscribe(() => {const failure = f.desktop.getState().failure; if (failure?.token === result.token) presentations.add(failure);});
  const shown = pendingShown(f, result.token); f.host.rememberPendingOpen(f.owner(), result); t.diagnostic(`Pending ${kind} presented in ${(await shown).toFixed(2)}ms`); await new Promise(setImmediate); release();
  assert.equal(f.notifications.length, 1); assert.equal(presentations.size, 1);
  assert.equal(f.entryRequests.filter(value => value === 'takePendingOpen').length, beforeTakes + 1);
  assert.equal(await f.client.takePendingOpen(), null, 'The host must consume the real result once');
  assert.deepEqual(f.writes, []); assert.equal(f.desktop.readCloseSnapshot().unknown, false);
  f.desktop.closeFailure(); assert.equal(f.desktop.getState().failure, null);
});
test('Q02 cold pending copy is available before renderer initialization without a second presentation', async t => {
  const f = await fixture(t, {initialize: false}), {result} = await observedSource(f, 'copy'), started = performance.now();
  f.host.rememberPendingOpen(f.owner(), result); await f.desktop.initialize(false); t.diagnostic(`Cold pending copy presented in ${(await pendingShown(f, result.token, started)).toFixed(2)}ms`);
  const failure = f.desktop.getState().failure; assert.equal(f.entryRequests.filter(value => value === 'takePendingOpen').length, 1);
  await f.desktop.initialize(false); assert.equal(f.desktop.getState().failure, failure);
  assert.equal(f.entryRequests.filter(value => value === 'takePendingOpen').length, 1); assert.equal(await f.client.takePendingOpen(), null); assert.deepEqual(f.writes, []);
});
test('Q02 a location warning delayed past the initial null notifies the real renderer when released', async t => {
  const f = await fixture(t), copy = path.join(f.root, 'Risky Finder Copy.mioon'); copyFileSync(f.source, copy);
  f.setFacts({...facts, fileSystem: 'exfat', permissionBits: false});
  const warning = f.holdAdmission(), opening = f.host.openPath(f.owner(), copy);
  await withinOneSecond(warning.entered, 'The real host must reach location admission'); assert.equal(f.desktop.getState().failure, null); assert.equal(f.notifications.length, 0);
  assert.equal(f.entryRequests.filter(value => value === 'takePendingOpen').length, 1, 'The launcher has already consumed its initial null');
  warning.release(); const result = await opening;
  if (result.status !== 'copy') assert.fail('The real backend must identify the selected duplicate');
  const shown = pendingShown(f, result.token); f.host.rememberPendingOpen(f.owner(), result); t.diagnostic(`Delayed pending copy presented in ${(await shown).toFixed(2)}ms`);
  assert.equal(f.admissionCalls, 1); assert.equal(f.entryRequests.filter(value => value === 'takePendingOpen').length, 2); assert.equal(await f.client.takePendingOpen(), null); assert.deepEqual(f.writes, []);
});
for (const stale of ['expired', 'document'] as const) test(`Q02 ${stale} pending copy cannot appear in the real renderer or authorize a write`, async t => {
  const f = await fixture(t, {initialize: false}), {file, result} = await observedSource(f, 'copy'), sourceBefore = readFileSync(f.source), copyBefore = readFileSync(file);
  f.host.rememberPendingOpen(f.owner(), result);
  if (stale === 'expired') {const now = Date.now(); t.mock.method(Date, 'now', () => now + PROJECT_ENTRY_DESKTOP_LIMITS.ticketMs + 1);} else f.replaceDocument();
  try {
    await f.desktop.initialize(false); await new Promise(setImmediate);
    assert.equal(f.desktop.getState().failure, null); assert.equal(await f.client.takePendingOpen(), null);
    await assert.rejects(f.client.adoptCopy({token: result.token}), {code: 'PROJECT_ENTRY_TICKET_EXPIRED', status: 409});
  } finally {t.mock.restoreAll();}
  assert.deepEqual(f.writes, []); assert.deepEqual(readFileSync(f.source), sourceBefore); assert.deepEqual(readFileSync(file), copyBefore);
});
for (const expired of [false, true]) test(`Q02 a real pending result taken before hiding is ${expired ? 'discarded after expiry' : 'presented once while live'} on reveal`, async t => {
  const f = await fixture(t), {result} = await observedSource(f, 'copy'), delivery = f.holdPendingDelivery();
  f.host.rememberPendingOpen(f.owner(), result); await withinOneSecond(delivery.entered, 'A pending-open notification must reach a real take within one second'); f.visible(false); delivery.release(); await new Promise(setImmediate);
  assert.equal(f.desktop.getState().failure, null, 'A completed native read must not publish into a hidden presentation');
  if (expired) {assert.ok(result.expiresAt); t.mock.method(Date, 'now', () => result.expiresAt! + 1);}
  try {
    f.visible(true);
    const shown = expired ? null : pendingShown(f, result.token);
    await f.desktop.resumeKnownOpen(false); if (shown) await shown;
    await new Promise(setImmediate);
    assert.equal(f.desktop.getState().failure?.token ?? null, expired ? null : result.token);
    assert.equal(await f.client.takePendingOpen(), null, 'The buffered result has already been taken from the real host');
  } finally {t.mock.restoreAll();}
  assert.equal(f.desktop.readCloseSnapshot().unknown, false); assert.deepEqual(f.writes, []);
});
for (const kind of ['copy', 'read-only'] as const) test(`Q02 expired ${kind} confirmation is a closable error before any real backend mutation`, async t => {
  const f = await fixture(t), file = kind === 'copy' ? path.join(f.root, 'Expired Finder Copy.mioon') : f.source;
  if (kind === 'copy') copyFileSync(f.source, file); else f.setFacts({...facts, volumeReadOnly: true});
  const sourceBefore = readFileSync(f.source), selectedBefore = readFileSync(file); f.selectedFile(file); await f.desktop.openFile(); assert.ok(f.desktop.getState().failure?.token);
  const now = Date.now(); t.mock.method(Date, 'now', () => now + PROJECT_ENTRY_DESKTOP_LIMITS.ticketMs + 1);
  try {assert.equal(await (kind === 'copy' ? f.desktop.adoptCopy() : f.desktop.copyTo()), false);} finally {t.mock.restoreAll();}
  assert.equal(f.entryErrors.at(-1), 'PROJECT_ENTRY_TICKET_EXPIRED'); assert.deepEqual(f.writes, []); assert.deepEqual(readdirSync(f.selected), []);
  assert.equal(f.desktop.getState().action.kind, 'error'); assert.equal(f.desktop.readCloseSnapshot().unknown, false);
  f.desktop.closeFailure(); assert.equal(f.desktop.getState().failure, null); assert.equal(await f.desktop.recheck(), false);
  assert.deepEqual(f.writes, []); assert.deepEqual(readFileSync(f.source), sourceBefore); assert.deepEqual(readFileSync(file), selectedBefore);
});

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
    try {await assert.rejects(f.host.dispatch(null, body), {code: invalid === 'expired' ? 'PROJECT_ENTRY_TICKET_EXPIRED' : 'PROJECT_ENTRY_UNAVAILABLE', status: 409});} finally {t.mock.restoreAll();}
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

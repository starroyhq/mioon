import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {createProjectMediaCloseReader} from '../apps/web/src/project-media-native-close.ts';
import {combineNativeEntryClose} from '../apps/web/src/native-entry-close.ts';
import {createNativeCloseRegistry, installNativeCloseAdmission} from '../apps/web/src/native-close-state.ts';
import type {NativeCloseAdmission} from '../apps/web/src/native-close-state.ts';
import {createSettingsNavigationRegistry} from '../apps/web/src/settings-navigation-state.ts';
import {readNativeLegacyClose} from '../apps/web/src/native-close-legacy.ts';
import {createProjectMediaController, sameMediaOwner} from '../apps/web/src/project-media-state.ts';
import {createProjectMediaClient} from '../apps/web/src/project-media-client.ts';
import type {ProjectMediaClient} from '../apps/web/src/project-media-client.ts';
import {projectEntryFixture, projectEntryOwnerFixture} from './helpers/project-entry-fixture.ts';

test('actual App native admission reads media work and uncertain outcomes before a React render', () => {
  let media = {applyAction: {kind: 'idle'}, nativeOutcomeUnknown: false};
  const readMediaClose = createProjectMediaCloseReader(() => media);
  const events = new Map<string, (event: {preventDefault(): void; returnValue: unknown}) => void>();
  const win = {location: {href: 'http://127.0.0.1:8123/?project=synthetic'},
    addEventListener: (key: string, callback: (event: {preventDefault(): void; returnValue: unknown}) => void) => events.set(key, callback),
    removeEventListener: (key: string) => events.delete(key)} as {
      location: {href: string}; addEventListener: (key: string, callback: (event: {preventDefault(): void; returnValue: unknown}) => void) => unknown;
      removeEventListener: (key: string) => unknown; __mioonNativeCloseAdmission: NativeCloseAdmission;
    };
  const clean = () => ({dirty: false, busy: false, unknown: false, identity: ['synthetic-editor']});
  let cleanup: (() => void) | undefined;
  const env = {window: win, nativeWindow: {}, nativeSettingsScope: null, readEditorWindowInputs: clean,
    projectMediaRef: {current: {controller: {pauseObservation() {}}}},
    nativeProjectEntry: {readCloseSnapshot: clean}, readMediaClose, combineNativeEntryClose, installNativeCloseAdmission,
    nativeCloseRegistry: {current: createNativeCloseRegistry()}, settingsNavigation: {current: createSettingsNavigationRegistry()},
    readNativeLegacyClose, dirtyRef: {current: false}, shotTextRef: {current: null}, shotCloseRef: {current: null},
    clipDraftRef: {current: null}, timelineFormatRef: {current: null}, deliveryNameRef: {current: null},
    subtitlesRef: {current: null}, subjectsRef: {current: null}, importSession: {current: {active: true}},
    currentProject: {current: 'synthetic'}, projectEpoch: {current: 1}, navigationEpoch: {current: 1}, editorSession: {current: 'synthetic-session'},
    useEffect: (effect: () => () => void) => {cleanup = effect();}};
  const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const start = app.indexOf('  useEffect(() => installNativeCloseAdmission('), end = app.indexOf('  useEffect(() => { if (showProjects)', start);
  assert.ok(start >= 0 && end > start);
  Function(...Object.keys(env), transformSync(app.slice(start, end), {loader: 'tsx', format: 'cjs'}).code)(...Object.values(env));
  const unload = () => {let blocked = false; events.get('beforeunload')!({preventDefault: () => {blocked = true;}, returnValue: undefined}); return blocked;};
  try {
    assert.equal(unload(), false);
    media = {applyAction: {kind: 'working'}, nativeOutcomeUnknown: false};
    assert.equal(unload(), true, 'Synchronous controller state fences a close before rendering busy UI');
    media = {applyAction: {kind: 'idle'}, nativeOutcomeUnknown: true};
    const held = win.__mioonNativeCloseAdmission.inspect();
    assert.equal(held.disposition, 'unknown'); assert.equal(unload(), true);
    assert.equal(win.__mioonNativeCloseAdmission.commit(held.token, {discardDirty: false, allowUnknown: true, allowDrainFailure: false, expiresAt: Date.now() + 1000}), true);
    media = {applyAction: {kind: 'working'}, nativeOutcomeUnknown: true};
    assert.equal(unload(), true, 'An explicit retry revokes even an earlier acknowledged-unknown close ticket');
    media = {applyAction: {kind: 'idle'}, nativeOutcomeUnknown: false};
    assert.equal(unload(), false, 'Only a settled outcome restores clean close admission');
  } finally {cleanup?.();}
});

const mediaId = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const mediaProjectId = mediaId(900), mediaHash = 'a'.repeat(64);
const mediaOwner = {appLibraryScope: mediaHash, instanceId: mediaId(901), projectId: mediaProjectId, epoch: 1, session: 'editor-session'};
const mediaAsset = {id: mediaId(1), projectId: mediaProjectId, name: 'one.png', mimeType: 'image/png', referenceRevision: 1};
const mediaStatus = {assetId: mediaId(1), referenceRevision: 1, fingerprintToken: mediaHash, status: 'online' as const, reason: 'same-stats' as const, outside: false, readable: true};
const mediaLocation = {assetId: mediaId(1), displayPath: '/project/one.png', pathForm: 'relative' as const, volume: null, outside: false};
const mediaRules = {projectId: mediaProjectId, file: 'AGENTS.md' as const, exists: false, text: '', hash: null, trust: 'trusted' as const, maxBytes: 8192 as const, readError: null, pendingWrites: false};
const mediaTurn = () => new Promise<void>(resolve => setImmediate(resolve));

/** Keep the real App focus callback, close-admission wiring, strict directory
 * identity and media controller. Only read/mutation responses are controlled. */
async function mediaAdmissionFixture() {
  const directorySnapshot = projectEntryFixture([{id: mediaProjectId}], mediaOwner);
  let directoryRead: () => unknown | Promise<unknown> = () => directorySnapshot;
  const identity = projectEntryOwnerFixture(() => directoryRead());
  await identity.discover();
  let currentOwner = mediaOwner;
  let statusRead: ProjectMediaClient['status'] = async () => ({items: [mediaStatus], nextCursor: null});
  let locationRead: ProjectMediaClient['locations'] = async () => ({assets: [mediaLocation], locations: [], nextCursor: null});
  let rulesRead: ProjectMediaClient['rules'] = async () => mediaRules;
  let applyWrite: ProjectMediaClient['apply'] = async () => {throw Error('Unexpected media write');};
  const changes: unknown[] = [], calls: string[] = [];
  const controller = createProjectMediaController({
    client: {...createProjectMediaClient(),
      status: (...args) => {calls.push('status'); return statusRead(...args);},
      locations: (...args) => {calls.push('locations'); return locationRead(...args);},
      rules: (...args) => {calls.push('rules'); return rulesRead(...args);},
      apply: (...args) => {calls.push('apply'); return applyWrite(...args);}},
    readOwner: () => currentOwner, readAssets: () => [mediaAsset], onChange: state => changes.push(state),
    choosePreview: async () => ({preview: {previewToken: mediaId(800), chosen: {assetId: mediaId(1), matches: true}, found: [], mismatched: [], unverified: []}, displayPaths: [{assetId: mediaId(1), displayPath: '/chosen/one.png'}]}),
  });
  controller.activate(); controller.update(currentOwner); await controller.refresh();
  const readMediaClose = createProjectMediaCloseReader(() => controller.getState());
  const win = {location: {href: `http://127.0.0.1:8123/?project=${mediaProjectId}`},
    addEventListener() {}, removeEventListener() {}, __mioonNativeCloseAdmission: null as NativeCloseAdmission | null};
  const clean = () => ({dirty: false, busy: false, unknown: false, identity: ['synthetic-editor']});
  let cleanup: (() => void) | undefined;
  const env = {window: win, nativeWindow: {}, nativeSettingsScope: null,
    projectMediaRef: {current: {controller}}, projectMedia: {controller}, identity, sameMediaOwner,
    readProjectMediaOwner: () => currentOwner, readEditorWindowInputs: clean,
    nativeProjectEntry: {readCloseSnapshot: clean}, readMediaClose, combineNativeEntryClose, installNativeCloseAdmission,
    nativeCloseRegistry: {current: createNativeCloseRegistry()}, settingsNavigation: {current: createSettingsNavigationRegistry()},
    readNativeLegacyClose, dirtyRef: {current: false}, shotTextRef: {current: null}, shotCloseRef: {current: null},
    clipDraftRef: {current: null}, timelineFormatRef: {current: null}, deliveryNameRef: {current: null},
    subtitlesRef: {current: null}, subjectsRef: {current: null}, importSession: {current: {active: true}},
    currentProject: {current: mediaProjectId}, projectEpoch: {current: 1}, navigationEpoch: {current: 1}, editorSession: {current: 'editor-session'},
    useEffect: (effect: () => () => void) => {cleanup = effect();}};
  const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const start = app.indexOf('  useEffect(() => installNativeCloseAdmission('), end = app.indexOf('  useEffect(() => { if (showProjects)', start);
  assert.ok(start >= 0 && end > start);
  Function(...Object.keys(env), transformSync(app.slice(start, end), {loader: 'tsx', format: 'cjs'}).code)(...Object.values(env));
  const focusStart = app.indexOf('    const recheck = () => {'), focusEnd = app.indexOf("    window.addEventListener('focus', recheck);", focusStart);
  assert.ok(focusStart >= 0 && focusEnd > focusStart);
  const recheck = Function(...Object.keys(env), transformSync(app.slice(focusStart, focusEnd), {loader: 'tsx', format: 'cjs'}).code + ';return recheck;')(...Object.values(env)) as () => void;
  calls.length = 0; changes.length = 0;
  const admission = win.__mioonNativeCloseAdmission!;
  return {controller, admission, recheck, readMediaClose, calls, changes, directorySnapshot,
    readDirectory: (next: typeof directoryRead) => {directoryRead = next;},
    readStatus: (next: typeof statusRead) => {statusRead = next;},
    readLocations: (next: typeof locationRead) => {locationRead = next;},
    readRules: (next: typeof rulesRead) => {rulesRead = next;},
    writeApply: (next: typeof applyWrite) => {applyWrite = next;},
    replaceOwner: () => {currentOwner = {...currentOwner, epoch: currentOwner.epoch + 1}; controller.update(currentOwner);},
    dispose: () => {cleanup?.(); controller.dispose(); identity.dispose();},
  };
}
const mediaCloseChoice = () => ({discardDirty: false, allowDrainFailure: false, expiresAt: Date.now() + 1000});

test('App focus directory reply cannot start media observations after native close inspection', async () => {
  const h = await mediaAdmissionFixture(), held = Promise.withResolvers<unknown>();
  try {
    h.readDirectory(() => held.promise); h.recheck();
    const inspected = h.admission.inspect(), captured = h.readMediaClose(), count = h.changes.length;
    assert.equal(inspected.disposition, 'clean');
    held.resolve(h.directorySnapshot); await mediaTurn();
    assert.equal(h.calls.length, 0, 'The parent-focus read cannot start a new media observation during close');
    assert.equal(h.changes.length, count); assert.deepEqual(h.readMediaClose(), captured);
    assert.equal(h.admission.commit(inspected.token, mediaCloseChoice()), true);
    h.admission.cancel(inspected.token); await mediaTurn();
    h.recheck(); await mediaTurn();
    assert.ok(h.calls.includes('status')); assert.ok(h.calls.includes('locations')); assert.ok(h.calls.includes('rules'));
    assert.equal(h.controller.getState().status.kind, 'ready');
  } finally {h.dispose();}
});

test('App native close retires already flying media observations and resumes after cancellation', async () => {
  const h = await mediaAdmissionFixture();
  const status = Promise.withResolvers<Awaited<ReturnType<ProjectMediaClient['status']>>>();
  const locations = Promise.withResolvers<Awaited<ReturnType<ProjectMediaClient['locations']>>>();
  const rules = Promise.withResolvers<Awaited<ReturnType<ProjectMediaClient['rules']>>>();
  try {
    h.readStatus(() => status.promise); h.readLocations(() => locations.promise); h.readRules(() => rules.promise);
    h.recheck(); await mediaTurn(); assert.deepEqual(h.calls.sort(), ['locations', 'rules', 'status']);
    const inspected = h.admission.inspect(), captured = h.readMediaClose(), count = h.changes.length;
    assert.equal(inspected.disposition, 'clean');
    status.resolve({items: [mediaStatus], nextCursor: null}); locations.resolve({assets: [mediaLocation], locations: [], nextCursor: null}); rules.resolve(mediaRules);
    await mediaTurn();
    assert.equal(h.changes.length, count, 'Replies from observations retired by inspection cannot publish');
    assert.deepEqual(h.readMediaClose(), captured);
    assert.equal(h.admission.commit(inspected.token, mediaCloseChoice()), true);
    h.calls.length = 0; h.admission.cancel(inspected.token); await mediaTurn();
    assert.deepEqual(h.calls.sort(), ['locations', 'rules', 'status']);
    assert.equal(h.controller.getState().status.kind, 'ready'); assert.equal(h.controller.getState().locations.kind, 'ready');
  } finally {h.dispose();}
});

test('App native observation pause still rejects real media owner changes and a working apply', async () => {
  const h = await mediaAdmissionFixture();
  try {
    const inspected = h.admission.inspect(); h.replaceOwner();
    assert.equal(h.admission.commit(inspected.token, mediaCloseChoice()), false, 'A real owner change still invalidates the exact close snapshot');
    h.admission.cancel(inspected.token);
  } finally {h.dispose();}
  const working = await mediaAdmissionFixture(), held = Promise.withResolvers<Awaited<ReturnType<ProjectMediaClient['apply']>>>();
  try {
    await working.controller.choose(mediaId(1));
    const inspected = working.admission.inspect(); working.writeApply(() => held.promise);
    const applying = working.controller.apply(); await mediaTurn();
    assert.equal(working.controller.getState().applyAction.kind, 'working');
    assert.equal(working.admission.commit(inspected.token, mediaCloseChoice()), false, 'Pausing observations cannot pause or hide an actual apply');
    working.controller.dispose(); assert.equal(await applying, false);
  } finally {working.dispose();}
});

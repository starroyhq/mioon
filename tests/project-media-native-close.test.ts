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

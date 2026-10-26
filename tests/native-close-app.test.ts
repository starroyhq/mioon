import type {NativeCloseAdmission} from '../apps/web/src/native-close-state.ts';
interface FakeCloseController{getState():{dirty:boolean};getNativeCloseSnapshot():{dirty:boolean;identity:unknown[]}}
type FakeControllerRef={current:FakeCloseController|{controller:FakeCloseController}|null};
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readNativeLegacyClose } from '../apps/web/src/native-close-legacy.ts';
import { createNativeCloseRegistry, installNativeCloseAdmission } from '../apps/web/src/native-close-state.ts';
import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';

import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
const app = readFileSync(process.env.MIOON_NATIVE_CLOSE_APP_SOURCE || new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
function harness() {
  const events = new Map<string, (event: {preventDefault():void;returnValue:unknown})=>void>(), registry = createNativeCloseRegistry(), settings = createSettingsNavigationRegistry();
  const window = ({ location: { href: 'http://127.0.0.1:8123/?project=a' }, addEventListener: (name: string, callback: (event: {preventDefault():void;returnValue:unknown})=>void) => events.set(name, callback), removeEventListener: (name: string, callback: unknown) => { if (events.get(name) === callback) events.delete(name); } } as {location:{href:string};addEventListener(name:string,callback:(event:{preventDefault():void;returnValue:unknown})=>void):unknown;removeEventListener(name:string,callback:(event:{preventDefault():void;returnValue:unknown})=>void):void;__mioonNativeCloseAdmission: NativeCloseAdmission});
  const env = { nativeWindow: null, window, installNativeCloseAdmission, readNativeLegacyClose, subtitlesRef: { current: null }, subjectsRef: { current: null }, nativeCloseRegistry: { current: registry }, settingsNavigation: { current: settings },
    dirtyRef: { current: false }, shotTextRef: { current: null as FakeControllerRef['current'] }, shotCloseRef: { current: null }, clipDraftRef: { current: null as FakeControllerRef['current'] }, timelineFormatRef: { current: null as FakeControllerRef['current'] }, deliveryNameRef: { current: null as FakeControllerRef['current'] },
    agentDraft: { current: false }, imageDraft: { current: false }, importSession: { current: { active: true } },
    currentProject: { current: 'project-a' }, projectEpoch: { current: 1 }, navigationEpoch: { current: 1 }, workspaceRef: { current: { restored: false } }, workspaceOriginScope: () => 'normal',
  };
  const marker = app.includes('  useEffect(() => installNativeCloseAdmission(') ? '  useEffect(() => installNativeCloseAdmission(' : '  useEffect(() => { const warn = e =>';
  const first = app.indexOf(marker), end = app.indexOf("  useEffect(() => { if (showProjects)", first);
  assert.ok(first >= 0 && end > first, 'Require the actual single App close binding');
  let cleanup!: () => void;
  (env as typeof env & {useEffect: (callback: () => () => void) => void}).useEffect = (callback: () => () => void) => { cleanup = callback(); };
  Function('env', `with (env) { ${app.slice(first, end)} }`)(env);
  return { env, registry, settings, events, cleanup, window,
    unload() { let prevented = false; const event = { preventDefault() { prevented = true; }, returnValue: undefined }; events.get('beforeunload')!(event); return prevented; },
  };
}
const state = (version: number, patch = {}) => ({ dirty: false, busy: false, blocked: false, version, ...patch });
for (const slot of ['agent-chat', 'image-generation', 'agent-edits']) {
  test(`actual App close veto retains ${slot} unknown owner without depending on a React dirty effect`, () => {
    const f = harness(), owner = f.registry.register(slot); owner.update(state(1, { blocked: true }));
    assert.equal(f.unload(), true); owner.update(state(2)); assert.equal(f.unload(), false); f.cleanup!();
  });
}
for (const slot of ['home:agent', 'home:official', 'workbench:custom', 'workbench:comfy']) {
  test(`actual App close uses synchronous ${slot} configuration owner metadata`, () => {
    const f = harness(), owner = f.settings.register(slot); owner.update(state(1, { dirty: true }));
    assert.equal(f.unload(), true); owner.update(state(2, { busy: true })); assert.equal(f.unload(), true);
    owner.update(state(3, { blocked: true })); assert.equal(f.unload(), true);
    owner.update(state(4)); assert.equal(f.unload(), false); f.cleanup!();
  });
}
test('actual App preserves each existing synchronous draft predicate', () => {
  const f = harness();
  for (const key of ['shotTextRef', 'clipDraftRef', 'timelineFormatRef', 'deliveryNameRef']) {
    const controller = { getState: () => ({ dirty: true }), getNativeCloseSnapshot: () => ({ dirty: true, identity: [] }) };
    f.env[(key as 'shotTextRef'|'clipDraftRef'|'timelineFormatRef'|'deliveryNameRef')]!.current = key === 'shotTextRef' || key === 'clipDraftRef' ? controller : { controller };
    assert.equal(f.unload(), true, key); f.env[(key as 'shotTextRef'|'clipDraftRef'|'timelineFormatRef'|'deliveryNameRef')]!.current = null; assert.equal(f.unload(), false);
  }
  f.env.dirtyRef.current = true; assert.equal(f.unload(), true); f.cleanup!();
});
test('actual App project epoch and workspace replacement invalidate the exact native permission', () => {
  for (const change of [(f: { env: { projectEpoch: { current: number; }; }; }) => f.env.projectEpoch.current++, (f: { env: { currentProject: { current: string; }; }; }) => f.env.currentProject.current = 'project-b', (f: { env: { workspaceOriginScope: () => string; }; }) => f.env.workspaceOriginScope = () => 'restored:other']) {
    const f = harness(), source = f.registry.register('agent-chat'); source.update(state(1, { dirty: true }));
    const captured = f.window.__mioonNativeCloseAdmission.inspect();
    assert.equal(f.window.__mioonNativeCloseAdmission.commit(captured.token, { discardDirty: true, allowDrainFailure: false, expiresAt: Date.now() + 1000 }), true);
    change(f); assert.equal(f.unload(), true); f.cleanup!();
  }
});
test('actual App cleanup cannot delete a replacement document admission object', () => {
  const f = harness(), replacement = {} as NativeCloseAdmission; f.window.__mioonNativeCloseAdmission = replacement; f.cleanup!();
  assert.equal(f.window.__mioonNativeCloseAdmission, replacement); assert.equal(f.events.has('beforeunload'), false);
});

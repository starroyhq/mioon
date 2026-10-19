import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {observeInitialProjectLoad, createProjectRendererRecovery, createProjectBackendIncident} from '../apps/desktop/src/project-window-recovery.ts';
import {installNativeCloseAdmission} from '../apps/desktop/src/native-close.ts';
const defer = <T = unknown>(): {promise: Promise<T>; resolve: (value?: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void} => {
  let resolve!: (value?: T | PromiseLike<T>) => void; let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = (value?: T | PromiseLike<T>) => { yes(value as T); }; reject = no; });
  return {promise, resolve, reject};
};
interface FakeContents extends EventEmitter {url: string; mainFrame: Record<string, unknown>; loads: string[]; loadURL(url: string): Promise<void>; executeJavaScript(): Promise<never>}
interface FakeWindow extends EventEmitter {webContents: FakeContents; destroyed: boolean; isDestroyed(): boolean; close(): void}
function blank(): FakeWindow {
  const contents = Object.assign(new EventEmitter(), {url: 'about:blank', mainFrame: {}, getURL() { return (this as unknown as FakeContents).url; }, loads: [] as string[], async loadURL(url: string) { (this as unknown as FakeContents).loads.push(url); }, async executeJavaScript() { throw Error('Empty document must not execute renderer'); }}) as unknown as FakeContents;
  const window = Object.assign(new EventEmitter(), {webContents: contents, destroyed: false, isDestroyed() { return (this as unknown as FakeWindow).destroyed; }, close() {
    const event = {blocked: false, preventDefault() { (this as {blocked: boolean}).blocked = true; }}; (this as unknown as FakeWindow).emit('close', event);
    if (!event.blocked) { (this as unknown as FakeWindow).destroyed = true; (this as unknown as FakeWindow).emit('closed'); }
  }}) as unknown as FakeWindow;
  return window;
}
const url = 'http://127.0.0.1:49123/?project=11111111-1111-4111-8111-111111111111';
test('initial never-committed blank close consumes one native proof with zero renderer reads or writes', () => {
  const window = blank(); let current = true;
  const state = observeInitialProjectLoad(window as unknown as Parameters<typeof observeInitialProjectLoad>[0], url, () => current);
  installNativeCloseAdmission(window as unknown as Parameters<typeof installNativeCloseAdmission>[0], {isCurrent: () => false, consumeInitialEmptyClose: state.consumeClose,
    confirmDiscard: () => assert.fail('No draft existed'), confirmClose: () => assert.fail('No drain'), onBlocked() {}, onCancel() {}, requestQuit() { assert.fail('Not application quit'); }});
  const proof = state.captureFailure(); assert.ok(proof);
  assert.equal(proof!.close(), true); assert.equal(window.destroyed, true); assert.equal(proof!.close(), false);
  current = false; assert.equal(state.captureFailure(), null);
});
test('initial retry is fixed URL and cannot reuse a replaced frame, navigation, committed error page or backend owner', async () => {
  for (const invalidate of [(w: FakeWindow) => {w.webContents.mainFrame = {};}, (w: FakeWindow) => w.webContents.emit('did-start-navigation', {isMainFrame: true}),
    (w: FakeWindow) => w.webContents.emit('did-navigate'), (w: FakeWindow) => {w.webContents.url = 'chrome-error://chromewebdata/';}]) {
    const window = blank(), state = observeInitialProjectLoad(window as unknown as Parameters<typeof observeInitialProjectLoad>[0], url, () => true), proof = state.captureFailure();
    invalidate(window); assert.equal(await proof!.retry(), false); assert.equal(proof!.close(), false); assert.equal(window.destroyed, false); assert.deepEqual(window.webContents.loads, []);
  }
  const window = blank(); let current = true; const state = observeInitialProjectLoad(window as unknown as Parameters<typeof observeInitialProjectLoad>[0], url, () => current);
  const old = state.captureFailure(); current = false; assert.equal(await old!.retry(), false);
  current = true; const proof = state.captureFailure(); assert.equal(await proof!.retry(), true); assert.deepEqual(window.webContents.loads, [url]); assert.equal(await proof!.retry(), false);
  window.webContents.emit('did-navigate'); window.webContents.url = 'about:blank'; assert.equal(state.captureFailure(), null);
});
test('independent renderer incidents keep A pending recovery while B dialog is open', async () => {
  const a = {}, b = {}, context = {}, promptA = defer(), promptB = defer(), secondA = defer(), observedSecondA = defer();
  let aCaptures = 0, bCaptures = 0; const actions: unknown[] = [];
  const run = createProjectRendererRecovery({isCurrent: () => true,
    capture(window: unknown) { const w = window as FakeWindow; const serial = w === a ? ++aCaptures : ++bCaptures; return {claimPrompt: () => true,
      reload: async () => actions.push([w, 'reload']), exit: async () => actions.push([w, 'exit']), takePendingIncident: () => w === a && serial === 1}; },
    prompt(window: unknown) { const w = window as FakeWindow; if (w === b) return promptB.promise; if (aCaptures === 1) return promptA.promise; observedSecondA.resolve(undefined); return secondA.promise; }} as unknown as Parameters<typeof createProjectRendererRecovery>[0]);
  const aResult = run(a as unknown as FakeWindow, context), bResult = run(b as unknown as FakeWindow, context); promptA.resolve(2);
  await observedSecondA.promise; assert.equal(aCaptures, 2); assert.equal(bCaptures, 1);
  secondA.resolve(0); promptB.resolve(2); await Promise.all([aResult, bResult]); assert.deepEqual(actions, [[a, 'reload']]);
});
test('late recovery answer cannot act on replacement context and duplicate same-window prompt is suppressed', async () => {
  const window = {}, old = {}, replacement = {}, prompt = defer(); let context = old, captures = 0, actions = 0;
  const run = createProjectRendererRecovery({isCurrent: (_w: unknown, value: unknown) => value === context, capture() { captures++; return {claimPrompt: () => true, reload: async () => {actions++;}, exit: async () => {actions++;}, takePendingIncident: () => false}; }, prompt: () => prompt.promise} as unknown as Parameters<typeof createProjectRendererRecovery>[0]);
  const pending = run(window, old); await run(window, old); assert.equal(captures, 1);
  context = replacement; prompt.resolve(1); await pending; assert.equal(actions, 0);
});
test('backend failure blocks interaction irreversibly for that scope and grants only one prompt', () => {
  const old = createProjectBackendIncident(); assert.equal(old.failed, false); assert.doesNotThrow(() => old.assertAlive()); old.fail(); assert.equal(old.failed, true);
  assert.throws(() => old.assertAlive(), {code: 'BACKEND_START_EXITED', message: '本地服务在窗口准备完成前已停止'});
  assert.equal(old.claimPrompt(), true); assert.equal(old.claimPrompt(), false); assert.equal(old.failed, true);
  assert.equal(createProjectBackendIncident().failed, false);
});

test('actual main stop retains the old audition host until exact drain, and never clears a replacement', async () => {
  const {readFile} = await import('node:fs/promises'); const vm = await import('node:vm');
  const main = await readFile(new URL('../apps/desktop/src/main.ts', import.meta.url), 'utf8');
  const source = main.slice(main.indexOf('async function stop() {'), main.indexOf('\nasync function cleanupStoppedBackend()', main.indexOf('async function stop() {')));
  for (const replace of [false, true]) {
    const gate = defer(), calls: unknown[]=[]; const audio={shutdown: () => {calls.push('drain'); return gate.promise;}};
    const owner={audioHost:audio}, next={audioHost:{shutdown:async()=>assert.fail('Replacement never stopped')}};
    const context=vm.createContext({windowContext:owner,nativeAudioHost:audio,windowHost:{dispose:()=>calls.push('dispose')},
      startupOperation:{abort:async()=>calls.push('abort')},backend:{stop:async()=>calls.push('stop')},cleanupStoppedBackend:async()=>calls.push('cleanup')});
    vm.runInContext(source,context); const work=vm.runInContext('stop()',context);
    assert.deepEqual(calls,['drain']); assert.equal(context.windowContext,owner); assert.equal(context.nativeAudioHost,audio);
    if(replace){context.windowContext=next;context.nativeAudioHost=next.audioHost;}
    gate.resolve();
    if(replace){await assert.rejects(work,{code:'BACKEND_STOP_FAILED'});assert.equal(context.windowContext,next);assert.equal(context.nativeAudioHost,next.audioHost);assert.deepEqual(calls,['drain']);}
    else {await work; assert.deepEqual(calls,['drain','dispose','abort','stop','cleanup']);assert.equal(context.windowContext,null);assert.equal(context.nativeAudioHost,null);}
  }
});

test('initial blank close disposal never reacquires destroyed BrowserWindow contents', () => {
  const window = blank(), contents = window.webContents;
  Object.defineProperty(window, 'webContents', {get() {
    if (window.destroyed) throw new TypeError('Object has been destroyed');
    return contents;
  }});
  const state = observeInitialProjectLoad(window as unknown as Parameters<typeof observeInitialProjectLoad>[0], url, () => true);
  const admission = installNativeCloseAdmission(window as unknown as Parameters<typeof installNativeCloseAdmission>[0], {isCurrent: () => false, consumeInitialEmptyClose: state.consumeClose,
    confirmDiscard: () => assert.fail('Empty owner has no drafts'), confirmClose: () => assert.fail('No renderer drain'),
    onBlocked() {}, onCancel() {}, requestQuit() { assert.fail('Not application quit'); }});
  const proof = state.captureFailure(); assert.ok(proof);
  assert.doesNotThrow(() => assert.equal(proof!.close(), true));
  assert.equal(contents.listenerCount('did-start-navigation'), 1, 'Only native P0 remains before its own disposal');
  assert.doesNotThrow(() => state.dispose()); assert.equal(proof!.isCurrent(), false);
  assert.equal(state.captureFailure(), null); assert.doesNotThrow(() => admission.dispose());
  assert.equal(contents.listenerCount('did-start-navigation'), 0);
});

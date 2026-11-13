import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createProjectWindowBridge } from '../apps/desktop/src/project-window-preload.ts';
import { isProjectWindowContext, isProjectWindowRequest, isProjectWindowOpenResult, projectWindowOpenFailure, PROJECT_WINDOW_CHANNEL, PROJECT_WINDOW_EVENT } from '../apps/desktop/src/project-window-protocol.ts';
import { readDesktopWindowBridge } from '../apps/web/src/desktop-window-client.ts';
import { confirmOwnedWindowRestart } from '../apps/desktop/src/project-window-confirmation.ts';
const id = '11111111-1111-4111-8111-111111111111';
const context = { version:2, role:'launcher', windowId:id, contextId:id, backendId:id, initialProjectId:null, autoOpen:true, editorProjectId:null, editorPhase:'none', editorCount:0, entryMode:null, entryVersion:0, entryReceipt:null, settingsSlot:null, settingsVersion:0, selectionProjectId:null, selectionVersion:0, locatorStatus:null, locatorIntent:null, quitting:false };
test('window open receipts carry only verified failure fields', () => {
  const format = {code: 'PROJECT_FORMAT_NEWER', database: 'history', formatVersion: 8, supportedFormatVersion: 7};
  const error = {code: 'PROJECT_UNAVAILABLE', message: 'Internal path /private/raw.mioon', details: {...format,
    reason: 'PROJECT_FORMAT_NEWER', projectId: id, projectFile: '/private/raw.mioon'}};
  assert.deepEqual(projectWindowOpenFailure(error, id), format);
  assert.equal(projectWindowOpenFailure(error, '22222222-2222-4222-8222-222222222222'), undefined);
  assert.equal(projectWindowOpenFailure({...error, details: {...error.details, supportedFormatVersion: 8}}, id), undefined);
  assert.equal(projectWindowOpenFailure({code: 'PROJECT_UNAVAILABLE', details: {reason: 'PROJECT_FORMAT_NEWER'}}, id), undefined);
  assert.deepEqual(projectWindowOpenFailure({code: 'PROJECT_NOT_FOUND', details: {projectId: id}}, id), {code: 'PROJECT_MISSING'});
  assert.equal(projectWindowOpenFailure({code: 'PROJECT_NOT_FOUND', details: {}}, id), undefined);
  assert.deepEqual(projectWindowOpenFailure({code: 'PROJECT_UNAVAILABLE', details: {reason: 'PROJECT_INVALID', invalidReason: 'hot-journal'}}, id),
    {code: 'PROJECT_INVALID', reason: 'hot-journal'});
  assert.equal(projectWindowOpenFailure({code: 'PROJECT_INVALID', details: {reason: '/private/raw.mioon'}}, id), undefined);
  const refused = {ok: false, reason: 'unavailable', targetWindowId: null, targetPhase: null};
  assert.equal(isProjectWindowOpenResult({...refused, failure: format}), true);
  assert.equal(isProjectWindowOpenResult({...refused, reason: 'cancelled'}), true);
  assert.equal(isProjectWindowOpenResult({...refused, reason: 'busy', failure: format}), false);
  assert.equal(isProjectWindowOpenResult({...refused, failure: {...format, message: error.message}}), false);
  assert.equal(isProjectWindowOpenResult({...refused, failure: undefined}), false);
});

test('both window bridges restrict editor failures and cancellation to their exact shapes and document', async () => {
  const failure = {code: 'PROJECT_INVALID', reason: 'corrupt'} as const;
  const token = '22222222-2222-4222-8222-222222222222';
  const pending = {entryToken: token, projectId: id};
  const result = {ok: false, reason: 'unavailable', targetWindowId: null, targetPhase: null, failure};
  const calls: unknown[] = [];
  let current: unknown = {...context, entryPending: pending};
  assert.equal(isProjectWindowContext(current), true);
  assert.equal(isProjectWindowContext({...context, entryPending: {...pending, path: '/private/raw.mioon'}}), false);
  assert.equal(isProjectWindowContext({...context, entryPending: pending, entryReceipt: {entryToken: token, result}}), false);
  assert.equal(isProjectWindowContext({...context, entryPending: {...pending, kind: 'selected'}, entryReceipt: {entryToken: id, result}}), true);
  assert.equal(isProjectWindowContext({...context, entryPending: {...pending, kind: 'selected'}, entryReceipt: {entryToken: token, result}}), false);
  assert.equal(isProjectWindowContext({...context, entryPending: {...pending, kind: 'recent'}}), false);
  const preload = createProjectWindowBridge({invoke: async (_channel, request) => {
    if (request.action === 'describe') return current;
    calls.push(request);
    return request.action === 'open' ? result : true;
  }, on(){}, removeListener(){}});
  const renderer = readDesktopWindowBridge({__mioonProjectWindow: preload}); assert.ok(renderer?.cancelOpen);
  assert.equal(Object.isFrozen((await renderer.context()).entryPending), true);
  assert.equal(await renderer.cancelOpen(id), false);
  assert.equal(await renderer.cancelOpen(token), true);
  assert.deepEqual(calls, [{action: 'cancel-open', contextId: id, entryToken: token}]);
  assert.equal(isProjectWindowRequest({...calls[0] as object, projectId: id}), false);
  assert.deepEqual(await renderer.openProject(id, true, token), result);
  assert.equal(Object.isFrozen((await renderer.openProject(id, true, token)).failure), true);
  assert.equal(await renderer.editorStatus(id, 'failed', failure), true);
  assert.deepEqual(calls.at(-1), {action: 'editor-status', contextId: id, projectId: id, phase: 'failed', failure});
  await assert.rejects(renderer.editorStatus(id, 'ready', failure));
  await assert.rejects(preload.editorStatus(id, 'failed', {...failure, projectFile: '/private/raw.mioon'} as typeof failure));
  current = {...context, contextId: token, entryPending: pending};
  await assert.rejects(renderer.cancelOpen(token));
  assert.equal(calls.length, 4);
});
test('native settings pages cross both strict bridges as fixed intentions while old connection slots remain valid', async () => {
  const pages = ['agent', 'official', 'custom', 'comfy', 'general', 'workspace', 'video-tools', 'models', 'extensions', 'shortcuts', 'about'] as const;
  const calls: unknown[] = [];
  const preload = createProjectWindowBridge({invoke: async (channel, request) => {
    assert.equal(channel, PROJECT_WINDOW_CHANNEL);
    if (request.action === 'describe') return context;
    calls.push(request); return true;
  }, on(){}, removeListener(){}});
  const renderer = readDesktopWindowBridge({__mioonProjectWindow: preload}); assert.ok(renderer);
  for (const page of pages) {
    assert.equal(await renderer.showSettings(page), true);
    assert.deepEqual(calls.at(-1), {action: 'settings', contextId: id, slot: page});
    assert.equal(isProjectWindowRequest(calls.at(-1)), true);
    assert.equal(isProjectWindowContext({...context, role: 'settings', autoOpen: false, settingsSlot: page, settingsVersion: 1}), true);
  }
  const before = calls.length;
  for (const page of ['admin', '../general', 'javascript:reload()', {}, null]) {
    await assert.rejects(renderer.showSettings(page as Parameters<typeof renderer.showSettings>[0]));
    assert.equal(isProjectWindowRequest({action: 'settings', contextId: id, slot: page}), false);
    assert.equal(isProjectWindowContext({...context, role: 'settings', autoOpen: false, settingsSlot: page, settingsVersion: 1}), page === null);
  }
  assert.equal(calls.length, before);
  assert.equal(isProjectWindowRequest({action: 'settings', contextId: id, slot: 'general', force: true}), false);
});
test('fixed preload exposes only validated window actions and strips Electron event authority', async () => {
  const calls: Array<[string, unknown]> = []; let receive: ((...args: unknown[]) => void) | undefined, removed: unknown;
  type BridgeOptions = Parameters<typeof createProjectWindowBridge>[0];
  const bridge = createProjectWindowBridge({ invoke: async (channel: string, request: {action: string; [key: string]: unknown}) => { calls.push([channel, request]); return request.action === 'describe' ? context : request.action === 'open' ? {ok:true,reason:'accepted',targetWindowId:id,targetPhase:'opening'} : true; },
    on: (channel: string, listener: (...args: unknown[]) => void) => { assert.equal(channel, PROJECT_WINDOW_EVENT); receive=listener; }, removeListener: (_channel: string, listener: (...args: unknown[]) => void) => { removed=listener; } } as unknown as BridgeOptions);
  assert.deepEqual(Object.keys(bridge).sort(), ['cancelOpen','closeSettings','context','editorStatus','openProject','publishLocatorStatus','requestLocatorAction','requestProjectEntry','showProjects','showSettings','subscribe']);
  assert.equal(Object.isFrozen(bridge), true);
  await bridge.openProject(id, true, id); await bridge.requestProjectEntry('new'); await bridge.showProjects(); await bridge.showSettings('agent'); await bridge.editorStatus(id,'ready');
  assert.ok(calls.every(([channel, request]) => channel === PROJECT_WINDOW_CHANNEL && isProjectWindowRequest(request)));
  const events: unknown[]=[]; const release=bridge.subscribe(value=>events.push(value)); const secret={sender:{send(){assert.fail();}},token:'not-exposed'};
  receive!(secret,context); receive!(secret,{...context,token:'forbidden'}); assert.equal(events.length,1); assert.deepEqual(events[0],context); assert.notEqual(events[0],context);
  release(); release(); assert.equal(removed,receive); receive!(secret,context); assert.equal(events.length,1);
  const before=calls.length; await assert.rejects((bridge.openProject as (...args: unknown[]) => Promise<unknown>)('/tmp/private')); await assert.rejects(bridge.showSettings('decrypt' as Parameters<typeof bridge.showSettings>[0])); assert.equal(calls.length,before);
  await assert.rejects(bridge.closeSettings()); assert.equal((calls.at(-1)![1] as {action:string}).action, 'describe');
});

test('settings preload emits only its fixed guarded-close action and validates acknowledgement and document identity', async () => {
  const settings = {...context, role:'settings', autoOpen:false, settingsSlot:'agent', settingsVersion:1};
  let current = settings, answer:unknown=true;
  const calls: unknown[] = [];
  const bridge = createProjectWindowBridge({invoke:async (channel, request) => {
    assert.equal(channel, PROJECT_WINDOW_CHANNEL); calls.push(request); return request.action === 'describe' ? current : answer;
  },on(){},removeListener(){}});
  assert.equal(await bridge.closeSettings(), true);
  assert.deepEqual(calls, [{action:'describe'}, {action:'settings-close',contextId:id}]);
  answer = {closed:true}; await assert.rejects(bridge.closeSettings());
  const before = calls.filter(value => (value as {action:string}).action === 'settings-close').length;
  current = {...settings, contextId:'22222222-2222-4222-8222-222222222222'};
  await assert.rejects(bridge.closeSettings());
  assert.equal(calls.filter(value => (value as {action:string}).action === 'settings-close').length, before);
  for (const role of ['launcher','editor']) {
    const denied = createProjectWindowBridge({invoke:async (_channel, request) => {
      assert.equal(request.action,'describe');
      return role === 'launcher' ? context : {...context,role:'editor',autoOpen:false,initialProjectId:id,editorProjectId:id,editorPhase:'ready'};
    },on(){},removeListener(){}});
    await assert.rejects(denied.closeSettings());
  }
});
test('preload rejects malformed output and protocol rejects extra authority fields', async () => {
  for(const extra of [{url:'https://evil.invalid'}, {path:'/tmp/x'}, {token:'x'}, {operation:'image.generate'}]) assert.equal(isProjectWindowRequest({action:'open',contextId:id,projectId:id,...extra}),false);
  assert.equal(isProjectWindowRequest({action:'settings-close',contextId:id}), true);
  for(const extra of [{force:true}, {targetWindowId:id}, {slot:'agent'}, {token:'x'}, {operation:'close'}]) assert.equal(isProjectWindowRequest({action:'settings-close',contextId:id,...extra}),false);
  for(const bad of [{...context,version:1}, {...context,role:{toString:()=> 'launcher'}}, {...context,role:'admin'}, {...context,editorPhase:{toString:()=> 'ready'}}, {...context,settingsVersion:-1}, {...context,secret:'x'}]) {
    const bridge=createProjectWindowBridge({invoke:async()=>bad,on(){},removeListener(){}} as unknown as Parameters<typeof createProjectWindowBridge>[0]); await assert.rejects(bridge.context());
  }
});
test('actual sandbox preload bundle requires only Electron and exposes no arbitrary transport', async () => {
  const result=await build({entryPoints:['apps/desktop/src/preload.ts'], bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron'],write:false,metafile:true});
  const text=result.outputFiles[0].text;
  const imports=Object.values(result.metafile.outputs).flatMap(output=>output.imports.map(item=>item.path));
  assert.deepEqual(imports,['electron']); assert.match(text,/exposeInMainWorld\("__mioonProjectWindow"/); assert.doesNotMatch(text,/node:|\.sendSync\(|\.postMessage\(|webContents|process\.env/);
  const homeDirectory = '/synthetic/home with spaces';
  for (const [isMainFrame, argv, expected] of [
    [true, [`--mioon-home-directory=${homeDirectory}`], homeDirectory],
    [false, [`--mioon-home-directory=${homeDirectory}`], undefined],
    [true, ['--unrelated=synthetic'], undefined],
  ] as const) {
    const exposed = new Map<string, unknown>();
    runInNewContext(text, {
      process: {isMainFrame, argv},
      TextEncoder, TextDecoder, URL,
      require: (module: string) => {
        assert.equal(module, 'electron');
        return {contextBridge: {exposeInMainWorld: (name: string, value: unknown) => exposed.set(name, value)}, ipcRenderer: {}, webUtils: {}};
      },
    });
    assert.equal(exposed.get('__mioonHomeDirectory'), expected);
  }
});
test('restart confirmation cannot act on replaced startup/backend or a newly requested Quit', async () => {
  let owner: Record<string, unknown> = {}, available=true, calls=0; const deferred=Promise.withResolvers<boolean>();
  const restart=async()=>{calls++;return true;};
  const work=confirmOwnedWindowRestart({getOwner:()=>owner,canRequest:()=>available,confirm:()=>deferred.promise,restart});
  owner={}; deferred.resolve(true); assert.equal(await work,false); assert.equal(calls,0);
  const next=Promise.withResolvers<boolean>(); const second=confirmOwnedWindowRestart({getOwner:()=>owner,canRequest:()=>available,confirm:()=>next.promise,restart});
  available=false; next.resolve(true); assert.equal(await second,false); assert.equal(calls,0);
});

test('old preload cannot borrow replacement document context for a late status or action', async () => {
  let current: Record<string, unknown> = context, actions = 0;
  let receive: ((...args: unknown[]) => void) | undefined;
  const bridge = createProjectWindowBridge({ invoke: async (_channel: string, request: {action: string}) => {
    if (request.action === 'describe') return current;
    actions++; return true;
  }, on: (_channel: string, listener: (...args: unknown[]) => void) => { receive = listener; }, removeListener() {} } as unknown as Parameters<typeof createProjectWindowBridge>[0]);
  await bridge.context(); const events: unknown[] = []; bridge.subscribe(value => events.push(value));
  current = { ...context, contextId: '22222222-2222-4222-8222-222222222222' };
  receive!({}, current);
  await assert.rejects(bridge.editorStatus(id, 'ready'));
  await assert.rejects(bridge.openProject(id, true, id));
  await assert.rejects(bridge.showSettings('agent'));
  assert.equal(actions, 0); assert.equal(events.length, 0);
});

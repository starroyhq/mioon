import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createProjectWindowBridge } from '../apps/desktop/src/project-window-preload.ts';
import { isProjectWindowRequest, PROJECT_WINDOW_CHANNEL, PROJECT_WINDOW_EVENT } from '../apps/desktop/src/project-window-protocol.ts';
import { confirmOwnedWindowRestart } from '../apps/desktop/src/project-window-confirmation.ts';
const id = '11111111-1111-4111-8111-111111111111';
const context = { version:2, role:'launcher', windowId:id, contextId:id, backendId:id, initialProjectId:null, autoOpen:true, editorProjectId:null, editorPhase:'none', editorCount:0, entryMode:null, entryVersion:0, entryReceipt:null, settingsSlot:null, settingsVersion:0, selectionProjectId:null, selectionVersion:0, locatorStatus:null, locatorIntent:null, quitting:false };
test('fixed preload exposes only validated window actions and strips Electron event authority', async () => {
  const calls: Array<[string, unknown]> = []; let receive: ((...args: unknown[]) => void) | undefined, removed: unknown;
  type BridgeOptions = Parameters<typeof createProjectWindowBridge>[0];
  const bridge = createProjectWindowBridge({ invoke: async (channel: string, request: {action: string; [key: string]: unknown}) => { calls.push([channel, request]); return request.action === 'describe' ? context : request.action === 'open' ? {ok:true,reason:'accepted',targetWindowId:id,targetPhase:'opening'} : true; },
    on: (channel: string, listener: (...args: unknown[]) => void) => { assert.equal(channel, PROJECT_WINDOW_EVENT); receive=listener; }, removeListener: (_channel: string, listener: (...args: unknown[]) => void) => { removed=listener; } } as unknown as BridgeOptions);
  assert.deepEqual(Object.keys(bridge).sort(), ['context','editorStatus','openProject','publishLocatorStatus','requestLocatorAction','requestProjectEntry','showProjects','showSettings','subscribe']);
  assert.equal(Object.isFrozen(bridge), true);
  await bridge.openProject(id, true, id); await bridge.requestProjectEntry('new'); await bridge.showProjects(); await bridge.showSettings('agent'); await bridge.editorStatus(id,'ready');
  assert.ok(calls.every(([channel, request]) => channel === PROJECT_WINDOW_CHANNEL && isProjectWindowRequest(request)));
  const events: unknown[]=[]; const release=bridge.subscribe(value=>events.push(value)); const secret={sender:{send(){assert.fail();}},token:'not-exposed'};
  receive!(secret,context); receive!(secret,{...context,token:'forbidden'}); assert.equal(events.length,1); assert.deepEqual(events[0],context); assert.notEqual(events[0],context);
  release(); release(); assert.equal(removed,receive); receive!(secret,context); assert.equal(events.length,1);
  const before=calls.length; await assert.rejects((bridge.openProject as (...args: unknown[]) => Promise<unknown>)('/tmp/private')); await assert.rejects(bridge.showSettings('decrypt' as Parameters<typeof bridge.showSettings>[0])); assert.equal(calls.length,before);
});
test('preload rejects malformed output and protocol rejects extra authority fields', async () => {
  for(const extra of [{url:'https://evil.invalid'}, {path:'/tmp/x'}, {token:'x'}, {operation:'image.generate'}]) assert.equal(isProjectWindowRequest({action:'open',contextId:id,projectId:id,...extra}),false);
  for(const bad of [{...context,version:1}, {...context,role:{toString:()=> 'launcher'}}, {...context,role:'admin'}, {...context,editorPhase:{toString:()=> 'ready'}}, {...context,settingsVersion:-1}, {...context,secret:'x'}]) {
    const bridge=createProjectWindowBridge({invoke:async()=>bad,on(){},removeListener(){}} as unknown as Parameters<typeof createProjectWindowBridge>[0]); await assert.rejects(bridge.context());
  }
});
test('actual sandbox preload bundle requires only Electron and exposes no arbitrary transport', async () => {
  const result=await build({entryPoints:['apps/desktop/src/preload.ts'], bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron'],write:false,metafile:true});
  const text=result.outputFiles[0].text;
  const imports=Object.values(result.metafile.outputs).flatMap(output=>output.imports.map(item=>item.path));
  assert.deepEqual(imports,['electron']); assert.match(text,/exposeInMainWorld\("__mioonProjectWindow"/); assert.doesNotMatch(text,/node:|\.sendSync\(|\.postMessage\(|webContents|process\.env/);
});
test('restart confirmation cannot act on replaced startup/backend or a newly requested Quit', async () => {
  let owner: Record<string, unknown> = {}, available=true, calls=0; const deferred=Promise.withResolvers<boolean>();
  const work=confirmOwnedWindowRestart({getOwner:()=>owner,canRequest:()=>available,confirm:()=>deferred.promise,restart:async()=>calls++});
  owner={}; deferred.resolve(true); assert.equal(await work,false); assert.equal(calls,0);
  const next=Promise.withResolvers<boolean>(); const second=confirmOwnedWindowRestart({getOwner:()=>owner,canRequest:()=>available,confirm:()=>next.promise,restart:async()=>calls++});
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

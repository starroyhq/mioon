import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createProjectWindowBridge } from '../apps/desktop/src/project-window-preload.ts';
import { isProjectWindowRequest, PROJECT_WINDOW_CHANNEL, PROJECT_WINDOW_EVENT } from '../apps/desktop/src/project-window-protocol.ts';
import { confirmOwnedWindowRestart } from '../apps/desktop/src/project-window-confirmation.ts';
const id = '11111111-1111-4111-8111-111111111111';
const context = { version:1, role:'launcher', contextId:id, backendId:id, initialProjectId:null, autoOpen:true, editorProjectId:null, editorPhase:'none', settingsSlot:null, settingsVersion:0, quitting:false };
test('fixed preload exposes only validated window actions and strips Electron event authority', async () => {
  const calls = []; let receive, removed;
  const bridge = createProjectWindowBridge({ invoke: async (channel, request) => { calls.push([channel, request]); return request.action === 'describe' ? context : request.action === 'open' ? {ok:true,reason:'accepted'} : true; },
    on: (channel, listener) => { assert.equal(channel, PROJECT_WINDOW_EVENT); receive=listener; }, removeListener: (channel, listener) => { removed=listener; } });
  assert.deepEqual(Object.keys(bridge).sort(), ['context','editorStatus','openProject','showProjects','showSettings','subscribe']);
  assert.equal(Object.isFrozen(bridge), true);
  await bridge.openProject(id); await bridge.showProjects(); await bridge.showSettings('agent'); await bridge.editorStatus(id,'ready');
  assert.ok(calls.every(([channel, request]) => channel === PROJECT_WINDOW_CHANNEL && isProjectWindowRequest(request)));
  const events=[]; const release=bridge.subscribe(value=>events.push(value)); const secret={sender:{send(){assert.fail();}},token:'not-exposed'};
  receive(secret,context); receive(secret,{...context,token:'forbidden'}); assert.equal(events.length,1); assert.deepEqual(events[0],context); assert.notEqual(events[0],context);
  release(); release(); assert.equal(removed,receive); receive(secret,context); assert.equal(events.length,1);
  const before=calls.length; await assert.rejects(bridge.openProject('/tmp/private')); await assert.rejects(bridge.showSettings('decrypt')); assert.equal(calls.length,before);
});
test('preload rejects malformed output and protocol rejects extra authority fields', async () => {
  for(const extra of [{url:'https://evil.invalid'}, {path:'/tmp/x'}, {token:'x'}, {operation:'image.generate'}]) assert.equal(isProjectWindowRequest({action:'open',contextId:id,projectId:id,...extra}),false);
  for(const bad of [{...context,role:'admin'}, {...context,editorPhase:{toString:()=> 'ready'}}, {...context,settingsVersion:-1}, {...context,secret:'x'}]) {
    const bridge=createProjectWindowBridge({invoke:async()=>bad,on(){},removeListener(){}}); await assert.rejects(bridge.context());
  }
});
test('actual sandbox preload bundle requires only Electron and exposes no arbitrary transport', async () => {
  const result=await build({entryPoints:['apps/desktop/src/preload.ts'], bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron'],write:false,metafile:true});
  const text=result.outputFiles[0].text;
  const imports=Object.values(result.metafile.outputs).flatMap(output=>output.imports.map(item=>item.path));
  assert.deepEqual(imports,['electron']); assert.match(text,/exposeInMainWorld\("__mioonProjectWindow"/); assert.doesNotMatch(text,/node:|\.sendSync\(|\.postMessage\(|webContents|process\.env/);
});
test('restart confirmation cannot act on replaced startup/backend or a newly requested Quit', async () => {
  let owner={}, available=true, calls=0; const deferred=Promise.withResolvers();
  const work=confirmOwnedWindowRestart({getOwner:()=>owner,canRequest:()=>available,confirm:()=>deferred.promise,restart:async()=>calls++});
  owner={}; deferred.resolve(true); assert.equal(await work,false); assert.equal(calls,0);
  const next=Promise.withResolvers(); const second=confirmOwnedWindowRestart({getOwner:()=>owner,canRequest:()=>available,confirm:()=>next.promise,restart:async()=>calls++});
  available=false; next.resolve(true); assert.equal(await second,false); assert.equal(calls,0);
});

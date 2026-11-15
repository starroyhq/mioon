









import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';


import {createVideoSettingsV2} from '../packages/business/src/video/settings-v2.ts';
import {createVideoHttp} from '../apps/server/src/video-http.ts';
import {startServer} from './helpers/test-server.ts';


import {defaultVideoModels,VIDEO_SETTINGS_LIMITS,VIDEO_PROVIDER_NAMES} from '../packages/contracts/src/video-providers.ts';




const SENTINEL='synthetic-video-http-key';
const configuration=()=>({id:randomUUID(),name:VIDEO_PROVIDER_NAMES.minimax,providerId:'minimax',region:'global',workspaceId:'',enabled:true,outputHosts:[],models:defaultVideoModels('minimax')});

async function fixture(t:{after(fn:()=>unknown):void},checkFetch?:typeof fetch){const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-video-http-'))),settings=await createVideoSettingsV2({directory:path.join(root,'video-settings'),privateRoot:root}),handler=createVideoHttp({settings,...(checkFetch?{checkFetch}:{})});t.after(async()=>{await settings.close();await rm(root,{recursive:true,force:true});});return {root,settings,async request(route='/api/video-providers/settings',method='GET',input?:unknown,headers:Record<string,string>={},raw?:Buffer){const req=Readable.from(raw?[raw]:input===undefined?[]:[Buffer.from(JSON.stringify(input))]) as unknown as import('node:http').IncomingMessage;req.url=route;req.method=method;req.headers={'content-type':'application/json',...headers};let status=0,body='';const responseHeaders:Record<string,unknown>={};const res=Object.assign(new EventEmitter(),{setHeader:(name:string,value:unknown)=>{responseHeaders[name]=value;},writeHead:(code:number,values:Record<string,unknown>)=>{status=code;Object.assign(responseHeaders,values);},end:(value:string)=>{body=value;},destroy:()=>assert.fail('Unexpected destruction')}) as unknown as import('node:http').ServerResponse;const handled=await handler(req,res,new URL(route,'http://localhost'));return {status,body,headers:responseHeaders,handled,data:body?JSON.parse(body):null};}};}

test('private video settings HTTP returns no secrets and enforces strict CAS and request boundaries',async t=>{const f=await fixture(t);assert.equal((await f.request()).status,200);const saved=await f.request(undefined,'PUT',{action:'save',expectedRevision:0,configuration:configuration(),secret:{action:'replace',storage:'session',value:SENTINEL}});assert.equal(saved.status,200);assert.equal(saved.headers['Cache-Control'],'no-store');assert.equal(saved.body.includes(SENTINEL),false);assert.equal((await f.request()).body.includes(SENTINEL),false);const stale=await f.request(undefined,'PUT',{action:'delete',expectedRevision:0,connectionId:saved.data.data.connections[0].configuration.id});assert.equal(stale.status,409);for(const [route,method,input,headers,raw] of [['/api/video-providers/settings?key='+SENTINEL,'GET'],['/api/video-providers/settings','PUT',{}, {'content-type':'text/plain'}],['/api/video-providers/settings','PUT',{}, {'content-encoding':'gzip'}],['/api/video-providers/settings','PUT',{}, {'content-length':'01'}],['/api/video-providers/settings','PUT',undefined,{},Buffer.from([255])]] as const){const value=await f.request(route,method,input,headers,raw);assert.equal(value.status,400);assert.equal(value.body.includes(SENTINEL),false);}assert.equal((await f.request(undefined,'PUT',undefined,{'content-length':String(VIDEO_SETTINGS_LIMITS.updateBytes+1)})).status,413);assert.equal((await f.request('/api/video-providers/unknown')).status,404);const method=await f.request(undefined,'POST');assert.equal(method.status,405);assert.equal(method.headers.Allow,'GET, PUT');assert.equal((await f.request('/api/not-video')).handled,false);});

test('server authentication and origin gates precede video settings and settings stay outside public RPC',async t=>{const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-video-server-http-'))),server=await startServer({dataDir:root,port:0});t.after(async()=>{await server.close();await rm(root,{recursive:true,force:true});});const route=server.url+'/api/video-providers/settings';assert.equal((await fetch(route)).status,401);assert.equal((await fetch(route,{headers:{Authorization:`Bearer ${server.token}`,Origin:'https://untrusted.example'}})).status,403);const response:Response=await fetch(route,{method:'PUT',headers:{Authorization:`Bearer ${server.token}`,'content-type':'application/json'},body:JSON.stringify({action:'save',expectedRevision:0,configuration:configuration(),secret:{action:'replace',storage:'session',value:SENTINEL}})});assert.equal(response.status,200);assert.equal((await response.text()).includes(SENTINEL),false);assert.equal((await readFile(path.join(root,'video-settings/settings.json'),'utf8')).includes(SENTINEL),false);const rpc=await fetch(server.url+'/api/rpc',{method:'POST',headers:{Authorization:`Bearer ${server.token}`,'content-type':'application/json'},body:JSON.stringify({operation:'video.settings.get',input:{}})});assert.ok(rpc.status>=400);});


const modelsRoute = '/api/video-providers/models/list';
const draftKey = 'synthetic-draft-video-key';
const originalBase = 'https://video-old.example/v1';
const newBase = 'https://video-new.example/compatible/v1';
const compatible = () => ({...configuration(), providerId: 'compatible', region: 'custom', name: 'Synthetic', baseUrl: originalBase, models: defaultVideoModels('compatible')});

test('video checks and model discovery use draft credentials once and save alone replaces the persisted binding', async t => {
  const observations: Array<{url: string; authorization: string | null}> = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    assert.equal(init?.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.body, undefined);
    const authorization = new Headers(init.headers).get('authorization');
    observations.push({url: String(url), authorization});
    const key = authorization?.slice('Bearer '.length);
    return new Response(JSON.stringify({data: [{id: 'video-model-1'}, {id: key}, {id: 'video-model-1', displayName: key}], diagnostic: key}));
  };
  const f = await fixture(t, fakeFetch);
  const setting = compatible();
  const file = path.join(f.root, 'video-settings', 'settings.json');
  const target = {providerId: setting.providerId, region: setting.region, workspaceId: '', baseUrl: originalBase};
  const saved = {source: 'saved', ...target, connectionId: setting.id, configurationRevision: 1};
  const draft = {source: 'draft', ...target, value: draftKey};
  const put = (expectedRevision: number, value: string, baseUrl = originalBase) => f.request(undefined, 'PUT', {
    action: 'save', expectedRevision, configuration: {...setting, baseUrl}, secret: {action: 'replace', storage: 'session', value},
  });
  assert.equal((await put(0, SENTINEL)).status, 200);
  const before = await readFile(file);
  const checked = await f.request(modelsRoute, 'POST', {...draft, operation: 'check'});
  const listed = await f.request(modelsRoute, 'POST', {...draft, operation: 'models'});
  assert.deepEqual(checked.data.data, {result: 'ok'});
  assert.deepEqual(listed.data.data, {result: 'ok', models: [{id: 'video-model-1'}]});
  assert.equal(listed.headers['Cache-Control'], 'no-store');
  assert.doesNotMatch(checked.body + listed.body, new RegExp(draftKey));
  assert.deepEqual(await readFile(file), before);
  assert.equal((await f.settings.get()).revision, 1);

  // Leaving without saving sends no mutation. Checking the saved settings
  // afterward still uses the original recipient and original key.
  assert.equal((await f.request(modelsRoute, 'POST', {...saved, operation: 'check'})).status, 200);
  const refused = await f.request(modelsRoute, 'POST', {...saved, operation: 'models', baseUrl: newBase});
  assert.equal(refused.status, 409);
  assert.doesNotMatch(refused.body, new RegExp(SENTINEL));
  assert.equal(observations.length, 3);
  const changed = await f.request(modelsRoute, 'POST', {...draft, operation: 'models', baseUrl: newBase});
  assert.equal(changed.status, 200);
  assert.deepEqual(await readFile(file), before);
  assert.equal((await put(1, draftKey, newBase)).status, 200);
  assert.equal((await f.request(modelsRoute, 'POST', {...saved, operation: 'check', baseUrl: newBase, configurationRevision: 2})).status, 200);
  assert.deepEqual(observations, [
    {url: originalBase+'/models', authorization: 'Bearer '+draftKey},
    {url: originalBase+'/models', authorization: 'Bearer '+draftKey},
    {url: originalBase+'/models', authorization: 'Bearer '+SENTINEL},
    {url: newBase+'/models', authorization: 'Bearer '+draftKey},
    {url: newBase+'/models', authorization: 'Bearer '+draftKey},
  ]);
  assert.doesNotMatch(await readFile(file, 'utf8'), new RegExp(draftKey));
});

test('video draft checks derive the selected provider recipient and expose only safe outcomes', async t => {
  const requests: string[] = [];
  let reject = false;
  const f = await fixture(t, async (url, init) => {
    const recipient = new URL(String(url));
    requests.push(recipient.origin + recipient.pathname);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-goog-api-key') ?? headers.get('authorization'),
      recipient.host === 'generativelanguage.googleapis.com' ? draftKey : recipient.host === 'api.vidu.com' ? 'Token '+draftKey : 'Bearer '+draftKey);
    assert.equal(init?.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(headers.get('x-dashscope-workspace'), recipient.host.endsWith('maas.aliyuncs.com') ? 'workspace-a' : null);
    assert.doesNotMatch(recipient.href, new RegExp(draftKey));
    if (reject) {
      if (recipient.host === 'api.minimax.io') return new Response(JSON.stringify({base_resp: {status_code: 1004, status_msg: draftKey}}));
      throw Object.assign(new Error(draftKey), {code: 'VIDEO_NETWORK_DENIED'});
    }
    const payload = recipient.host === 'api.minimax.io' ? {items: [{content: {url: draftKey}}]}
      : recipient.host === 'api.vidu.com' ? {remains: [{private: draftKey}]}
      : recipient.host === 'api-singapore.klingai.com' ? {code: 0, data: {code: 0, resource_pack_subscribe_infos: []}}
      : recipient.host.endsWith('maas.aliyuncs.com') ? {data: []}
      : recipient.host === 'generativelanguage.googleapis.com' ? {models: [
        {name: 'models/veo-video-example', supportedGenerationMethods: ['predictLongRunning']},
        {name: 'models/gemini-text-example', supportedGenerationMethods: ['generateContent']},
      ]} : {data: [
        {id: 'doubao-seedance-example', modalities: {output_modalities: ['video']}},
        {id: 'doubao-seed-text-example', modalities: {output_modalities: ['text']}},
      ]};
    return new Response(JSON.stringify(payload));
  });
  const probe = (providerId: string, region: string, operation = 'check', workspaceId = '') =>
    f.request(modelsRoute, 'POST', {providerId, region, operation, workspaceId, source: 'draft', value: draftKey});
  assert.deepEqual((await probe('minimax', 'global')).data.data, {result: 'ok'});
  assert.deepEqual((await probe('vidu', 'global')).data.data, {result: 'ok'});
  assert.deepEqual((await probe('kling', 'global')).data.data, {result: 'ok'});
  assert.deepEqual((await probe('wan', 'cn-beijing', 'check', 'workspace-a')).data.data, {result: 'ok'});
  assert.deepEqual((await probe('ark', 'cn-beijing', 'models')).data.data, {result: 'ok', models: [{id: 'doubao-seedance-example'}]});
  assert.deepEqual((await probe('veo', 'global', 'models')).data.data, {result: 'ok', models: [{id: 'veo-video-example'}]});
  assert.deepEqual((await probe('minimax', 'global', 'models')).data.data, {result: 'unsupported'});
  assert.deepEqual(requests, [
    'https://api.minimax.io/v2/query/video_generation', 'https://api.vidu.com/ent/v2/credits',
    'https://api-singapore.klingai.com/account/costs', 'https://workspace-a.cn-beijing.maas.aliyuncs.com/api/v1/tasks',
    'https://ark.cn-beijing.volces.com/api/v3/models', 'https://generativelanguage.googleapis.com/v1beta/models',
  ]);
  const errors = t.mock.method(console, 'error', () => {});
  const warnings = t.mock.method(console, 'warn', () => {});
  const logs = t.mock.method(console, 'log', () => {});
  reject = true;
  const deniedKey = await probe('minimax', 'global');
  assert.deepEqual(deniedKey.data.data, {result: 'unauthorized'});
  const denied = await probe('vidu', 'global');
  assert.deepEqual(denied.data.data, {result: 'denied'});
  assert.doesNotMatch(deniedKey.body + denied.body, new RegExp(draftKey));
  const arbitraryHost = await f.request(modelsRoute, 'POST', {
    providerId: 'minimax', region: 'global', workspaceId: '', operation: 'check', source: 'draft', value: draftKey, baseUrl: newBase,
  });
  assert.equal(arbitraryHost.status, 400);
  assert.doesNotMatch(arbitraryHost.body, new RegExp(draftKey));
  assert.equal(requests.length, 8);
  assert.equal((await f.settings.get()).revision, 0);
  for (const output of [errors, warnings, logs]) assert.equal(output.mock.callCount(), 0);
});


test('video model probes are private authenticated POSTs and reject saved recipient mismatches', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-video-probe-server-')));
  const server = await startServer({dataDir: root, port: 0});
  t.after(async () => {await server.close(); await rm(root, {recursive: true, force: true});});
  const route = server.url + modelsRoute;
  const headers = {Authorization: 'Bearer '+server.token, 'content-type': 'application/json'};
  const body = JSON.stringify({operation: 'check', source: 'draft', providerId: 'veo', region: 'global', workspaceId: '', value: draftKey});
  assert.equal((await fetch(route, {method: 'POST', headers: {'content-type': 'application/json'}, body})).status, 401);
  assert.equal((await fetch(route, {method: 'POST', headers: {...headers, Origin: 'https://other.example.com'}, body})).status, 403);
  assert.equal((await fetch(route, {headers})).status, 405);
  const saved = await fetch(route, {method: 'POST', headers, body: JSON.stringify({
    operation: 'check', source: 'saved', providerId: 'veo', region: 'global', workspaceId: '',
    connectionId: randomUUID(), configurationRevision: 1,
  })});
  assert.equal(saved.status, 409);
  assert.equal(saved.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(await saved.text(), new RegExp(draftKey));
});

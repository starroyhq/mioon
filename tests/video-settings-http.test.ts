import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,readFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import http from 'node:http';
import {once} from 'node:events';
import {createVideoSettings} from '../packages/business/src/video/settings.ts';
import {createVideoHttp} from '../apps/server/src/video-http.ts';
import {startServer} from '../apps/server/src/index.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {restoreFixture} from './helpers/workspace-restore-offline-fixture.ts';
import {defaultVideoModels,VIDEO_SETTINGS_LIMITS} from '../packages/contracts/src/video-providers.ts';
import {openLegacyWorkspaceStore,getWorkspaceRestoreContext} from '../packages/business/src/db.ts';
import {workspaceRestoreError} from '../packages/business/src/workspace-restore-policy.ts';
import {AppError} from '../packages/contracts/src/app-error.ts';
import {dataFileSnapshot} from './helpers/data-file-snapshot.ts';
const SENTINEL='synthetic-video-http-key';
const configuration=()=>({id:randomUUID(),name:'API connection',providerId:'minimax',region:'global',workspaceId:'',enabled:true,archived:false,outputHosts:[],models:defaultVideoModels('minimax')});
async function legacyVideoFamily(root:string,token:string){
 const store=openLegacyWorkspaceStore(root),restored=getWorkspaceRestoreContext(store);let settings:Awaited<ReturnType<typeof createVideoSettings>>|undefined,origin='';
 const server=http.createServer((req,res)=>{void(async()=>{
  try{
   if(req.headers.host!==new URL(origin).host||req.headers.origin&&req.headers.origin!==origin)throw new AppError('ORIGIN_REJECTED','Fixture origin rejected',403);
   if(req.headers.authorization!==`Bearer ${token}`)throw new AppError('UNAUTHORIZED','Fixture token required',401);
   const url=new URL(req.url??'/',origin);
   // Exact video-family disjunct from ec8ca553 apps/server/src/index.ts:304.
   // The profile is verified by the real legacy opener; use its shared error.
   if(restored&&/^\/api\/video-providers(?:\/|$)/u.test(url.pathname))throw workspaceRestoreError();
   if(req.method!=='GET'||!/^\/api\/video-providers(?:\/|$)/u.test(url.pathname))throw new AppError('NOT_FOUND','Outside the finite video fixture',404);
   settings??=await createVideoSettings({directory:path.join(root,'video-settings'),privateRoot:root});
   if(!await createVideoHttp({settings})(req,res,url))throw new AppError('NOT_FOUND','Outside the finite video fixture',404);
  }catch(error){const safe=error instanceof AppError?error:new AppError('INTERNAL_ERROR','Historical video fixture failed',500);res.writeHead(safe.status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({ok:false,error:{code:safe.code,message:safe.message,details:safe.details,retryable:false}}));}
 })();});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('Expected loopback listener');origin=`http://127.0.0.1:${address.port}`;
 let closing:Promise<void>|undefined;
 return{url:origin,token,restored,close:()=>closing??=(async()=>{server.closeAllConnections();try{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await settings?.close();}finally{store.close();}})()};
}
async function fixture(t:{after(fn:()=>unknown):void}){const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-video-http-'))),settings=await createVideoSettings({directory:path.join(root,'video-settings'),privateRoot:root}),handler=createVideoHttp({settings});t.after(async()=>{await settings.close();await rm(root,{recursive:true,force:true});});return {settings,async request(route='/api/video-providers/settings',method='GET',input?:unknown,headers:Record<string,string>={},raw?:Buffer){const req=Readable.from(raw?[raw]:input===undefined?[]:[Buffer.from(JSON.stringify(input))]) as unknown as import('node:http').IncomingMessage;req.url=route;req.method=method;req.headers={'content-type':'application/json',...headers};let status=0,body='';const responseHeaders:Record<string,unknown>={};const res={setHeader:(name:string,value:unknown)=>{responseHeaders[name]=value;},writeHead:(code:number,values:Record<string,unknown>)=>{status=code;Object.assign(responseHeaders,values);},end:(value:string)=>{body=value;},destroy:()=>assert.fail('Unexpected destruction')} as unknown as import('node:http').ServerResponse;const handled=await handler(req,res,new URL(route,'http://localhost'));return {status,body,headers:responseHeaders,handled,data:body?JSON.parse(body):null};}};}

test('private video settings HTTP returns no secrets and enforces strict CAS and request boundaries',async t=>{const f=await fixture(t);assert.equal((await f.request()).status,200);const saved=await f.request(undefined,'PUT',{action:'save',expectedRevision:0,configuration:configuration(),secret:{action:'replace',storage:'session',value:SENTINEL}});assert.equal(saved.status,200);assert.equal(saved.headers['Cache-Control'],'no-store');assert.equal(saved.body.includes(SENTINEL),false);assert.equal((await f.request()).body.includes(SENTINEL),false);const stale=await f.request(undefined,'PUT',{action:'archive',expectedRevision:0,connectionId:saved.data.data.connections[0].configuration.id});assert.equal(stale.status,409);for(const [route,method,input,headers,raw] of [['/api/video-providers/settings?key='+SENTINEL,'GET'],['/api/video-providers/settings','PUT',{}, {'content-type':'text/plain'}],['/api/video-providers/settings','PUT',{}, {'content-encoding':'gzip'}],['/api/video-providers/settings','PUT',{}, {'content-length':'01'}],['/api/video-providers/settings','PUT',undefined,{},Buffer.from([255])]] as const){const value=await f.request(route,method,input,headers,raw);assert.equal(value.status,400);assert.equal(value.body.includes(SENTINEL),false);}assert.equal((await f.request(undefined,'PUT',undefined,{'content-length':String(VIDEO_SETTINGS_LIMITS.updateBytes+1)})).status,413);assert.equal((await f.request('/api/video-providers/unknown')).status,404);const method=await f.request(undefined,'POST');assert.equal(method.status,405);assert.equal(method.headers.Allow,'GET, PUT');assert.equal((await f.request('/api/not-video')).handled,false);});

test('server authentication and origin gates precede video settings and settings stay outside public RPC',async t=>{const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-video-server-http-'))),server=await startServer({dataDir:root,port:0});t.after(async()=>{await server.close();await rm(root,{recursive:true,force:true});});const route=server.url+'/api/video-providers/settings';assert.equal((await fetch(route)).status,401);assert.equal((await fetch(route,{headers:{Authorization:`Bearer ${server.token}`,Origin:'https://untrusted.example'}})).status,403);const response:Response=await fetch(route,{method:'PUT',headers:{Authorization:`Bearer ${server.token}`,'content-type':'application/json'},body:JSON.stringify({action:'save',expectedRevision:0,configuration:configuration(),secret:{action:'replace',storage:'session',value:SENTINEL}})});assert.equal(response.status,200);assert.equal((await response.text()).includes(SENTINEL),false);assert.equal((await readFile(path.join(root,'video-settings/settings.json'),'utf8')).includes(SENTINEL),false);const rpc=await fetch(server.url+'/api/rpc',{method:'POST',headers:{Authorization:`Bearer ${server.token}`,'content-type':'application/json'},body:JSON.stringify({operation:'video.settings.get',input:{}})});assert.ok(rpc.status>=400);});

test('restored workspaces refuse the entire private video route family before creating settings',async t=>{
 const f=await restoreFixture({after:()=>{}},{stages:false});let server:Awaited<ReturnType<typeof legacyVideoFamily>>|undefined,ordinary:Awaited<ReturnType<typeof legacyVideoFamily>>|undefined;
 t.after(async()=>{await server?.close();await ordinary?.close();await rm(f.base,{recursive:true,force:true});});
 await restoreWorkspaceBackup({directory:f.backup,destination:f.destination});
 const before=await dataFileSnapshot(f.destination,[]);
 await assert.rejects(startServer({dataDir:f.destination,port:0}),{code:'VALIDATION_ERROR',status:400});
 assert.deepEqual(await dataFileSnapshot(f.destination,[]),before,'production refuses the historical root without changing any cold tree byte');
 const token='synthetic-video-restored-family-token';ordinary=await legacyVideoFamily(path.join(f.base,'ordinary-video-control'),token);
 assert.equal(ordinary.restored,null);assert.equal((await fetch(ordinary.url+'/api/video-providers/settings',{headers:{Authorization:`Bearer ${token}`}})).status,200,'the ordinary negative control reaches the real video handler');
 server=await legacyVideoFamily(f.destination,token);assert.ok(server.restored);
 for(const route of ['/api/video-providers/settings','/api/video-providers/settings/','/api/video-providers/unknown']){const response:Response=await fetch(server.url+route,{headers:{Authorization:`Bearer ${server.token}`}});assert.equal(response.status,409);assert.equal((await response.json() as {error:{code:string}}).error.code,'RESTORE_OPERATION_UNAVAILABLE');}
 await assert.rejects(access(path.join(f.destination,'video-settings')));
});

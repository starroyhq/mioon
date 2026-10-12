import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {readFileSync} from 'node:fs';
import {createLocalDeliveryHttp} from '../apps/server/src/local-delivery-http.ts';
import {LOCAL_DELIVERY_LIMITS} from '@mioon/contracts/local-delivery';
import {LocalDeliveryError} from '@mioon/business/local-delivery';

function fixture(){
  const calls=[],value={supported:false,reason:'RESTORED_WORKSPACE_UNSUPPORTED'};
  const delivery=Object.fromEntries(['get','put','discard','prepare','execute','recover'].map(method=>[method,input=>{calls.push({method,input});return ['execute','recover'].includes(method)?Promise.resolve({envelope:value,response:null}):value;}]));
  const handler=createLocalDeliveryHttp({delivery});
  async function request(route,{method='GET',input,raw,headers={},chunks}={}){
    const payload=raw??(input===undefined?'':JSON.stringify(input)),req=Readable.from(chunks??[Buffer.from(payload)]);
    Object.assign(req,{method,url:route,headers:{'content-type':'application/json',...headers}});
    let status,body;const responseHeaders={};const res={headersSent:false,destroyed:false,writableEnded:false,
      setHeader(name,value){responseHeaders[name.toLowerCase()]=value;},writeHead(code,values){status=code;this.headersSent=true;for(const [name,value]of Object.entries(values))responseHeaders[name.toLowerCase()]=value;},end(value){body=JSON.parse(value);this.writableEnded=true;},destroy(){this.destroyed=true;}};
    const handled=await handler(req,res,new URL(route,'http://127.0.0.1'));return {handled,status,body,headers:responseHeaders};
  }
  return {calls,delivery,request};
}
test('narrow local routes use fixed methods and GET never invokes execution',async()=>{
  const f=fixture(),projectId='e2d2c38d-56ae-4ec8-8391-ff763086ff1c';
  const read=await f.request(`/api/local-delivery?projectId=${projectId}`);assert.equal(read.status,200);assert.equal(read.headers['cache-control'],'no-store');assert.deepEqual(f.calls,[{method:'get',input:{projectId}}]);
  for(const [route,method,service]of [['draft','PUT','put'],['draft','DELETE','discard'],['prepare','POST','prepare'],['execute','POST','execute'],['recover','POST','recover']]){
    const response=await f.request(`/api/local-delivery/${route}`,{method,input:{test:service}});assert.equal(response.status,200);assert.deepEqual(f.calls.at(-1),{method:service,input:{test:service}});
  }
  const before=f.calls.length;assert.equal((await f.request('/api/local-delivery/execute')).status,405);assert.equal((await f.request('/api/local-delivery/settle',{method:'POST',input:{}})).status,404);assert.equal((await f.request('/api/local-delivery/execute',{method:'PUT',input:{}})).status,405);assert.equal(f.calls.length,before);assert.equal((await f.request('/api/unrelated')).handled,false);
});
test('bounded query and body rejection occurs before service invocation',async()=>{
  const f=fixture();
  for(const route of ['/api/local-delivery','/api/local-delivery?projectId=a&projectId=b','/api/local-delivery?projectId=a&path=secret'])assert.equal((await f.request(route)).status,400);
  for(const options of [{raw:'{'},{raw:'{}',headers:{'content-type':'text/plain'}},{raw:'{}',headers:{'content-encoding':'gzip'}},{raw:'{}',headers:{'content-length':'-1'}},{chunks:[Buffer.from([0xff])]}])assert.equal((await f.request('/api/local-delivery/prepare',{method:'POST',...options})).status,400);
  assert.equal((await f.request('/api/local-delivery/prepare?operation=project.delete',{method:'POST',input:{}})).status,400);
  for(const options of [{raw:'{}',headers:{'content-length':String(LOCAL_DELIVERY_LIMITS.httpBytes+1)}},{chunks:[Buffer.alloc(LOCAL_DELIVERY_LIMITS.httpBytes),Buffer.from('x')]}])assert.equal((await f.request('/api/local-delivery/execute',{method:'POST',...options})).status,413);
  assert.equal((await f.request('/api/local-delivery?projectId='+ 'x'.repeat(LOCAL_DELIVERY_LIMITS.urlBytes))).status,413);assert.equal(f.calls.length,0);
});
test('opaque errors do not disclose raw storage messages or fabricate not-applied proof',async()=>{
  const f=fixture();f.delivery.execute=async()=>{throw Error('/PRIVATE raw storage credentials');};
  const result=await f.request('/api/local-delivery/execute',{method:'POST',input:{}});assert.equal(result.status,503);assert.equal(result.body.error.code,'LOCAL_DELIVERY_STORAGE_UNAVAILABLE');assert.deepEqual(result.body.error.details,{});assert.equal(JSON.stringify(result).includes('PRIVATE'),false);assert.equal(result.body.error.retryable,false);
  f.delivery.execute=async()=>{throw new LocalDeliveryError('LOCAL_DELIVERY_CONFLICT');};assert.equal((await f.request('/api/local-delivery/execute',{method:'POST',input:{}})).status,409);
});
test('execution response cap preserves the existing 4 MiB render boundary and rejects oversized transport payloads',async()=>{
  const f=fixture();f.delivery.execute=async()=>({envelope:{supported:true},response:'x'.repeat(LOCAL_DELIVERY_LIMITS.executeResponseBytes)});
  assert.equal((await f.request('/api/local-delivery/execute',{method:'POST',input:{}})).status,503);
  assert.equal(LOCAL_DELIVERY_LIMITS.executeResponseBytes,4*1024*1024+12*1024);
});
test('production route is placed behind existing Host/Origin and authentication checks, absent from RPC and Agent declarations',()=>{
  const server=readFileSync(new URL('../apps/server/src/index.mjs',import.meta.url),'utf8');
  const route=server.indexOf('await localDeliveryHttp(req, res, url)');assert.ok(route>0);assert.ok(server.indexOf('ORIGIN_REJECTED')<route);assert.ok(server.indexOf('if (!auth(req))')<route);
  const contracts=readFileSync(new URL('../packages/contracts/src/index.mjs',import.meta.url),'utf8');assert.equal(contracts.includes("'local-delivery'"),false);
  const mcp=readFileSync(new URL('../apps/mcp/src/index.mjs',import.meta.url),'utf8');assert.equal(mcp.includes('local-delivery'),false);
});

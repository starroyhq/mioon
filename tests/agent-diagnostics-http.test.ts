import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startServer} from '../apps/server/src/index.ts';
import {inspectAgentTaskCatalog} from '../apps/server/src/agent-diagnostics-http.ts';
import type {AgentTaskToolDefinition} from '../packages/business/src/agent/task-tools-v2.ts';

test('agent doctor authenticates, reports safe settings and full catalog without model requests',async t=>{
 const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-agent-doctor-'));let models=0;
 const server=await startServer({dataDir:root,port:0,taskGatewayV2:async function*(){models++;throw Error('must not call a model');}});
 t.after(async()=>{await server.close();await rm(root,{recursive:true,force:true});});
 const request=(route='/api/agent/diagnostics',options:RequestInit={})=>fetch(server.url+route,{...options,headers:{authorization:`Bearer ${server.token}`,...options.headers}});
 assert.equal((await fetch(server.url+'/api/agent/diagnostics')).status,401);
 assert.equal((await request(undefined,{headers:{origin:'https://hostile.invalid'}})).status,403);
 const hostileHost=await new Promise<number|undefined>((resolve,reject)=>{http.get(server.url+'/api/agent/diagnostics',{headers:{host:'hostile.invalid',authorization:`Bearer ${server.token}`}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});assert.equal(hostileHost,403);
 const response=await request();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 const value=await response.json() as {ok:boolean;data:{version:number;settings:{secret:{configured:boolean};revision:number};catalog:{count:number;valid:boolean;issues:unknown[]};verification:string;authorization:{scopes:string[]}}};
 assert.equal(value.ok,true);assert.equal(value.data.version,1);assert.equal(value.data.settings.secret.configured,false);assert.ok(value.data.catalog.count>80);assert.equal(value.data.catalog.valid,true);assert.deepEqual(value.data.catalog.issues,[]);assert.deepEqual(value.data.authorization.scopes,[]);assert.equal(value.data.verification,'not_tested');
 assert.doesNotMatch(JSON.stringify(value),/apiKey|encrypted|SYNTHETIC/u);
 for(const route of ['/api/agent/diagnostics?projectId=bad','/api/agent/diagnostics?projectId=x&projectId=y','/api/agent/diagnostics?live=true'])assert.equal((await request(route)).status,400);
 assert.equal((await request('/api/agent/diagnostics?projectId=00000000-0000-4000-8000-000000000000')).status,404);
 assert.equal((await request(undefined,{method:'POST'})).status,405);
 const rpc=await request('/api/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'agent.diagnostics',input:{}})});assert.equal(rpc.status,404);assert.equal(models,0);
});
test('catalog diagnostics report fixed issues without echoing schema values or exceptions',()=>{
 const definition:AgentTaskToolDefinition={name:'mioon_synthetic',operation:'synthetic',description:'synthetic',parameters:{type:'object',properties:{value:{$ref:'#/PRIVATE'}}},risk:'read_only',receipt:'observation',recovery:'read',undo:'unavailable'};
 const result=inspectAgentTaskCatalog({list:()=>[definition,definition]});assert.equal(result.valid,false);assert.equal(result.count,2);assert.deepEqual(result.issues.map(issue=>issue.code),['TOOL_SCHEMA_INVALID','TOOL_NAME_INVALID','TOOL_SCHEMA_INVALID']);assert.doesNotMatch(JSON.stringify(result),/PRIVATE/u);
 assert.deepEqual(inspectAgentTaskCatalog(undefined),{count:0,valid:false,issues:[{code:'TOOL_CATALOG_UNAVAILABLE'}]});
});

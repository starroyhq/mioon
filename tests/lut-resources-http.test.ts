import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {startServer} from '@mioon/server';import {createClient} from '@mioon/client';
import {READ_TOOL_DEFINITIONS} from '../packages/business/src/agent/read-tool-policy.ts';
const source='LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
test('actual authenticated HTTP shared client imports, replays, lists and inspects without media authority',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mioon-lut-http-')),token='synthetic-lut-resource-http-token';
 const service=await startServer({dataDir:path.join(root,'data'),distDir:path.join(root,'unused-dist'),port:0,token});
 t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
 const client=createClient({env:{MIOON_BASE_URL:service.url,MIOON_TOKEN:token}}),project=await client.rpc('project.create',{name:'LUT HTTP'}) as {id: string};
 const input={projectId:project.id,requestId:'http-import-original',name:'local.cube',dataBase64:Buffer.from(source).toString('base64')};
 const saved=await client.rpc('lut.import',input) as {resource: {id: string}};assert.deepEqual(await client.rpc('lut.import',input),saved);
 assert.deepEqual((await client.rpc('lut.list',{projectId:project.id}) as {items: unknown[]}).items,[saved.resource]);
 assert.deepEqual((await client.rpc('lut.inspect',{projectId:project.id,lutId:saved.resource.id}) as {resource: unknown}).resource,saved.resource);
 await assert.rejects(client.rpc('lut.import',{...input,name:'other.cube'}),{code:'IDEMPOTENCY_CONFLICT'});
 assert.deepEqual(await client.rpc('asset.list',{projectId:project.id}),[]);
 const media=await fetch(service.url+'/media/'+saved.resource.id,{headers:{authorization:'Bearer '+token}});assert.equal(media.status,404);
 const unauthorized=await fetch(service.url+'/api/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'lut.list',input:{projectId:project.id}})});assert.equal(unauthorized.status,401);
 assert.equal(READ_TOOL_DEFINITIONS.some(tool=>tool.name.includes('lut')),false);
});

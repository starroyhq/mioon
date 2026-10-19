import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '../apps/server/src/index.ts';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createClient} from '../packages/client/src/index.ts';
import {mediaEnvironment} from '../packages/business/src/media-environment.ts';

const repo=fileURLToPath(new URL('..',import.meta.url));
const token='timeline-recovery-public-synthetic-token';
const environment=extra=>({...mediaEnvironment(),MIOON_ENABLE_LIVE_PROVIDER:'0',...extra});
async function command(args,env){
 const child=spawn(process.execPath,[path.join(repo,'apps/cli/src/index.ts'),...args],{cwd:repo,env:environment(env),stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';for(const [stream,append] of [[child.stdout,b=>stdout+=b],[child.stderr,b=>stderr+=b]])stream.setEncoding('utf8').on('data',b=>{append(b);if(stdout.length+stderr.length>1024*1024)child.kill('SIGKILL');});
 const timer=setTimeout(()=>child.kill('SIGKILL'),15000);let code,signal;try{[code,signal]=await once(child,'close');}finally{clearTimeout(timer);}
 assert.equal(signal,null,stderr);assert.ok(!stdout.includes(token)&&!stderr.includes(token));const body=JSON.parse(stdout);assert.equal(code===0,body.ok,stdout+stderr);return body;
}
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-timeline-recovery-'));let backend,proxy,mcp;
 t.after(async()=>{await mcp?.close();if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}await backend?.close();await rm(root,{recursive:true,force:true});});
 const store=openStore(root);let project,foreign,source,timeline;
 try{const services=createServices(store,new Map());project=await services.call('project.create',{name:'Synthetic recovery'});foreign=await services.call('project.create',{name:'Foreign synthetic recovery'});source=store.put('assets',{id:randomUUID(),projectId:project.id,name:'Synthetic image',mimeType:'image/png',relativePath:'media/synthetic.png',sha256:'a'.repeat(64),sizeBytes:100,duration:0,width:16,height:16,hasVideo:true,hasAudio:false,provenance:'user-import',createdAt:new Date().toISOString()});timeline=await services.call('timeline.get',{projectId:project.id});timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:source.id,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:30});}finally{store.close();}
 backend=await startServer({dataDir:root,port:0,token});let fault=null;const requests=[],observed=[];
 proxy=http.createServer(async(req,res)=>{try{const chunks=[];let bytes=0;for await(const b of req){bytes+=b.length;if(bytes>256*1024)throw Error('fixture request cap');chunks.push(b);}const raw=Buffer.concat(chunks).toString();const request=JSON.parse(raw);requests.push(raw);const upstream=await fetch(backend.url+'/api/rpc',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:raw});const text=await upstream.text();observed.push({request,status:upstream.status,text});if(fault&&fault.operation===request.operation){const mode=fault.mode;fault=null;if(mode==='drop'){res.destroy();return;}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,data:{malformed:true}}));return;}res.writeHead(upstream.status,{'content-type':'application/json'});res.end(text);}catch{res.destroy();}});
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const url=`http://127.0.0.1:${proxy.address().port}`,env={MIOON_BASE_URL:url,MIOON_TOKEN:token};
 mcp=new Client({name:'timeline-recovery-tests',version:'1.0.0'},{capabilities:{}});const transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,'apps/mcp/src/index.ts')],cwd:repo,env:environment(env),stderr:'pipe'});transport.stderr?.resume();await mcp.connect(transport);
 const db=fn=>{const connection=new DatabaseSync(path.join(root,'workbench.sqlite'));try{return fn(connection);}finally{connection.close();}};
 const raw=async(operation,input)=>{try{const r=await fetch(url+'/api/rpc',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({operation,input})});return await r.json();}catch{return {ok:false,error:{code:'LOST_TRANSPORT'}};}};
 return {root,project,foreign,source,timeline,requests,observed,db,raw,client:createClient({env}),fault:(operation,mode='drop')=>{fault={operation,mode};},restart:async()=>{await backend.close();backend=await startServer({dataDir:root,port:0,token});},transports:[
  {name:'HTTP',call:raw},
  {name:'CLI',call:(operation,input)=>command([...operation.split('.'),'--input',JSON.stringify(input)],env)},
  {name:'MCP',call:async(operation,input)=>{const r=await mcp.callTool({name:operation.replaceAll('.','_'),arguments:input});const body=JSON.parse(r.content.find(c=>c.type==='text').text);assert.deepEqual(body,r.structuredContent);assert.equal(Boolean(r.isError),!body.ok);return body;}}
 ]};
}
const envelopeError=body=>{assert.equal(body.ok,false);assert.notEqual(body.error.details?.mutationOutcome,'not_applied');return body.error;};

test('real HTTP, CLI and official MCP retain ambiguous lost-commit errors and replay exact bytes after backend recreation',{timeout:120000},async t=>{
 const f=await fixture(t);let timeline=f.timeline;
 for(const transport of f.transports){
  const input={projectId:f.project.id,expectedRevision:timeline.revision,requestId:randomUUID(),clipId:timeline.clips[0].id,patch:{name:`Saved ${transport.name}`}},operation='timeline.clip.update';
  const before=f.requests.length;f.fault(operation);envelopeError(await transport.call(operation,input));assert.equal(f.requests.length,before+1,'no POST retry after loss');
  const committed=JSON.parse(f.observed.at(-1).text);assert.equal(committed.ok,true);const original=committed.data;
  const receipt=f.db(db=>db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(input.requestId));assert.ok(receipt);
  // Fault injection is confined to this owned DB. Restore the exact trusted
  // trigger here; startup correctly refuses incomplete fixed-profile guards.
  const guard=f.db(db=>db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='immutable_timeline_responses'").get());assert.equal(typeof guard?.sql,'string');
  f.db(db=>{db.exec('DROP TRIGGER immutable_timeline_responses');db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run('null',input.requestId);});
  const damaged=envelopeError(await transport.call(operation,input));assert.ok(!JSON.stringify(damaged).includes('Foreign synthetic recovery'));
  f.db(db=>{db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(receipt.response,input.requestId);db.exec(guard.sql);
   assert.deepEqual(db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='immutable_timeline_responses'").get(),guard);
   assert.throws(()=>db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(receipt.response,input.requestId),/timeline request responses are immutable/);});
  f.db(db=>db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(f.foreign.id,JSON.stringify({...f.source,projectId:f.foreign.id}),f.source.id));
  envelopeError(await transport.call(operation,input));
  f.db(db=>db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(f.project.id,JSON.stringify(f.source),f.source.id));
  await f.restart();
  timeline=(await f.raw('timeline.track.add',{projectId:f.project.id,expectedRevision:original.revision,requestId:randomUUID(),kind:'audio',name:'Later edit'})).data;assert.ok(timeline);
  const replay=await transport.call(operation,input);assert.equal(replay.ok,true);assert.deepEqual(replay.data,original);
  assert.deepEqual(f.db(db=>db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(input.requestId)),receipt,'stored receipt bytes unchanged');
  const stale={...input,requestId:randomUUID()};const fresh=await transport.call(operation,stale);assert.equal(fresh.ok,false);assert.equal(fresh.error.code,'REVISION_CONFLICT');assert.equal(fresh.error.details.mutationOutcome,'not_applied');assert.equal(fresh.error.details.requestId,stale.requestId);
  assert.equal(f.db(db=>db.prepare('SELECT count(*) AS n FROM timeline_requests WHERE requestId=?').get(stale.requestId)).n,0);
 }
});

test('real malformed-success transport never auto-retries and exact render/travel receipts survive later states',{timeout:120000},async t=>{
 const f=await fixture(t),projectId=f.project.id;let timeline=f.timeline;
 for(const operation of ['timeline.track.add','timeline.undo','timeline.redo']){
  const input={projectId,expectedRevision:timeline.revision,requestId:randomUUID(),...(operation==='timeline.track.add'?{kind:'audio',name:'Recoverable track'}:{})};
  f.fault(operation,'malformed');const before=f.requests.length;
  await assert.rejects(f.client.rpc(operation,input),error=>error.code==='BACKEND_PROTOCOL_ERROR'&&error.details.submissionMayHaveSucceeded&&error.details.requestId===input.requestId);assert.equal(f.requests.length,before+1);
  const saved=JSON.parse(f.observed.at(-1).text).data;timeline=await f.client.rpc(operation,input);assert.deepEqual(timeline,saved);
 }
 const input={projectId,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export'};f.fault('timeline.render');
 await assert.rejects(f.client.rpc('timeline.render',input),error=>error.details?.submissionMayHaveSucceeded===true);const saved=JSON.parse(f.observed.at(-1).text).data;
 await f.restart();assert.deepEqual(await f.client.rpc('timeline.render',input),saved);assert.equal(f.db(db=>db.prepare('SELECT count(*) AS n FROM exports WHERE id=?').get(saved.id)).n,1);
 assert.equal(f.db(db=>db.prepare('SELECT count(*) AS n FROM jobs').get()).n,0);
});

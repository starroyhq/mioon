import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startServer} from './helpers/test-server.ts';
import {projectApiPath,projectRpcPath} from '../packages/contracts/src/project-file.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

interface Envelope<T>{ok:boolean;data:T;error?:{code:string}}
test('native relink keeps one runtime authority across requests without exposing path minting to HTTP',async t=>{
 const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-native-media-server-'));
 const token='synthetic-native-media-server-token',server=await startServer({dataDir:path.join(root,'app'),port:0,token});
 t.after(async()=>{await server.close();rmSync(root,{recursive:true,force:true});});
 const headers={authorization:`Bearer ${token}`,origin:server.url,'content-type':'application/json'};
 const rpc=async<T>(projectId:string|null,operation:string,input:unknown):Promise<T>=>{
  const response=await fetch(server.url+(projectId?projectRpcPath(projectId):'/api/rpc'),{method:'POST',headers,body:JSON.stringify({operation,input})});
  assert.equal(response.status,200);const body=await response.json() as Envelope<T>;assert.equal(body.ok,true);return body.data;
 };
 const project=await rpc<{id:string}>(null,'project.create',{name:'Native media control'}),projectId=project.id;
 const bytes=png(),asset=await rpc<{id:string;referenceRevision:number}>(projectId,'asset.import',{projectId,name:'image.png',mimeType:'image/png',dataBase64:bytes.toString('base64')});
 const windowId=randomUUID();await server.projectEntries.acquire({projectId,windowId});
 const native=server.projectEntries.nativeRelink;assert.ok(native);
 const external=path.join(root,'external');mkdirSync(external);const sourcePath=path.join(external,'candidate.png');writeFileSync(sourcePath,bytes);
 const ownerToken=randomUUID(),scope={projectId,ownerToken},selection={...scope,assetId:asset.id,expectedReferenceRevision:asset.referenceRevision,sourcePath};
 const first=await native.candidate(selection);assert.equal(first.confirmationRequired,true);
 const cancelled=await native.preview({...scope,candidateToken:first.candidateToken,allowOutside:true});
 await assert.rejects(native.preview({...scope,ownerToken:randomUUID(),candidateToken:first.candidateToken,allowOutside:true}),{code:'ASSET_MEDIA_NATIVE_UNAVAILABLE'});
 await native.discard({...scope,previewToken:cancelled.previewToken});
 const second=await native.candidate(selection);assert.equal(second.confirmationRequired,true,'cancelled preview must not persist an outside grant');
 const preview=await native.preview({...scope,candidateToken:second.candidateToken,allowOutside:true});
 const input={...scope,previewToken:preview.previewToken,requestId:randomUUID()};
 const applied=await native.apply(input);assert.equal(applied.status,'applied');
 assert.deepEqual(await native.apply(input),applied,'same original request ID proves the result without applying again');
 if(applied.status==='applied'){assert.equal(applied.assets[0]!.referenceRevision,asset.referenceRevision+1);assert.deepEqual(applied.confirmedDirectories,[external]);}
 const response=await fetch(server.url+projectApiPath(projectId,'asset-media','trusted'),{method:'POST',headers:{...headers,'x-mioon-user-action':'asset-media'},body:JSON.stringify({operation:'asset.media.native.candidate',input:selection})});
 assert.equal(response.status,404,'browser HTTP cannot mint native path/owner capabilities');
 const stopped=new AbortController();stopped.abort();await assert.rejects(native.candidate({...selection,expectedReferenceRevision:asset.referenceRevision+1},{signal:stopped.signal}),{name:'AbortError'});
 await native.discard(scope);await assert.rejects(native.candidate({...selection,expectedReferenceRevision:asset.referenceRevision+1}),{code:'ASSET_MEDIA_NATIVE_UNAVAILABLE'});
 await server.projectEntries.release({windowId});
 await server.close();
 await assert.rejects(native.candidate({...selection,expectedReferenceRevision:asset.referenceRevision+1,ownerToken:randomUUID()}),{code:'PROJECT_HOST_STOPPED'},'a retired server port cannot reopen a project to mint a new selection');
});

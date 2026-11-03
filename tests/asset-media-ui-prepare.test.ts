import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assetMediaPrepareResponseSchema} from '../packages/contracts/src/asset-media.ts';
import {sceneSourceIssue} from '../apps/web/src/scene-detection.ts';
import {lenientFunction} from './helpers/eval-source.ts';
const projectId='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',hash='a'.repeat(64);
const sampled={id,projectId,name:'video.mp4',mimeType:'video/mp4',sha256:null,referenceRevision:1,sizeBytes:42,duration:4,fingerprint:{sizeBytes:42,mtimeMs:1,sampledSha256:'b'.repeat(64),fullSha256:null},hashState:'sampled',url:`/api/projects/${projectId}/media/${id}`};
const full={...sampled,sha256:hash,referenceRevision:2,fingerprint:{...sampled.fingerprint,fullSha256:hash},hashState:'full'};
const source=readFileSync(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
const helper=source.slice(source.indexOf('  async function prepareStrongAsset('),source.indexOf('  async function openSceneDetection('));
function harness({stale=false,malformed=false,changed=false}={}){
 let live=true;const calls:unknown[]=[],refreshes:string[]=[],notices:unknown[]=[],dataRef={current:{assets:[sampled as typeof sampled|typeof full]}};
 const scope={assetMediaPrepareResponseSchema,dataRef,context:()=>({projectId}),isCurrent:()=>live,rpc:async(operation:string,input:unknown)=>{calls.push({operation,input});if(stale)live=false;return {assets:[malformed?{...full,sha256:null}:full]};},refresh:async(project:string)=>{refreshes.push(project);dataRef.current.assets=[changed?{...full,referenceRevision:3}:full];},notify:(value:unknown)=>notices.push(value),readableError:(value:unknown)=>value};
 const prepare=lenientFunction(...Object.keys(scope),helper+';return prepareStrongAsset;')(...Object.values(scope)) as (asset:unknown,purpose:string)=>Promise<unknown>;
 return {prepare,calls,refreshes,notices};
}
test('sampled video remains eligible and actual App prepares full hash before strong source use',async()=>{
 assert.equal(sceneSourceIssue(sampled),null);assert.equal(sceneSourceIssue({...sampled,referenceRevision:undefined}),'type');
 const h=harness();assert.deepEqual(await h.prepare(sampled,'frame'),full);
 assert.deepEqual(h.calls,[{operation:'asset.media.prepare',input:{projectId,assets:[{assetId:id,referenceRevision:1}],purpose:'frame'}}]);assert.deepEqual(h.refreshes,[projectId]);
 const known=harness();assert.deepEqual(await known.prepare(full,'timeline'),full);assert.deepEqual(known.calls,[]);
});
test('source prepare refuses invalid ACK, changed current revision or stale page owner',async()=>{
 for(const options of [{malformed:true},{changed:true},{stale:true}]){
  const h=harness(options);assert.equal(await h.prepare(sampled,'scene'),null);
  if(options.stale)assert.deepEqual(h.refreshes,[]);
 }
 const h=harness();assert.equal(await h.prepare({...sampled,projectId:'33333333-3333-4333-8333-333333333333'},'frame'),null);assert.deepEqual(h.calls,[]);
});

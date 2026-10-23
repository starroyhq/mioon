import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {reverseReviewedMinimaxSdk,reviewedMinimaxSdkSourceDeltas} from './helpers/current-minimax-sdk-delta.ts';

const root=new URL('../',import.meta.url);
const predecessor='feca41646194570deadabb563e2eaaa9c66f86ea';
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const gitSource=(file:string)=>execFileSync('git',['show',`${predecessor}:${file}`],{cwd:root,maxBuffer:1024*1024,timeout:5000});

test('finite MiniMax SDK inverse recovers exactly the fixed PR20 merged input profile without rebasing historical pins',()=>{
  assert.deepEqual(reviewedMinimaxSdkSourceDeltas.map(delta=>delta.path),['packages/contracts/src/generation-input-profiles.ts']);
  const delta=reviewedMinimaxSdkSourceDeltas[0]!,before=gitSource(delta.path),after=readFileSync(new URL(delta.path,root));
  assert.equal(delta.beforeSha256,'092587f46aa7368ae002630766c945492b8bb2465125c20687b9fb12f001b6d1');
  assert.equal(delta.afterSha256,'0b3f2b90986a0082066da21c89407709d3ac6efb03db5817d9f5dc61b7d3dac4');
  assert.equal(sha(before),delta.beforeSha256);assert.equal(sha(after),delta.afterSha256);
  assert.equal(delta.inverse.length,1);
  assert.equal(delta.inverse[0]!.after,delta.inverse[0]!.before.replace("resolution: '768P'","resolution: '2K'"));
  assert.deepEqual(reverseReviewedMinimaxSdk(delta.path,after),before);
  const mapping=JSON.parse(readFileSync(new URL('./fixtures/agent-gain-ts-migration-map.json',import.meta.url),'utf8')).mapping;
  assert.equal(mapping['packages/contracts/src/generation-input-profiles.mjs'].currentSha256,delta.beforeSha256);
});

test('finite MiniMax SDK inverse rejects changed, duplicated, reverted, missing and unknown source bytes',()=>{
  const delta=reviewedMinimaxSdkSourceDeltas[0]!,source=readFileSync(new URL(delta.path,root),'utf8');
  const rejected=(value:string)=>assert.throws(()=>reverseReviewedMinimaxSdk(delta.path,Buffer.from(value)),/Baseline dependency changed/);
  for(const inverse of delta.inverse){
    assert.equal(source.split(inverse.after).length-1,1);
    for(const changed of [source.replace(inverse.after,inverse.after+' '),source.replace(inverse.after,inverse.after+inverse.after),source.replace(inverse.after,inverse.before),source.replace(inverse.after,'')])rejected(changed);
  }
  for(const changed of ['',source.slice(1),source+source,source+'\n',source+'\nexport const bypassSdk=true;\n'])rejected(changed);
  rejected(gitSource(delta.path).toString('utf8'));
});

test('finite MiniMax SDK inverse leaves unlisted dependencies to their unchanged original pin checks',()=>{
  const bytes=Buffer.from('unknown source still reaches its original pin');
  for(const file of ['packages/business/src/providers/minimax.ts','packages/contracts/src/video-providers.ts','packages/contracts/src/index.ts','packages/contracts/src/generation-input-profiles.mjs'])assert.equal(reverseReviewedMinimaxSdk(file,bytes),bytes);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {reverseReviewedWanVideo,reviewedWanVideoSourceDeltas} from './helpers/current-wan-video-delta.ts';
import {reverseReviewedShotSync} from './helpers/current-shot-sync-delta.ts';

const root=new URL('../',import.meta.url);
// The newer shot-sync layer is reversed first, so the Wan inverse sees exactly its accepted bytes.
const reviewed=(file:string)=>reverseReviewedShotSync(file,readFileSync(new URL(file,root)));
const predecessor='2609c57e5865f4cdac4eafbe3383061d4cfe6fc7';
const accepted='fa4fcb3bcee55a27fa81c06fbbfb9922e116805d';
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const gitSource=(commit:string,file:string)=>execFileSync('git',['show',`${commit}:${file}`],{cwd:root,maxBuffer:1024*1024,timeout:5000});

test('finite Wan input-contract inverse recovers the exact fixed PR18 predecessor without rebasing historical pins',()=>{
  assert.deepEqual(reviewedWanVideoSourceDeltas.map(delta=>delta.path),['packages/contracts/src/index.ts']);
  const delta=reviewedWanVideoSourceDeltas[0]!;
  const before=gitSource(predecessor,delta.path),after=gitSource(accepted,delta.path);
  assert.equal(delta.beforeSha256,'5c3f96682bcdaedf235bbd8996b7ec8f642a88e8818fa0cd3304992b60ad4957');
  assert.equal(delta.afterSha256,'c0d172e978f81fa314c6750d73d50c7184a4620c2d1bf5c7120bbe3cad38d56e');
  assert.equal(sha(before),delta.beforeSha256);assert.equal(sha(after),delta.afterSha256);
  assert.equal(delta.inverse.length,3,'only the three reviewed contract hunks are reversible');
  assert.deepEqual(reviewed(delta.path),after);
  assert.deepEqual(reverseReviewedWanVideo(delta.path,after),before);
  // Earlier compatible-video and schema52 pins are still checked by their
  // original harnesses; the new exception must not replace their hashes.
  const map=JSON.parse(readFileSync(new URL('./fixtures/agent-gain-schema52-runtime-map.json',import.meta.url),'utf8'));
  assert.equal(map.mapping['packages/contracts/src/index.mjs'].currentSha256,'5296d7009a373567cfde38dd390416b1e8e126a713e6b6020a019af6b76797d6');
  assert.equal(map.mapping['packages/contracts/src/index.mjs'].typeErasedSha256,'60acde11743ee88d40beff4ce038f664a3864a41dfe298e323c088d329c4cc40');
});

test('finite Wan inverse rejects changed, duplicated, reverted, missing and unknown source bytes',()=>{
  const delta=reviewedWanVideoSourceDeltas[0]!,source=reviewed(delta.path).toString('utf8');
  const assertRejected=(value:string)=>assert.throws(()=>reverseReviewedWanVideo(delta.path,Buffer.from(value)),/Baseline dependency changed/);
  for(const inverse of delta.inverse){
    assert.equal(source.split(inverse.after).length-1,1,'each reviewed hunk occurs exactly once');
    assert.notEqual(inverse.before,inverse.after);
    for(const changed of [
      source.replace(inverse.after,inverse.after+' '),
      source.replace(inverse.after,inverse.after+inverse.after),
      source.replace(inverse.after,inverse.before),
      source.replace(inverse.after,''),
    ])assertRejected(changed);
  }
  for(const changed of ['',source.slice(1),source+source,source+'\n',source+'\nexport const hiddenWorkspaceAuthority=true;\n'])assertRejected(changed);
  assertRejected(gitSource(predecessor,delta.path).toString('utf8'));
});

test('finite Wan inverse leaves every unlisted dependency untouched for its existing pin checks',()=>{
  const bytes=Buffer.from('unreviewed source must still reach its original whole-source check');
  for(const file of ['packages/business/src/services.ts','packages/contracts/src/video-providers.ts','packages/contracts/src/index.mjs'])assert.equal(reverseReviewedWanVideo(file,bytes),bytes);
});

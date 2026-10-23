import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

/** Finite reviewed MiniMax SDK resolution delta over the fixed PR20 merge.
 * Historical pins stay unchanged. Exact whole-source hashes and one unique
 * inverse reject every unrelated change before the earlier pin chain runs. */
export const reviewedMinimaxSdkSourceDeltas=Object.freeze([
{
  "path": "packages/contracts/src/generation-input-profiles.ts",
  "beforeSha256": "092587f46aa7368ae002630766c945492b8bb2465125c20687b9fb12f001b6d1",
  "afterSha256": "0b3f2b90986a0082066da21c89407709d3ac6efb03db5817d9f5dc61b7d3dac4",
  "beforeBytes": 14031,
  "afterBytes": 14029,
  "inverse": [
    {
      "before": "    adapterSource: 'packages/business/src/providers/minimax.ts', inputModes: ['text', 'image'],\n    output: { resolution: '768P', audio: 'model-default' },\n    inputs: roles(0, { ...image, dimensions: { min: 256, max: 5760, matchAspectRatio: true } }),\n",
      "after": "    adapterSource: 'packages/business/src/providers/minimax.ts', inputModes: ['text', 'image'],\n    output: { resolution: '2K', audio: 'model-default' },\n    inputs: roles(0, { ...image, dimensions: { min: 256, max: 5760, matchAspectRatio: true } }),\n"
    }
  ]
}
]);
export function reverseReviewedMinimaxSdk(file:string,bytes:Buffer):Buffer {
  const delta=reviewedMinimaxSdkSourceDeltas.find(entry=>entry.path===file);
  if(!delta)return bytes;
  const label=`Baseline dependency changed: ${file}; reviewed MiniMax SDK resolution delta`;
  const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
  assert.equal(bytes.byteLength,delta.afterBytes,label);
  assert.equal(sha(bytes),delta.afterSha256,label);
  let source=bytes.toString('utf8');
  for(const inverse of delta.inverse){
    assert.ok(inverse.after.length>0,label);
    assert.equal(source.split(inverse.after).length-1,1,label);
    source=source.replace(inverse.after,inverse.before);
  }
  const previous=Buffer.from(source);
  assert.equal(previous.byteLength,delta.beforeBytes,label);
  assert.equal(sha(previous),delta.beforeSha256,label);
  return previous;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {buildComfyWorkflow, hashComfyWorkflow, canonicalComfyJson, validateComfyExecution, buildComfySubmission} from '../packages/business/src/comfy/workflow.ts';
import {COMFY_IMAGE_PROFILE_ID, COMFY_IMAGE_VERSION} from '../packages/contracts/src/comfy-images.ts';

const input = {prompt: '  A fox\nunder the moon. 中文  ', checkpoint: 'sd15/example.safetensors', seed: 123456, outputNonce: '33333333-3333-4333-8333-333333333333'};
function execution() {
  const graph = buildComfyWorkflow(input);
  return {workflowId: COMFY_IMAGE_PROFILE_ID, workflowVersion: 1, comfyVersion: COMFY_IMAGE_VERSION, seed: input.seed,
    promptId: '11111111-1111-4111-8111-111111111111', clientId: '22222222-2222-4222-8222-222222222222',
    outputNonce: input.outputNonce, filenamePrefix: `mioon_${input.outputNonce}`, graph, graphHash: hashComfyWorkflow(graph)};
}
type Execution = ReturnType<typeof execution>;
test('fixed graph has seven nodes, six built-in classes and exact user prompt, seed and nonce', () => {
  const value = execution();
  assert.equal(validateComfyExecution(value, {prompt: input.prompt, checkpoint: input.checkpoint}), value);
  assert.deepEqual(Object.keys(value.graph), ['1','2','3','4','5','6','7']);
  assert.equal(new Set(Object.values(value.graph).map(node => node.class_type)).size, 6);
  assert.equal(value.graph['3'].inputs.text, input.prompt);
  assert.equal(value.graph['4'].inputs.text, '');
  assert.deepEqual(value.graph['2'].inputs, {width:512,height:512,batch_size:1});
  assert.equal(value.graph['7'].inputs.filename_prefix, `mioon_${input.outputNonce}`);
  assert.deepEqual(buildComfyWorkflow(input), buildComfyWorkflow(input));
  const payload = buildComfySubmission(value);
  assert.deepEqual(Object.keys(payload).sort(), ['client_id','extra_data','prompt','prompt_id']);
  assert.equal(payload.prompt_id, value.promptId); assert.equal(payload.client_id, value.clientId);
  assert.equal(payload.extra_data.mioon.graphHash, value.graphHash);
  assert.equal(payload.extra_data.mioon.outputNonce, value.outputNonce);
  assert.equal(payload.prompt, value.graph);
});
test('workflow hash is canonical and rejects non-JSON, cycles, oversize and prototype keys', () => {
  assert.equal(hashComfyWorkflow({b:1,a:2}), hashComfyWorkflow({a:2,b:1}));
  assert.notEqual(hashComfyWorkflow({a:1}), hashComfyWorkflow({a:2}));
  const cycle: Record<string, unknown> = {}; cycle.a = cycle;
  for (const value of [cycle, {a:undefined}, {a:NaN}, {a:Infinity}, {a:-0}, {a:BigInt(2)}, {a:new Date()}, JSON.parse('{"__proto__":{}}'), {a:'x'.repeat(32769)}]) assert.throws(() => canonicalComfyJson(value), {code:'COMFY_INVALID_REQUEST'});
});
test('any graph parameter, edge, node class or hidden input mutation is rejected even with a new hash', () => {
  for (const mutate of [
    (v: Execution) => { v.graph['2'].inputs.width = 1024; }, (v: Execution) => { v.graph['2'].inputs.batch_size = 2; },
    (v: Execution) => { v.graph['3'].inputs.clip = ['1',0]; }, (v: Execution) => { v.graph['4'].inputs.text = 'secret'; },
    (v: Execution) => { v.graph['5'].inputs.steps = 21; }, (v: Execution) => { v.graph['5'].inputs.sampler_name = 'dpmpp_2m'; },
    (v: Execution) => { v.graph['7'].class_type = 'PartnerNode'; }, (v: Execution) => { v.graph['7'].inputs.filename_prefix = '../outside'; },
    (v: Execution) => { (v.graph as unknown as Record<string, unknown>)['8'] = {class_type:'LoadImage',inputs:{image:'private.png'}}; },
    (v: Execution) => { v.graph['5'].inputs.hidden = 'unreviewed'; }, (v: Execution) => { v.seed++; }, (v: Execution) => { v.filenamePrefix += '_other'; },
  ]) {
    const value = execution(); mutate(value); value.graphHash = hashComfyWorkflow(value.graph);
    assert.throws(() => validateComfyExecution(value), {code:'COMFY_INVALID_REQUEST'});
  }
  const value = execution(); value.graph['3'].inputs.text = 'changed'; value.graphHash = hashComfyWorkflow(value.graph);
  assert.throws(() => validateComfyExecution(value, {prompt:input.prompt}), {code:'COMFY_INVALID_REQUEST'});
  assert.throws(() => validateComfyExecution(execution(), {checkpoint:'other.safetensors'}), {code:'COMFY_INVALID_REQUEST'});
});
test('identities, seed, checkpoint and prompt must already be safe frozen core input', () => {
  for (const seed of [-1, 1.5, Number.MAX_SAFE_INTEGER+1, '1', undefined]) assert.throws(() => buildComfyWorkflow({...input,seed}), {code:'COMFY_INVALID_REQUEST'});
  for (const outputNonce of ['../bad','33333333-3333-4333-8333-33333333333A','33333333-3333-1333-8333-333333333333']) assert.throws(() => buildComfyWorkflow({...input,outputNonce}), {code:'COMFY_INVALID_REQUEST'});
  for (const checkpoint of ['../model','/model','C:\\model','model%2fescape','a/../b','a?secret','a\u0000b']) assert.throws(() => buildComfyWorkflow({...input,checkpoint}), {code:'COMFY_INVALID_REQUEST'});
  for (const prompt of ['', '  ', 'a\u0000b', 'x'.repeat(2001)]) assert.throws(() => buildComfyWorkflow({...input,prompt}), {code:'COMFY_INVALID_REQUEST'});
  const value = execution(); value.graphHash = '0'.repeat(64);
  assert.throws(() => validateComfyExecution(value), {code:'COMFY_INVALID_REQUEST'});
});

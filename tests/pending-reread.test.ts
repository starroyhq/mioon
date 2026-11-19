import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldReread,rereadProjectPending,rereadEvidence,PENDING_REREAD_TIMEOUT_MS} from '../apps/web/src/pending-reread.ts';
import type {PendingEntry} from '../apps/web/src/submissions.ts';

const PROJECT = '92000000-0000-4000-8000-000000000001';
const entry = (operation: string,requestId: string,extra: Record<string, unknown> = {}): PendingEntry =>
  ({projectId: PROJECT,key: `${operation}:${requestId}`,operation,input: {projectId: PROJECT,requestId,...extra}} as PendingEntry);
const current = () => true;
const applied = async () => ({applied: true,operation: 'any.operation'});

test('only receipt-backed lifecycle operations are re-read; paid, retry, export and render are not', () => {
  for (const operation of ['generation.submit','job.retry','export.create','timeline.render']) assert.equal(shouldReread(entry(operation,'request-1')),false,operation);
  for (const operation of ['shot.update','node.create','version.select','asset.range.set','asset.disposition.set','asset.annotation.set',
    'subject.create','subject.binding.set','reference.attach','reference.detach','timeline.clip.update','timeline.subtitle.add','timeline.format.set',
    'timeline.loudness.apply','project.version.save','project.version.restore'])
    assert.equal(shouldReread(entry(operation,'request-1')),true,operation);
});

test('a matching receipt yields applied evidence and an absent one keeps the request unknown', async () => {
  const entries = [entry('shot.update','request-applied'),entry('asset.annotation.set','request-missing')];
  const reads: string[] = [];
  const results = await rereadProjectPending(PROJECT,{entries,current,readOutcome: async ({requestId}) => {
    reads.push(requestId);
    return requestId === 'request-applied' ? {applied: true,operation: 'shot.update'} : {applied: false,operation: null};
  }});
  assert.deepEqual(reads,['request-applied','request-missing']);
  assert.deepEqual(results.map(result => [result.entry.input.requestId,result.verdict]),[['request-applied','applied'],['request-missing','unknown']]);
  const evidence = rereadEvidence(results);
  assert.deepEqual([...evidence.requestOutcomes!.entries()],[['request-applied',{applied: true,operation: 'shot.update'}]]);
});

test('non-read operations are never sent to the receipt route', async () => {
  let reads = 0;
  const entries = [entry('generation.submit','request-generate'),entry('job.retry','request-retry'),entry('export.create','request-export'),
    entry('timeline.render','request-render'),entry('shot.create','request-shot')];
  const results = await rereadProjectPending(PROJECT,{entries,current,readOutcome: async () => { reads++; return applied(); }});
  assert.equal(reads,1);
  assert.deepEqual(results.map(result => result.entry.input.requestId),['request-shot']);
});

test('a failed or timed-out read skips only its own entry and keeps the pass bounded', async () => {
  const entries = [entry('shot.update','request-fails'),entry('shot.update','request-times-out'),entry('shot.update','request-applied')];
  const results = await rereadProjectPending(PROJECT,{entries,current,timeoutMs: 20,readOutcome: async ({requestId}) => {
    if (requestId === 'request-fails') throw new Error('storage unavailable');
    if (requestId === 'request-times-out') return new Promise(()=>{});
    return applied();
  }});
  assert.deepEqual(results.map(result => result.entry.input.requestId),['request-applied']);
  assert.equal(PENDING_REREAD_TIMEOUT_MS,5000);
});

test('a superseded project epoch discards results and stops the pass', async () => {
  let live = true, reads = 0;
  const entries = [entry('shot.update','request-one'),entry('shot.update','request-two')];
  const results = await rereadProjectPending(PROJECT,{entries,current: () => live,readOutcome: async () => { reads++; if (reads === 1) live = false; return applied(); }});
  assert.deepEqual(results,[]);
  assert.equal(reads,1);
});

test('an aborted signal stops before the next read and returns nothing from the aborted read', async () => {
  const controller = new AbortController();
  const reads: string[] = [];
  const results = await rereadProjectPending(PROJECT,{entries: [entry('shot.update','request-one'),entry('shot.update','request-two')],
    current, signal: controller.signal, readOutcome: async ({requestId}) => { reads.push(requestId); controller.abort(); return applied(); }});
  assert.deepEqual(reads,['request-one']);
  assert.deepEqual(results,[]);
});

test('entries without a valid retained request ID are never sent', async () => {
  let reads = 0;
  const invalid = [{projectId: PROJECT,key: 'shot:none',operation: 'shot.update',input: {}}] as unknown as PendingEntry[];
  assert.deepEqual(await rereadProjectPending(PROJECT,{entries: invalid,current,readOutcome: async () => { reads++; return applied(); }}),[]);
  assert.equal(reads,0);
});

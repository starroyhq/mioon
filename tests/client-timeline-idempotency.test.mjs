import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareSubmission,readPending,clearPending,pendingForProject,reconcilePending} from '../apps/web/src/submissions.js';
class SessionStore{
 values=new Map();get length(){return this.values.size;}key(n){return [...this.values.keys()][n]??null;}getItem(k){return this.values.get(k)??null;}setItem(k,v){this.values.set(k,String(v));}removeItem(k){this.values.delete(k);}
}
function fixture(t){const prior=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');const storage=new SessionStore();Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:storage});t.after(()=>{if(prior)Object.defineProperty(globalThis,'sessionStorage',prior);else delete globalThis.sessionStorage;});return storage;}
const request=(operation='timeline.clip.update',key='timeline:mutation')=>({projectId:'project-v2',key,operation,createdAt:'2026-10-09T10:00:00.000Z',input:{projectId:'project-v2',expectedRevision:7,requestId:'timeline-original-request',clipId:'clip-original',patch:{trackId:'track-two',startFrame:47,durationFrames:82,sourceInFrame:11,rect:{x:100,y:200,width:300,height:400},gain:0.5}}});
test('timeline mutations retain exact frame, rect, revision and request identity across a lost response',t=>{fixture(t);const original=request();prepareSubmission(original);const replacement=request('timeline.track.add');replacement.input={...replacement.input,expectedRevision:8,requestId:'must-never-replace'};assert.deepEqual(prepareSubmission(replacement),original);assert.deepEqual(readPending('project-v2','timeline:mutation'),original);});
test('fetching a newer timeline cannot prove an uncertain mutation succeeded; only explicit replay clears it',t=>{fixture(t);const original=request();prepareSubmission(original);reconcilePending('project-v2',{timeline:{revision:99,clips:[]},jobs:[],exports:[]});assert.deepEqual(pendingForProject('project-v2'),[original]);clearPending('project-v2','timeline:mutation');assert.equal(pendingForProject('project-v2').length,0);});
test('all supported timeline mutation operations and render accept durable recovery records',t=>{fixture(t);for(const [i,op] of ['timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update','timeline.clip.remove','timeline.seed','timeline.render','timeline.undo','timeline.redo'].entries()){const entry=request(op,`timeline:${i}`);entry.input.requestId+=i;assert.deepEqual(prepareSubmission(entry),entry);}assert.equal(pendingForProject('project-v2').length,9);});
test('preview and export recovery identities remain separate and reconcile against durable export records',t=>{fixture(t);const preview=request('timeline.render','timeline:render:preview');preview.input={projectId:'project-v2',expectedRevision:7,requestId:'preview-original',purpose:'preview'};const exported=request('timeline.render','timeline:render:export');exported.input={...preview.input,requestId:'export-original',purpose:'export'};prepareSubmission(preview);prepareSubmission(exported);reconcilePending('project-v2',{exports:[{requestId:preview.input.requestId}],jobs:[]});assert.equal(readPending('project-v2',preview.key),null);assert.deepEqual(readPending('project-v2',exported.key),exported);});

test('undo and redo replay the exact original request even after a changed history cursor', t => {
  fixture(t);
  for (const operation of ['timeline.undo', 'timeline.redo']) {
    const original = { projectId: 'project-v2', key: 'timeline:mutation', operation, createdAt: '2026-10-09T10:00:00.000Z', input: { projectId: 'project-v2', expectedRevision: 7, requestId: `${operation}-original` } };
    prepareSubmission(original);
    reconcilePending('project-v2', { timeline: { revision: 8 }, timelineHistory: { cursor: 0, length: 3 } });
    assert.deepEqual(prepareSubmission({ ...original, operation: 'timeline.clip.add', input: { ...original.input, expectedRevision: 8, requestId: 'must-not-replace' } }), original);
    assert.deepEqual(readPending('project-v2', 'timeline:mutation'), original);
    clearPending('project-v2', 'timeline:mutation');
  }
});

test('read-only history requests are never accepted as durable mutations', t => {
  fixture(t);
  assert.throws(() => prepareSubmission(request('timeline.history.get')), /记录损坏/);
});

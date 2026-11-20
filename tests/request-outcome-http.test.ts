import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createRequestOutcomeHttp} from '../apps/server/src/request-outcome-http.ts';
import {readRequestOutcome} from '@mioon/business/request-outcome';
import {createRequestOutcomeClient} from '../apps/web/src/request-outcome-client.ts';
import {createSequenceEditing, readSequenceEditContext} from '../packages/business/src/sequence-edit.ts';
import {prepareSequenceEditHistory, sequenceEditInputDigest, writeSequenceEditFailure} from '../packages/business/src/format5-editor-history.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {createChainWorld} from './helpers/sequence-edit-double.ts';
import type {SequenceEditEnvelope} from '../packages/contracts/src/sequence-edit.ts';

const PROJECT = '92000000-0000-4000-8000-000000000001';
const OTHER = '92000000-0000-4000-8000-000000000002';

const RECEIPT_TABLES = `
CREATE TABLE mutation_requests(requestId TEXT PRIMARY KEY,operation TEXT NOT NULL,projectId TEXT NOT NULL,canonicalInput TEXT NOT NULL,response TEXT NOT NULL);
CREATE TABLE asset_range_requests(requestId TEXT PRIMARY KEY,operation TEXT NOT NULL,projectId TEXT NOT NULL,canonicalInput TEXT NOT NULL,response TEXT NOT NULL);
CREATE TABLE asset_disposition_requests(requestId TEXT PRIMARY KEY,operation TEXT NOT NULL,projectId TEXT NOT NULL,canonicalInput TEXT NOT NULL,response TEXT NOT NULL);
CREATE TABLE asset_annotation_requests(requestId TEXT PRIMARY KEY,operation TEXT NOT NULL,projectId TEXT NOT NULL,canonicalInput TEXT NOT NULL,response TEXT NOT NULL);
CREATE TABLE subject_requests(requestId TEXT PRIMARY KEY,operation TEXT NOT NULL,projectId TEXT NOT NULL,canonicalInput TEXT NOT NULL,response TEXT NOT NULL);
CREATE TABLE task_disposition_requests(requestId TEXT PRIMARY KEY,operation TEXT NOT NULL,projectId TEXT NOT NULL,digest TEXT NOT NULL,response TEXT NOT NULL);
CREATE TABLE project_mutation_requests(requestId TEXT PRIMARY KEY,projectId TEXT NOT NULL,digest TEXT NOT NULL,response TEXT NOT NULL);
CREATE TABLE project_version_requests(projectId TEXT NOT NULL,requestId TEXT NOT NULL,operation TEXT NOT NULL,inputDigest TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(projectId,requestId));
CREATE TABLE timeline_format_requests(requestId TEXT PRIMARY KEY,projectId TEXT NOT NULL,input TEXT NOT NULL);
CREATE TABLE timeline_requests(requestId TEXT PRIMARY KEY,requestHash TEXT NOT NULL,response TEXT NOT NULL);
CREATE TABLE reference_requests(requestId TEXT PRIMARY KEY,requestHash TEXT NOT NULL,response TEXT NOT NULL);
`;
// The production history-13 shape of `main.editor_requests` (bounded checks are
// enforced by the real schema; here only the columns the read path uses).
const EDITOR_REQUESTS = `
CREATE TABLE editor_requests(requestId TEXT PRIMARY KEY NOT NULL,projectId TEXT NOT NULL,
 operation TEXT NOT NULL,inputDigest TEXT NOT NULL,response TEXT NOT NULL,issuedAt INTEGER NOT NULL,createdAt TEXT NOT NULL);
`;
function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(RECEIPT_TABLES);
  return db;
}
/** A format-5 project database: the 11 format-3/4 tables plus the editor
 * receipt table only the format-5 history schema creates. */
function format5Database(): DatabaseSync {
  const db = database();
  db.exec(EDITOR_REQUESTS);
  return db;
}
const EDITOR_EPOCH = '93000000-0000-4000-8000-000000000001';
/** One schema-valid `SequenceEditReceipt` as `sequence.commit` stores it. */
function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,requestId: 'request-edit-1',inputDigest: 'a'.repeat(64),projectId: PROJECT,
    actionId: '93000000-0000-4000-8000-000000000002',operation: 'timeline.clip.split',originSide: 'timeline',
    status: 'applied',affected: {nodes: 0,edges: 0,mainTrackClips: 1,otherTrackItems: 0,subtitleCues: 0},
    history: {epoch: EDITOR_EPOCH,position: 1,revision: 2,undo: null,redo: null},
    contentRevision: 1,timelineRevision: 2,syncRevision: 1,...overrides,
  };
}
function insertReceipt(db: DatabaseSync, requestId: string, response: unknown, projectId = PROJECT): void {
  db.prepare('INSERT INTO editor_requests(requestId,projectId,operation,inputDigest,response,issuedAt,createdAt) VALUES(?,?,?,?,?,?,?)')
    .run(requestId,projectId,'timeline.clip.split','a'.repeat(64),
      typeof response === 'string' ? response : JSON.stringify(response),Date.now(),'2026-01-01T00:00:00.000Z');
}
interface HttpResponse {handled: boolean;status?: number;body: Record<string, unknown>;headers: Record<string, unknown>}
interface MockResponse {headersSent: boolean;destroyed: boolean;writableEnded: boolean;setHeader(name: string,value: unknown): void;writeHead(code: number,values: Record<string, unknown>): void;end(value: string): void;destroy(): void}
function http(db: DatabaseSync) {
  const handler = createRequestOutcomeHttp({db});
  return async function request(route: string,{method = 'GET',address = {projectId: PROJECT} as {projectId: string}|null}: {method?: string;address?: {projectId: string}|null} = {}): Promise<HttpResponse> {
    const req = Readable.from([]) as unknown as import('node:http').IncomingMessage;
    Object.assign(req,{method,url: route,headers: {}});
    const headers: Record<string, unknown> = {}; let status: number|undefined; let body: Record<string, unknown> = {};
    const res: MockResponse = {headersSent: false,destroyed: false,writableEnded: false,
      setHeader(name,value) { headers[name.toLowerCase()] = value; },
      writeHead(code,values) { status = code; this.headersSent = true; Object.assign(headers,Object.fromEntries(Object.entries(values).map(([key,value])=>[key.toLowerCase(),value]))); },
      end(value) { body = JSON.parse(value) as Record<string, unknown>; this.writableEnded = true; },
      destroy() { this.destroyed = true; }};
    const handled = await handler(req,res as unknown as import('node:http').ServerResponse,new URL(route,'http://127.0.0.1'),address ?? undefined);
    return {handled,status,body,headers};
  };
}

test('an empty or foreign receipt table never proves an outcome', () => {
  const db = database();
  try {
    assert.deepEqual(readRequestOutcome(db,PROJECT,'request-0001'),{applied: false,operation: null});
    db.prepare('INSERT INTO mutation_requests VALUES(?,?,?,?,?)').run('request-0001','shot.update',OTHER,'{}','{}');
    assert.deepEqual(readRequestOutcome(db,PROJECT,'request-0001'),{applied: false,operation: null});
    assert.deepEqual(readRequestOutcome(db,OTHER,'request-0001'),{applied: true,operation: 'shot.update'});
  } finally { db.close(); }
});

test('project-owned receipts of every covered family report applied with their operation', () => {
  const db = database();
  try {
    const rows = [
      ['mutation_requests','request-shot-1','shot.update',PROJECT],
      ['asset_range_requests','request-range-1','asset.range.set',PROJECT],
      ['asset_disposition_requests','request-disp-1','asset.disposition.set',PROJECT],
      ['asset_annotation_requests','request-note-1','asset.annotation.set',PROJECT],
      ['subject_requests','request-subj-1','subject.create',PROJECT],
      ['task_disposition_requests','request-task-1','task.disposition.markFailed',PROJECT],
    ] as const;
    for (const [table,requestId,operation,projectId] of rows) db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?)`).run(requestId,operation,projectId,'{}','{}');
    db.prepare('INSERT INTO project_mutation_requests VALUES(?,?,?,?)').run('request-proj-1',PROJECT,'a'.repeat(64),'{}');
    db.prepare('INSERT INTO project_version_requests VALUES(?,?,?,?,?)').run(PROJECT,'request-ver-1','project.version.save','b'.repeat(64),'{}');
    db.prepare('INSERT INTO timeline_format_requests VALUES(?,?,?)').run('request-fmt-1',PROJECT,'{}');
    for (const [requestId,operation] of [['request-shot-1','shot.update'],['request-range-1','asset.range.set'],['request-disp-1','asset.disposition.set'],
      ['request-note-1','asset.annotation.set'],['request-subj-1','subject.create'],['request-task-1','task.disposition.markFailed'],
      ['request-proj-1',null],['request-ver-1','project.version.save'],['request-fmt-1','timeline.format.set']] as const)
      assert.deepEqual(readRequestOutcome(db,PROJECT,requestId),{applied: true,operation});
    // The same request ID in another project's address is not applied.
    assert.deepEqual(readRequestOutcome(db,OTHER,'request-shot-1'),{applied: false,operation: null});
  } finally { db.close(); }
});

test('timeline receipts derive their owner from the existing bounded expression', () => {
  const db = database();
  try {
    db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run('request-tl-1','a'.repeat(64),JSON.stringify({projectId: PROJECT,id: 'x'}));
    db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run('request-tl-2','b'.repeat(64),JSON.stringify({operation: 'timeline.clip.setGains',requestId: 'request-tl-2',timeline: {projectId: PROJECT},gains: []}));
    db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run('request-tl-3','c'.repeat(64),JSON.stringify({projectId: OTHER,id: 'y'}));
    assert.deepEqual(readRequestOutcome(db,PROJECT,'request-tl-1'),{applied: true,operation: null});
    assert.deepEqual(readRequestOutcome(db,PROJECT,'request-tl-2'),{applied: true,operation: 'timeline.clip.setGains'});
    assert.deepEqual(readRequestOutcome(db,PROJECT,'request-tl-3'),{applied: false,operation: null});
  } finally { db.close(); }
});

test('reference receipts count only when the retained response belongs to the project', () => {
  const db = database();
  try {
    db.prepare('INSERT INTO reference_requests VALUES(?,?,?)').run('request-ref-1','a'.repeat(64),JSON.stringify({edge: {projectId: OTHER},shot: {projectId: OTHER}}));
    db.prepare('INSERT INTO reference_requests VALUES(?,?,?)').run('request-ref-2','b'.repeat(64),JSON.stringify({edge: {projectId: PROJECT},shot: {projectId: PROJECT},detached: true}));
    assert.deepEqual(readRequestOutcome(db,PROJECT,'request-ref-1'),{applied: false,operation: null});
    assert.deepEqual(readRequestOutcome(db,PROJECT,'request-ref-2'),{applied: true,operation: 'reference.detach'});
  } finally { db.close(); }
});

test('GET is bounded, read-only, non-cacheable and answers only the two-field outcome', async () => {
  const db = database();
  try {
    db.prepare('INSERT INTO mutation_requests VALUES(?,?,?,?,?)').run('request-shot-1','shot.update',PROJECT,'{}','{}');
    const request = http(db);
    const ok = await request(`/api/request-outcome?requestId=request-shot-1`);
    assert.equal(ok.handled,true); assert.equal(ok.status,200);
    assert.deepEqual(Object.keys(ok.body).sort(),['data','ok']);
    assert.deepEqual(ok.body.data,{applied: true,operation: 'shot.update'});
    assert.equal(ok.headers['cache-control'],'no-store');
    assert.equal(ok.headers['x-content-type-options'],'nosniff');
    const before = db.prepare('SELECT count(*) AS rows FROM mutation_requests').get() as {rows: number};
    for (const route of ['/api/request-outcome?requestId=short','/api/request-outcome?requestId=request-shot-1&projectId='+PROJECT,
      '/api/request-outcome','/api/request-outcome?requestId='+'x'.repeat(300),'/api/request-outcome?requestId=request-shot-1&requestId=request-shot-1'])
      assert.equal((await request(route)).status,400,route);
    const after = db.prepare('SELECT count(*) AS rows FROM mutation_requests').get() as {rows: number};
    assert.deepEqual(after,before);
    const wrongMethod = await request('/api/request-outcome?requestId=request-shot-1',{method: 'POST'});
    assert.equal(wrongMethod.status,405); assert.equal(wrongMethod.headers.allow,'GET');
    assert.equal((await request('/api/request-outcome?requestId=request-shot-1',{address: null})).status,409);
    assert.equal((await request('/api/unrelated')).handled,false);
    db.close();
    assert.equal((await request('/api/request-outcome?requestId=request-shot-1')).status,409);
  } finally { if (db.isOpen) db.close(); }
});

test('production assembly mounts the route inside the project host and never as an RPC operation', () => {
  const server = fs.readFileSync(new URL('../apps/server/src/project-host/request.ts',import.meta.url),'utf8');
  assert.match(server,/'request-outcome'/u);
  const runtime = fs.readFileSync(new URL('../apps/server/src/project-host/runtime.ts',import.meta.url),'utf8');
  assert.match(runtime,/project\.requestOutcomeHttp/u);
  const contracts = fs.readFileSync(new URL('../packages/contracts/src/index.ts',import.meta.url),'utf8');
  assert.equal(contracts.includes('request-outcome'),false);
});

test('a format-5 editor receipt reports applied with its status', () => {
  const db = format5Database();
  try {
    insertReceipt(db,'request-edit-1',receipt());
    assert.deepEqual(readRequestOutcome(db,PROJECT,'request-edit-1'),
      {applied: true,operation: 'timeline.clip.split',status: 'applied',code: null});
  } finally { db.close(); }
});

test('a not-applied editor receipt is a definite not-applied conclusion with its code', () => {
  const db = format5Database();
  try {
    insertReceipt(db,'request-edit-2',receipt({requestId: 'request-edit-2',status: 'not_applied',code: 'SEQUENCE_EDIT_ANCHOR_CONFLICT'}));
    const outcome = readRequestOutcome(db,PROJECT,'request-edit-2');
    assert.deepEqual(outcome,{applied: false,operation: 'timeline.clip.split',status: 'not_applied',
      code: 'SEQUENCE_EDIT_ANCHOR_CONFLICT'});
    // It is neither an applied outcome nor the two-field "missing receipt" shape.
    assert.equal(outcome.applied,false);
    assert.equal('status' in outcome,true);
  } finally { db.close(); }
});

test('editor receipts bind both project and request id', () => {
  const db = format5Database();
  try {
    insertReceipt(db,'request-edit-3',receipt({requestId: 'request-edit-3'}));
    insertReceipt(db,'request-edit-4',receipt({requestId: 'request-edit-4',projectId: OTHER}),OTHER);
    assert.equal(readRequestOutcome(db,PROJECT,'request-edit-3').applied,true);
    // Same request id, queried from the other project: not this project's row.
    assert.deepEqual(readRequestOutcome(db,OTHER,'request-edit-3'),{applied: false,operation: null});
    // Same project, unknown request id: no conclusion either.
    assert.deepEqual(readRequestOutcome(db,PROJECT,'request-edit-9'),{applied: false,operation: null});
    // A row owned by another project is readable only there.
    assert.equal(readRequestOutcome(db,OTHER,'request-edit-4').status,'applied');
    assert.deepEqual(readRequestOutcome(db,PROJECT,'request-edit-4'),{applied: false,operation: null});
  } finally { db.close(); }
});

test('format 3/4 projects keep the original two-field outcome without the format-5 table', () => {
  const db = database();
  try {
    assert.equal(fs.existsSync(new URL('../packages/business/src/request-outcome.ts',import.meta.url)),true);
    // No editor_requests table exists here: the lookup must not fail and must
    // return exactly the two fields.
    const missing = readRequestOutcome(db,PROJECT,'request-0001');
    assert.deepEqual(missing,{applied: false,operation: null});
    assert.deepEqual(Object.keys(missing).sort(),['applied','operation']);
    db.prepare('INSERT INTO mutation_requests VALUES(?,?,?,?,?)').run('request-0002','shot.update',PROJECT,'{}','{}');
    assert.deepEqual(readRequestOutcome(db,PROJECT,'request-0002'),{applied: true,operation: 'shot.update'});
  } finally { db.close(); }
});

test('a malformed or oversized editor receipt stays unavailable instead of a conclusion', async () => {
  const cases: readonly {readonly label: string; readonly requestId: string; readonly response: unknown}[] = [
    {label: 'bad json',requestId: 'request-bad-1',response: '{not json'},
    {label: 'not an object',requestId: 'request-bad-2',response: '[]'},
    {label: 'oversized',requestId: 'request-bad-3',response: JSON.stringify(receipt({requestId: 'request-bad-3',pad: 'x'.repeat(70 * 1024)}))},
    {label: 'schema invalid',requestId: 'request-bad-4',response: receipt({requestId: 'request-bad-4',version: 2})},
    {label: 'receipt of another project',requestId: 'request-bad-5',response: receipt({requestId: 'request-bad-5',projectId: OTHER})},
    {label: 'receipt of another request',requestId: 'request-bad-6',response: receipt({requestId: 'request-other-6'})},
  ];
  for (const item of cases) {
    const db = format5Database();
    try {
      insertReceipt(db,item.requestId,item.response);
      assert.throws(() => readRequestOutcome(db,PROJECT,item.requestId),
        (error: {code?: string}) => error.code === 'REQUEST_OUTCOME_UNAVAILABLE',item.label);
    } finally { db.close(); }
  }
  const db = format5Database();
  try {
    insertReceipt(db,'request-bad-http',receipt({requestId: 'request-bad-http',projectId: OTHER}));
    const response = await http(db)('/api/request-outcome?requestId=request-bad-http');
    assert.equal(response.status,503);
    assert.equal(response.body.ok,false);
    assert.equal('data' in response.body,false);
  } finally { db.close(); }
});

test('the HTTP body adds status and code only for an editor receipt', async () => {
  const format5 = format5Database();
  try {
    insertReceipt(format5,'request-edit-1',receipt());
    insertReceipt(format5,'request-edit-noop',receipt({requestId: 'request-edit-noop',status: 'not_applied',code: 'SEQUENCE_EDIT_NOOP'}));
    const request = http(format5);
    const applied = await request('/api/request-outcome?requestId=request-edit-1');
    assert.equal(applied.status,200);
    assert.deepEqual(Object.keys(applied.body.data as Record<string, unknown>).sort(),['applied','code','operation','status']);
    assert.deepEqual(applied.body.data,{applied: true,operation: 'timeline.clip.split',status: 'applied',code: null});
    const noop = await request('/api/request-outcome?requestId=request-edit-noop');
    assert.equal(noop.status,200);
    assert.deepEqual(noop.body.data,{applied: false,operation: 'timeline.clip.split',status: 'not_applied',code: 'SEQUENCE_EDIT_NOOP'});
  } finally { format5.close(); }
  const legacy = database();
  try {
    legacy.prepare('INSERT INTO mutation_requests VALUES(?,?,?,?,?)').run('request-shot-1','shot.update',PROJECT,'{}','{}');
    const body = (await http(legacy)('/api/request-outcome?requestId=request-shot-1')).body;
    assert.deepEqual(Object.keys(body.data as Record<string, unknown>).sort(),['applied','operation']);
  } finally { legacy.close(); }
});

test('a real format-5 project reports the receipt its commit stored', t => {
  const rootId = randomUUID(), shotA = randomUUID(), versionA = randomUUID(), versionB = randomUUID(), clipA = randomUUID();
  const chain = createChainWorld(t,{
    rootId,
    shots: [{id: shotA,title: 'A',versionId: versionA}],
    versions: [{versionId: versionA,assetId: randomUUID(),sha256: 'a'.repeat(64),durationSeconds: 2},
      {versionId: versionB,assetId: randomUUID(),sha256: 'b'.repeat(64),durationSeconds: 2,shotId: shotA}],
    clips: [{nodeId: shotA,clipId: clipA,startFrame: 0,durationFrames: 60}],
    edges: [{id: randomUUID(),fromId: rootId,toId: shotA}],
  });
  const state = prepareSequenceEditHistory(chain.store).state;
  const context = readSequenceEditContext(chain.store);
  const envelope: SequenceEditEnvelope = {
    contractVersion: 1,projectId: chain.projectId,epoch: state.epoch,actionId: randomUUID(),
    requestId: `history-${randomUUID()}`,originSide: 'board',filmId: chain.rootId,
    intents: [{side: 'board',operation: {kind: 'board-version',nodeId: shotA,
      version: {id: versionB,sourceFrames: 60}}}],
    baseline: {contentRevision: readProjectContentStamp(chain.store.db).contentSequence,
      timelineRevision: context.timeline.revision,syncRevision: context.syncRevision,
      historyPosition: state.position,historyRevision: state.revision,targets: []},
    impact: {nodeIds: [shotA],edgeIds: [],mainTrackClipIds: [],otherTrackItemIds: [],subtitleCueIds: []},
    allocation: {clips: [],nodes: [],splitClips: [],edges: []},
  };
  createSequenceEditing(chain.store).call('sequence.edit',envelope);
  const applied = readRequestOutcome(chain.store.db,chain.projectId,envelope.requestId);
  assert.equal(applied.applied,true);
  assert.equal(applied.status,'applied');
  assert.equal(applied.code,null);
  assert.match(String(applied.operation),/^board\./u);
  // The not-applied writer stores its own receipt in the same table.
  const failedEnvelope: SequenceEditEnvelope = {...envelope,actionId: randomUUID(),requestId: `noop-${randomUUID()}`};
  writeSequenceEditFailure(chain.store,failedEnvelope,'SEQUENCE_EDIT_NOOP');
  const notApplied = readRequestOutcome(chain.store.db,chain.projectId,failedEnvelope.requestId);
  assert.deepEqual({applied: notApplied.applied,status: notApplied.status,code: notApplied.code},
    {applied: false,status: 'not_applied',code: 'SEQUENCE_EDIT_NOOP'});
  // The input digest stored with the applied receipt matches the envelope.
  const row = chain.store.db.prepare('SELECT inputDigest,response FROM main.editor_requests WHERE requestId=?')
    .get(envelope.requestId) as {inputDigest: string;response: string};
  assert.equal(row.inputDigest,sequenceEditInputDigest(envelope));
  assert.equal(JSON.parse(row.response).status,'applied');
});

test('the web client accepts only the bounded receipt shapes and keeps the old two-field shape', async () => {
  const respond = (data: unknown, status = 200): typeof fetch => (async () =>
    new Response(JSON.stringify({ok: true,data}),{status,headers: {'Content-Type': 'application/json'}})) as unknown as typeof fetch;
  const read = (data: unknown) => createRequestOutcomeClient({fetcher: respond(data)})
    .read({projectId: PROJECT,requestId: 'request-edit-1'});
  assert.deepEqual(await read({applied: true,operation: 'timeline.clip.split',status: 'applied',code: null}),
    {applied: true,operation: 'timeline.clip.split',status: 'applied',code: null});
  assert.deepEqual(await read({applied: false,operation: 'timeline.clip.split',status: 'not_applied',code: 'SEQUENCE_EDIT_ANCHOR_CONFLICT'}),
    {applied: false,operation: 'timeline.clip.split',status: 'not_applied',code: 'SEQUENCE_EDIT_ANCHOR_CONFLICT'});
  // Format 3/4 answers keep exactly their original two fields, no additions.
  const legacy = await read({applied: true,operation: 'shot.update'});
  assert.deepEqual(legacy,{applied: true,operation: 'shot.update'});
  assert.deepEqual(Object.keys(legacy).sort(),['applied','operation']);
  for (const [label,data] of [
    ['not_applied without code',{applied: false,operation: null,status: 'not_applied'}],
    ['not_applied claimed applied',{applied: true,operation: null,status: 'not_applied',code: 'X'}],
    ['applied with code',{applied: true,operation: null,status: 'applied',code: 'X'}],
    ['applied false with applied status',{applied: false,operation: null,status: 'applied',code: null}],
    ['code without status',{applied: true,operation: null,code: 'X'}],
    ['unknown status',{applied: true,operation: null,status: 'unknown'}],
    ['oversized code',{applied: false,operation: null,status: 'not_applied',code: 'x'.repeat(201)}],
  ] as const) {
    await assert.rejects(() => read(data),(error: {code?: string}) => error.code === 'REQUEST_OUTCOME_INVALID',label);
  }
  // A failed read stays an explicit failure so the caller keeps its request.
  const unavailable = createRequestOutcomeClient({fetcher: (async () => new Response(
    JSON.stringify({ok: false,error: {code: 'REQUEST_OUTCOME_UNAVAILABLE',message: 'x',details: {}}}),{status: 503})) as unknown as typeof fetch});
  await assert.rejects(() => unavailable.read({projectId: PROJECT,requestId: 'request-edit-1'}),
    (error: {code?: string}) => error.code === 'REQUEST_OUTCOME_UNAVAILABLE');
});

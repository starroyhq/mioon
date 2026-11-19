import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {createRequestOutcomeHttp} from '../apps/server/src/request-outcome-http.ts';
import {readRequestOutcome} from '@mioon/business/request-outcome';

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
function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(RECEIPT_TABLES);
  return db;
}
interface HttpResponse {handled: boolean;status?: number;body: Record<string, unknown>;headers: Record<string, unknown>}
function http(db: DatabaseSync) {
  const handler = createRequestOutcomeHttp({db});
  return async function request(route: string,{method = 'GET',address = {projectId: PROJECT} as {projectId: string}|null}: {method?: string;address?: {projectId: string}|null} = {}): Promise<HttpResponse> {
    const req = Readable.from([]) as unknown as import('node:http').IncomingMessage;
    Object.assign(req,{method,url: route,headers: {}});
    const headers: Record<string, unknown> = {}; let status: number|undefined; let body: Record<string, unknown> = {};
    const res = {headersSent: false,destroyed: false,writableEnded: false,
      setHeader(name: string,value: unknown) { headers[name.toLowerCase()] = value; },
      writeHead(code: number,values: Record<string, unknown>) { status = code; this.headersSent = true; Object.assign(headers,Object.fromEntries(Object.entries(values).map(([key,value])=>[key.toLowerCase(),value]))); },
      end(value: string) { body = JSON.parse(value) as Record<string, unknown>; this.writableEnded = true; },
      destroy() { this.destroyed = true; }} as unknown as import('node:http').ServerResponse;
    const handled = await handler(req,res,new URL(route,'http://127.0.0.1'),address);
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

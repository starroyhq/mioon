import {validateLutResourceRows} from '../packages/business/src/lut-resource-validation.ts';
import {lexerDatabase,snapshot} from './helpers/current-retained-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

import {parseCube3D} from '../packages/business/src/cube-lut.ts';
import {lutHash,lutInputHash} from '../packages/business/src/lut-resource-validation.ts';
import type { DatabaseSync } from 'node:sqlite';

const source=Buffer.from('# retained lexical bytes\r\nTITLE "Original"\r\nLUT_3D_SIZE 2\r\n0 0 0\r\n1 0 0\r\n0 1 0\r\n1 1 0\r\n0 0 1\r\n1 0 1\r\n0 1 1\r\n1 1 1');
function database(t: test.TestContext){return lexerDatabase(t);}

function seed(db: DatabaseSync){
 const id=randomUUID(),projectId=randomUUID(),requestId=randomUUID(),name='Original.cube',sha256=lutHash(source),metadata=parseCube3D(source.toString()).metadata;
 db.prepare('INSERT INTO projects VALUES(?,?)').run(projectId,JSON.stringify({id:projectId,name:'LUT owner'}));
 const resource={id,projectId,name,sha256,sizeBytes:source.length,profile:'mioon-cube3d-normalized-tetrahedral-v1',metadata:JSON.stringify(metadata),content:source,createdAt:'2026-10-14T00:00:00.000Z'};
 db.exec('BEGIN IMMEDIATE');
 try{
  db.prepare('INSERT INTO project_lut_resources VALUES(?,?,?,?,?,?,?,?,?)').run(...Object.values(resource));
  db.prepare('INSERT INTO lut_import_requests VALUES(?,?,?,?)').run(requestId,projectId,lutInputHash({projectId,requestId,name},sha256,source.length),id);
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
 return {resource,requestId};
}
function mutateWithExactGuards(db: DatabaseSync,table: string,sql: string,values: import('node:sqlite').SQLInputValue[]=[]){
 db.prepare(sql).run(...values);
}

test('current LUT metadata admission skips source bytes while explicit verification remains byte-strict',t=>{
 const db=database(t);seed(db);const before=snapshot(db);
 assert.doesNotThrow(()=>validateLutResourceRows(db,{verifyBytes:false}));assert.deepEqual(snapshot(db),before);
 const changed=Buffer.from(source);changed[changed.indexOf('Original')]='X'.charCodeAt(0);
 mutateWithExactGuards(db,'project_lut_resources','UPDATE project_lut_resources SET content=?',[changed]);
 assert.doesNotThrow(()=>validateLutResourceRows(db,{verifyBytes:false}));
 assert.throws(()=>validateLutResourceRows(db),{code:'LUT_RESOURCE_INVALID'});
 assert.deepEqual(db.prepare('SELECT content FROM project_lut_resources').get()!.content,new Uint8Array(changed));
});

for(const kind of ['receipt mismatch','invalid semantic metadata'] as const)test(`current metadata admission still fails closed on ${kind}`,t=>{
 const db=database(t);seed(db);
 if(kind==='receipt mismatch')mutateWithExactGuards(db,'lut_import_requests','UPDATE lut_import_requests SET inputHash=?',((['f'.repeat(64)]) as unknown as Parameters<typeof mutateWithExactGuards>[3]));
 else mutateWithExactGuards(db,'project_lut_resources',"UPDATE project_lut_resources SET metadata='{}'");
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);assert.throws(()=>validateLutResourceRows(db,{verifyBytes:false}),{code:'LUT_RESOURCE_INVALID'});assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
});

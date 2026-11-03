import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validateAssetAnnotationRows} from '../packages/business/src/asset-annotation-validation.ts';
import {kernelFixture,lexerDatabase,snapshot} from './helpers/current-retained-fixture.ts';
import {openServerProject} from './helpers/project-database.ts';

test('current orphan annotation evidence fails closed without repairing retained rows',t=>{
 const db=lexerDatabase(t),assetId=randomUUID(),projectId=randomUUID();
 db.prepare('INSERT INTO asset_annotations VALUES(?,?,?,?,?)').run(assetId,projectId,1,'[]','Orphan evidence');
 const before=snapshot(db);
 assert.throws(()=>validateAssetAnnotationRows(db),{code:'INVALID_ASSET_ANNOTATION_RECORD'});
 assert.deepEqual(snapshot(db),before);
});

test('current kernel rejects extra catalog objects on normal reopen',t=>{
 const f=kernelFixture(t);f.store.db.exec('CREATE TABLE unexpected_retained_marker(value TEXT)');f.store.close();
 assert.throws(()=>openServerProject(f.dataDir,f.projectId),{code:'PROJECT_INVALID'});
});

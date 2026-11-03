import test from 'node:test';
import assert from 'node:assert/strict';
import {imageFixture} from './images-fixture.mjs';
import {snapshot} from './helpers/current-retained-fixture.ts';
import {foreignKeyCheck} from './helpers/project-database.ts';
import {schemaObjects} from '../packages/business/src/project-file/cross-file/inspect.ts';
import {validateImageTaskReview} from '../packages/business/src/images/reviews.ts';

test('current Mock records need no manufactured review and validation preserves every native row and SQL object',async t=>{
 const f=imageFixture(t);await f.succeed();
 const beforeObjects=schemaObjects(f.db),before=snapshot(f.db);
 validateImageTaskReview(f.db,f.projectId,f.taskId,f.input);
 assert.deepEqual(snapshot(f.db),before);
 const afterObjects=new Map(schemaObjects(f.db).map(value=>[`${value.schema}.${value.type}.${value.name}`,value]));
 for(const value of beforeObjects)assert.deepEqual(afterObjects.get(`${value.schema}.${value.type}.${value.name}`),value);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM image_reviews').get()!.n,0);
 assert.equal(validateImageTaskReview(f.db,f.projectId,f.taskId,f.input),null,'Mock records do not need manufactured approval');
 assert.deepEqual(foreignKeyCheck(f.db),[]);
 const all=schemaObjects(f.db),count=f.db.prepare('SELECT total_changes() AS n').get()!.n;
 validateImageTaskReview(f.db,f.projectId,f.taskId,f.input);
 assert.deepEqual(schemaObjects(f.db),all);assert.deepEqual(snapshot(f.db),before);
 assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n,count);
});

import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {imageFixture} from './images-fixture.mjs';
import {migrateImageReviewSchema} from '../packages/business/src/images/review-schema.ts';
import {validateImageTaskReview} from '../packages/business/src/images/reviews.ts';

interface SchemaObject {type: string; name: string; tbl_name: string; sql: string}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, (_key: string, field: unknown) => typeof field === 'bigint' ? String(field) : field)).digest('hex');
function capture(db: DatabaseSync, names: readonly string[]): string {
  const result = names.map(name => {
    const statement = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`); statement.setReadBigInts(true);
    return [name, statement.all()];
  });
  return digest(result);
}
function objects(db: DatabaseSync): SchemaObject[] {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all() as unknown as SchemaObject[];
}

test('review migration is additive over frozen schema15 plus schema16 images, preserving every legacy row and SQL object', (t: TestContext) => {
  const f = imageFixture(t); f.succeed();
  const beforeObjects = objects(f.db), names = beforeObjects.filter(value => value.type === 'table').map(value => value.name);
  const before = capture(f.db, names);
  f.db.exec('BEGIN IMMEDIATE'); migrateImageReviewSchema(f.db); f.db.exec('COMMIT');
  assert.equal(capture(f.db, names), before);
  const afterObjects = new Map(objects(f.db).map(value => [value.name, value]));
  for (const value of beforeObjects) assert.deepEqual(afterObjects.get(value.name), value);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM image_reviews').get() as {n: number}).n, 0);
  assert.equal(validateImageTaskReview(f.db, f.projectId, f.taskId, f.input), null, 'old Mock records do not need manufactured approval');
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
  const all = objects(f.db), count = (f.db.prepare('SELECT total_changes() AS n').get() as {n: number}).n;
  f.db.exec('BEGIN IMMEDIATE'); migrateImageReviewSchema(f.db); f.db.exec('COMMIT');
  assert.deepEqual(objects(f.db), all); assert.equal(capture(f.db, names), before);
  assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as {n: number}).n, count);
});

test('faulted additive review migration rolls back all new objects and preserves historical task/receipt bytes', (t: TestContext) => {
  const f = imageFixture(t), beforeObjects = objects(f.db), names = beforeObjects.filter(value => value.type === 'table').map(value => value.name);
  const before = capture(f.db, names), injected = {get isTransaction() {return f.db.isTransaction;}, exec(sql: string): never {f.db.exec(sql); throw new Error('Synthetic migration interruption');}};
  f.db.exec('BEGIN IMMEDIATE');
  assert.throws(() => migrateImageReviewSchema(injected as unknown as DatabaseSync), /Synthetic migration interruption/);
  f.db.exec('ROLLBACK');
  assert.deepEqual(objects(f.db), beforeObjects); assert.equal(capture(f.db, names), before);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='image_reviews'").get(), undefined);
  assert.throws(() => migrateImageReviewSchema(f.db), /requires a transaction/);
});

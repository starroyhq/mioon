import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {classifyCurrentWorkspaceSchema} from '../packages/business/src/db.ts';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {initializeWorkspaceSchema26} from '../packages/business/src/workspace-schema-v26.ts';
import {initializeWorkspaceSchema28} from '../packages/business/src/workspace-schema-v28.ts';
import {initializeWorkspaceSchema30} from '../packages/business/src/workspace-schema-v30.ts';
import {initializeWorkspaceSchema32} from '../packages/business/src/workspace-schema-v32.ts';
import {initializeWorkspaceSchema34} from '../packages/business/src/workspace-schema-v34.ts';
import {initializeWorkspaceSchema36} from '../packages/business/src/workspace-schema-v36.ts';
import {initializeWorkspaceSchema38} from '../packages/business/src/workspace-schema-v38.ts';
import {initializeWorkspaceSchema40} from '../packages/business/src/workspace-schema-v40.ts';
import {initializeWorkspaceSchema44} from '../packages/business/src/workspace-schema-v44.ts';
import {initializeWorkspaceSchema48} from '../packages/business/src/workspace-schema-v48.ts';
import {initializeWorkspaceSchema50} from '../packages/business/src/workspace-schema-v50.ts';
import {initializeWorkspaceSchema52} from '../packages/business/src/workspace-schema-v52.ts';
import {initializeWorkspaceSchema54} from '../packages/business/src/workspace-schema-v54.ts';
import {initializeWorkspaceSchema56} from '../packages/business/src/workspace-schema-v56.ts';
import {initializeWorkspaceSchema58} from '../packages/business/src/workspace-schema-v58.ts';
import {initializeWorkspaceSchema60} from '../packages/business/src/workspace-schema-v60.ts';

function ordinary40(t: TestContext): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
  for (const initialize of [initializeWorkspaceSchemaThrough24, initializeWorkspaceSchema26, initializeWorkspaceSchema28, initializeWorkspaceSchema30, initializeWorkspaceSchema32,
    initializeWorkspaceSchema34, initializeWorkspaceSchema36, initializeWorkspaceSchema38, initializeWorkspaceSchema40]) initialize(db);
  t.after(() => {if (db.isOpen) db.close();});
  return db;
}

test('ordinary40 upgrades to60 build each fixed historical catalog once per constructor', t => {
  // Every fixed catalog is built by replaying the historical chain through the constructor it is given.
  let replays = 0;
  const through24 = (db: DatabaseSync): void => {replays++; initializeWorkspaceSchemaThrough24(db);};
  const upgrade = (db: DatabaseSync): DatabaseSync => {
    for (const initialize of [initializeWorkspaceSchema44, initializeWorkspaceSchema48, initializeWorkspaceSchema50, initializeWorkspaceSchema52,
      initializeWorkspaceSchema54, initializeWorkspaceSchema56, initializeWorkspaceSchema58, initializeWorkspaceSchema60]) initialize(db, through24);
    return db;
  };
  assert.deepEqual(classifyCurrentWorkspaceSchema(upgrade(ordinary40(t))), {schemaVersion: 60, profile: 'ordinary'});
  const first = replays;
  assert.ok(first >= 8, `each upgrade step classifies its source against fixed catalogs (${first} replays)`);
  assert.deepEqual(classifyCurrentWorkspaceSchema(upgrade(ordinary40(t))), {schemaVersion: 60, profile: 'ordinary'});
  assert.equal(replays, first, 'a second workspace in the same process reuses every fixed catalog');
});

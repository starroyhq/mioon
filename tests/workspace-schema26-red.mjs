// Deliberate pre-fix reproducer. Run separately; exit1 is the expected retained
// red evidence. Ordinary through24 must remain frozen and cannot accept apply.
import assert from 'node:assert/strict';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {open, task, insert} from './workspace-schema26-fixtures.mjs';
const db = open(':memory:');
try {
  initializeWorkspaceSchemaThrough24(db);
  assert.doesNotThrow(() => insert(db, 'edit_tasks', task(db)), 'approved loudness apply requires an ordinary26 operation CHECK migration');
} finally { db.close(); }

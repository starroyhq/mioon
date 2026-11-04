import test from 'node:test';
import assert from 'node:assert/strict';
import {backgroundTaskQueryResponseSchema} from '../packages/contracts/src/background-task-query.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n: number) => ({projectId: id(n), taskCount: 2, reasonCodes: ['PROJECT_MISSING']});
const catalog = () => ({version: 1 as const, projects: [item(1), item(2)], nextCursor: id(2)});

test('background query metadata is closed, ordered and paginated without granting task capabilities', () => {
  assert.deepEqual(backgroundTaskQueryResponseSchema.parse(catalog()), catalog());
  assert.ok(backgroundTaskQueryResponseSchema.safeParse({version: 1, projects: [], nextCursor: null}).success);
  for (const field of ['input', 'receipt', 'providerUrl', 'stagedMedia', 'projectFile', 'sourceHistory', 'token']) {
    const value = catalog();
    assert.equal(backgroundTaskQueryResponseSchema.safeParse({...value, projects: [{...item(1), [field]: 'PRIVATE'}]}).success, false, field);
    assert.equal(backgroundTaskQueryResponseSchema.safeParse({...value, [field]: 'PRIVATE'}).success, false, field);
  }
});

test('invalid task counts, identities, reasons and cursor order refuse the entire summary', () => {
  for (const value of [
    {...catalog(), projects: [item(2), item(1)]},
    {...catalog(), projects: [item(1), item(1)]},
    {...catalog(), nextCursor: id(3)},
    {...catalog(), projects: [], nextCursor: id(1)},
    {...catalog(), projects: [{...item(1), projectId: 'other-project'}], nextCursor: null},
    ...[-1, 0, 513, 1.5, Infinity].map(taskCount => ({...catalog(), projects: [{...item(1), taskCount}], nextCursor: null})),
    ...[[], ['PROJECT_MISSING', 'PROJECT_MISSING'], ['PRIVATE path /x'], ['a'.repeat(101)]].map(reasonCodes => ({...catalog(), projects: [{...item(1), reasonCodes}], nextCursor: null})),
  ]) assert.equal(backgroundTaskQueryResponseSchema.safeParse(value).success, false);
});

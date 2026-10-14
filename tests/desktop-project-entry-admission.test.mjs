import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {consumeNativeProjectEntry} from '../apps/desktop/src/project-entry-admission.ts';

const token = '11111111-1111-4111-8111-111111111111';
const project = '22222222-2222-4222-8222-222222222222';
test('native entry consumes only fixed UUID metadata through the exact current owner', async () => {
  const calls = []; const receipt = {version: 1, entryToken: token, projectId: project, accepted: true};
  const owner = {isCurrent: () => true, window: {webContents: {executeJavaScript: async code => vm.runInNewContext(code,
    {__mioonProjectEntryAdmission: {consume: (...args) => {calls.push(args); return receipt;}}})}}};
  assert.equal(await consumeNativeProjectEntry(owner, token, project), receipt);
  assert.deepEqual(calls, [[token, project]]);
  assert.equal(await consumeNativeProjectEntry(owner, `${token};evil()`, project), null);
  assert.equal(calls.length, 1);
});
test('late renderer admission from a replaced owner never authorizes opening', async () => {
  let current = true, finish, called = 0;
  const owner = {isCurrent: () => current, window: {webContents: {executeJavaScript: () => {called++; return new Promise(resolve => {finish = resolve;});}}}};
  const pending = consumeNativeProjectEntry(owner, token, project);
  await Promise.resolve(); assert.equal(called, 1);
  current = false; finish({version: 1, entryToken: token, projectId: project, accepted: true});
  assert.equal(await pending, null);
});
test('unresponsive entry observation is bounded and a late receipt cannot resume a reservation', async () => {
  let finish, calls = 0;
  const owner = {isCurrent: () => true, window: {webContents: {executeJavaScript: () => {calls++; return new Promise(resolve => {finish = resolve;});}}}};
  assert.equal(await consumeNativeProjectEntry(owner, token, project, 5), null);
  finish({version: 1, entryToken: token, projectId: project, accepted: true});
  await Promise.resolve(); assert.equal(calls, 1);
});

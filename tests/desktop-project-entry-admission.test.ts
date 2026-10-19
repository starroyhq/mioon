import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {consumeNativeProjectEntry} from '../apps/desktop/src/project-entry-admission.ts';

type Owner = Parameters<typeof consumeNativeProjectEntry>[0];
type Receipt = {version: 1; entryToken: string; projectId: string; accepted: boolean};
const token = '11111111-1111-4111-8111-111111111111';
const project = '22222222-2222-4222-8222-222222222222';
const receipt = (): Receipt => ({version: 1, entryToken: token, projectId: project, accepted: true});
test('native entry consumes only fixed UUID metadata through the exact current owner', async () => {
  const calls: Array<[string, string]> = []; const value = receipt();
  const owner = {isCurrent: () => true, window: {webContents: {executeJavaScript: async (code: string) => vm.runInNewContext(code,
    {__mioonProjectEntryAdmission: {consume: (...args: [string, string]) => {calls.push(args); return value;}}})}}} as unknown as Owner;
  assert.equal(await consumeNativeProjectEntry(owner, token, project), value);
  assert.deepEqual(calls, [[token, project]]);
  assert.equal(await consumeNativeProjectEntry(owner, `${token};evil()`, project), null);
  assert.equal(calls.length, 1);
});
test('late renderer admission from a replaced owner never authorizes opening', async () => {
  let current = true, called = 0; let finish: ((value: unknown) => void) | undefined;
  const owner = {isCurrent: () => current, window: {webContents: {executeJavaScript: () => {called++; return new Promise<unknown>(resolve => {finish = resolve;});}}}} as unknown as Owner;
  const pending = consumeNativeProjectEntry(owner, token, project);
  await Promise.resolve(); assert.equal(called, 1);
  current = false; finish!(receipt());
  assert.equal(await pending, null);
});
test('unresponsive entry observation is bounded and a late receipt cannot resume a reservation', async () => {
  let called = 0; let finish: ((value: unknown) => void) | undefined;
  const owner = {isCurrent: () => true, window: {webContents: {executeJavaScript: () => {called++; return new Promise<unknown>(resolve => {finish = resolve;});}}}} as unknown as Owner;
  assert.equal(await consumeNativeProjectEntry(owner, token, project, 5), null);
  finish!(receipt());
  await Promise.resolve(); assert.equal(called, 1);
});

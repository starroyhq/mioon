import assert from 'node:assert/strict';
import test from 'node:test';
import {reconcileShotDraft} from '../apps/web/src/board-ui/shot-draft.ts';

const shot = (revision: number, title: string, prompt = 'p', duration = 2) => ({id: 'shot-1', revision, title, prompt, duration});
test('an untouched shot draft follows an external revision change', () => {
  const first = reconcileShotDraft(null, shot(1, '原题'));
  assert.deepEqual(first.values, {title: '原题', prompt: 'p', duration: 2});
  assert.equal(first.revision, 1);
  const external = reconcileShotDraft(first, shot(2, '外部改题', '外部描述', 4));
  assert.deepEqual(external.values, {title: '外部改题', prompt: '外部描述', duration: 4});
  assert.equal(external.revision, 2);
  assert.equal(external.dirty, false);
});
test('a dirty shot draft keeps the editing-start revision until it is discarded', () => {
  const first = reconcileShotDraft(null, shot(1, '原题'));
  const dirty = {...first, values: {title: '我的草稿', prompt: '我的描述', duration: 4}, dirty: true};
  const external = reconcileShotDraft(dirty, shot(2, '别处改了', '别处描述', 8));
  assert.deepEqual(external.values, {title: '我的草稿', prompt: '我的描述', duration: 4});
  assert.equal(external.revision, 1, 'save must use the revision where editing started');
  assert.equal(external.dirty, true);
});

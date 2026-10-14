import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {installWindowPolicy} from '../apps/desktop/src/security.mjs';

const origin = 'http://127.0.0.1:41923';
const own = `${origin}/?project=11111111-1111-4111-8111-111111111111`;
const other = `${origin}/?project=22222222-2222-4222-8222-222222222222`;
function fixture(url = own) {
  const contents = new EventEmitter(); contents.setWindowOpenHandler = () => {};
  const state = {current: true};
  installWindowPolicy({webContents: contents}, origin, {url, isCurrent: () => state.current});
  return {contents, state};
}
function blocked(contents, name, event, legacyUrl) {
  let prevented = false;
  contents.emit(name, {...event, preventDefault() {prevented = true;}}, legacyUrl);
  return prevented;
}

test('native project owner permits only its immutable assigned URL, not another legal project or launcher', () => {
  const {contents} = fixture();
  for (const name of ['will-navigate', 'will-redirect']) {
    assert.equal(blocked(contents, name, {url: own}), false);
    for (const url of [other, `${origin}/`, `${own}&x=1`, `${own}#x`, 'about:blank']) {
      assert.equal(blocked(contents, name, {url}), true, `${name} ${url}`);
    }
    assert.equal(blocked(contents, name, {}, other), true);
  }
  assert.equal(blocked(contents, 'will-frame-navigate', {url: own, isMainFrame: true}), false);
  assert.equal(blocked(contents, 'will-frame-navigate', {url: other, isMainFrame: true}), true);
  assert.equal(blocked(contents, 'will-frame-navigate', {url: own, isMainFrame: false}), true);
});

test('launcher and settings root may not become an editor; a revoked owner may not reload', () => {
  const {contents, state} = fixture(`${origin}/`);
  assert.equal(blocked(contents, 'will-navigate', {url: `${origin}/`}), false);
  assert.equal(blocked(contents, 'will-navigate', {url: own}), true);
  state.current = false;
  assert.equal(blocked(contents, 'will-navigate', {url: `${origin}/`}), true);
});

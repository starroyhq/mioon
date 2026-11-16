import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setImmediate} from 'node:timers/promises';
import test from 'node:test';
import {createDesktopUpdateHost} from '../apps/desktop/src/desktop-update-host.ts';
import type {UpdateDocument} from '../apps/desktop/src/desktop-update-host.ts';
import {createDesktopUpdateQuit} from '../apps/desktop/src/desktop-update-quit.ts';
import {createDesktopUpdateReopen} from '../apps/desktop/src/desktop-update-reopen.ts';
import type {DesktopUpdateState, DesktopUpdateView} from '../packages/contracts/src/desktop-update.ts';

const version = '0.2.1';
const offer = {version, currentVersion: '0.2.0', notes: ['Synthetic notes']};
const project = '77000000-0000-4000-8000-000000000001';
function owner(id: string) {
  const received: DesktopUpdateView[] = [];
  let current = true, visible = true;
  const document: UpdateDocument = {id, isCurrent: () => current, isVisible: () => visible, send: view => received.push(view)};
  return {document, received, retire: () => {current = false;}, hide: () => {visible = false;}};
}

test('each host opens only its first launch notice and publishes shared state for later checks', async t => {
  const a = owner('first'), b = owner('second');
  let state: DesktopUpdateState = {kind: 'idle'};
  const initial = Promise.withResolvers<DesktopUpdateState>();
  let starts = 0;
  const host = createDesktopUpdateHost({
    engine: {state: () => state, start: () => {starts++; return initial.promise;}, check: async () => state,
      download: async () => state, cancel: () => false, setInstallOnQuit: () => false},
    currentVersion: '0.2.0', documents: () => [a.document, b.document], focused: () => b.document,
    activity: async () => ({exports: false, generations: false}), install: async () => false,
  });
  t.after(() => host.dispose());
  host.start(a.document); host.start(b.document);
  state = {kind: 'available', offer};
  host.changed(); initial.resolve(state); await setImmediate();
  assert.equal(starts, 1);
  assert.equal(a.received.at(-1)?.notice?.kind, 'launch');
  assert.equal(b.received.at(-1)?.notice, null);
  const launchId = a.received.at(-1)?.notice?.id;
  state = {kind: 'available', offer: {...offer, version: '0.3.0'}};
  host.changed();
  assert.equal(a.received.at(-1)?.notice?.id, launchId);
  assert.deepEqual(a.received.at(-1)?.state, b.received.at(-1)?.state);
  await host.check(b.document);
  assert.equal(b.received.at(-1)?.notice?.kind, 'manual');
  state = {kind: 'ready', offer, installOnQuit: false};
  host.changed(); host.changed();
  assert.equal(b.received.at(-1)?.notice?.kind, 'ready');
  assert.equal(b.received.at(-1)?.notice?.id, b.received.at(-2)?.notice?.id);
  a.retire();
  assert.deepEqual(await host.dispatch(a.document, {kind: 'read'}), {ok: false, error: {code: 'UPDATE_UNAVAILABLE', status: 503}});
});

test('install rejects a stale version or an unacknowledged new export before requesting quit', async t => {
  const window = owner('current');
  const state: DesktopUpdateState = {kind: 'ready', offer, installOnQuit: false};
  const choices: string[] = [];
  const host = createDesktopUpdateHost({
    engine: {state: () => state, start: async () => state, check: async () => state, download: async () => state,
      cancel: () => false, setInstallOnQuit: expected => {choices.push('later:' + expected); return true;}},
    currentVersion: '0.2.0', documents: () => [window.document], focused: () => window.document,
    activity: async () => ({exports: true, generations: true}),
    install: async expected => {choices.push('now:' + expected); return false;},
  });
  t.after(() => host.dispose());
  assert.deepEqual(await host.dispatch(window.document, {kind: 'install', mode: 'now', expectedVersion: '0.2.2'}),
    {ok: false, error: {code: 'UPDATE_VERSION_CHANGED', status: 409}});
  assert.deepEqual(await host.dispatch(window.document, {kind: 'install', mode: 'now', expectedVersion: version}),
    {ok: false, error: {code: 'UPDATE_EXPORT_ACTIVE', status: 409}});
  assert.deepEqual(window.received.at(-1)?.activity, {exports: true, generations: true});
  assert.deepEqual(choices, []);
  assert.deepEqual(await host.dispatch(window.document, {kind: 'install', mode: 'now', expectedVersion: version, acknowledgeExports: true}),
    {ok: false, error: {code: 'UPDATE_NOT_SAVED', status: 409}});
  assert.equal((await host.dispatch(window.document, {kind: 'install', mode: 'on-quit', expectedVersion: version})).ok, true);
  assert.deepEqual(choices, ['now:0.2.1', 'later:0.2.1']);
});

test('a launch result targets the first visible project rather than a launcher hidden in the meantime', async t => {
  const launcher = owner('launcher'), projectWindow = owner('project');
  const initial = Promise.withResolvers<DesktopUpdateState>();
  let state: DesktopUpdateState = {kind: 'idle'};
  const host = createDesktopUpdateHost({
    engine: {state: () => state, start: () => initial.promise, check: async () => state, download: async () => state,
      cancel: () => false, setInstallOnQuit: () => false},
    currentVersion: '0.2.0', documents: () => [launcher.document, projectWindow.document], focused: () => projectWindow.document,
    activity: async () => ({exports: false, generations: false}), install: async () => false,
  });
  t.after(() => host.dispose());
  host.start(launcher.document);
  launcher.hide();
  state = {kind: 'available', offer};
  host.changed(); initial.resolve(state); await setImmediate();
  assert.equal(launcher.received.at(-1)?.notice, null);
  assert.equal(projectWindow.received.at(-1)?.notice?.kind, 'launch');
});

test('an export started while windows report saved requires a new confirmation at the close boundary', async t => {
  const window = owner('current');
  const state: DesktopUpdateState = {kind: 'ready', offer, installOnQuit: false};
  let busy = false, closed = false;
  const host = createDesktopUpdateHost({
    engine: {state: () => state, start: async () => state, check: async () => state, download: async () => state,
      cancel: () => false, setInstallOnQuit: () => false},
    currentVersion: '0.2.0', documents: () => [window.document], focused: () => window.document,
    activity: async () => ({exports: busy, generations: false}),
    install: async (_version, beforeClose) => {
      busy = true;
      closed = await beforeClose();
      return closed;
    },
  });
  t.after(() => host.dispose());
  assert.deepEqual(await host.dispatch(window.document, {kind: 'install', mode: 'now', expectedVersion: version}),
    {ok: false, error: {code: 'UPDATE_EXPORT_ACTIVE', status: 409}});
  assert.equal(closed, false);
  assert.equal(window.received.at(-1)?.activity.exports, true);
});

test('an unsaved or changed window blocks update before close and only completed Quit starts installation', async () => {
  const log: string[] = [], windows = ['first', 'second'];
  let dirty = true, replaceWhileChecking = false, quitAllowed = true, finish: () => boolean = () => false;
  const coordinator = createDesktopUpdateQuit({
    windows: () => [...windows],
    async saved(window) {
      if (replaceWhileChecking) windows[1] = 'replacement';
      return window !== 'second' || !dirty;
    },
    projects: () => [project], canStart: input => input === version,
    async quit() {log.push('quit'); if (quitAllowed) assert.equal(finish(), true); return quitAllowed;},
    handoff: {stage: target => log.push('stage:' + target), discard: () => log.push('discard')},
    install: (_expected, relaunch) => {log.push(relaunch ? 'install-and-relaunch' : 'install-on-exit'); return true;},
    installFailed: () => log.push('failure'),
  });
  finish = coordinator.finish;
  assert.equal(await coordinator.request(version, true), false);
  dirty = false; replaceWhileChecking = true;
  assert.equal(await coordinator.request(version, true), false);
  assert.deepEqual(log, []);
  replaceWhileChecking = false; quitAllowed = false;
  assert.equal(await coordinator.request(version, true), false);
  assert.deepEqual(log, ['quit']);
  quitAllowed = true;
  assert.equal(await coordinator.request(version, false), true);
  assert.deepEqual(log, ['quit', 'quit', 'stage:0.2.1', 'install-on-exit']);
  coordinator.failed(); coordinator.failed();
  assert.deepEqual(log, ['quit', 'quit', 'stage:0.2.1', 'install-on-exit', 'discard', 'failure']);
});

test('the update handoff contains unique registered IDs and is consumed once by only the intended version', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-update-handoff-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  let time = 1000;
  const handoff = createDesktopUpdateReopen(root, () => time);
  handoff.stage(version, [project, project]);
  assert.deepEqual(handoff.consume(version), [project]);
  assert.deepEqual(handoff.consume(version), []);
  handoff.stage(version, [project]);
  assert.deepEqual(handoff.consume('0.2.0'), []);
  assert.deepEqual(handoff.consume(version), []);
  handoff.stage(version, [project]);
  time += 24 * 60 * 60 * 1000 + 1;
  assert.deepEqual(handoff.consume(version), []);
});

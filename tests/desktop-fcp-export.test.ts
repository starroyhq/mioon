import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createFcpExportBridge} from '../apps/desktop/src/fcp-export-preload.ts';
import {createFcpExportHost} from '../apps/desktop/src/fcp-export-host.ts';
import {createProjectEntryControlClient, createProjectEntryControlBroker} from '../apps/desktop/src/project-entry-control.ts';
import {FCP_EXPORT_NATIVE_CHANNEL} from '../packages/contracts/src/fcp-export-native.ts';
import type {NativeFcpExportControlPort, ProjectEntryControlPort} from '../packages/contracts/src/project-entry-native.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-native-fcp-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const projectId = randomUUID(), windowId = randomUUID(), exportId = randomUUID(), backendId = randomUUID();
  const identity = {projectId, exportId};
  const bundle = path.join(root, 'Test.fcpxmld');
  mkdirSync(bundle);
  writeFileSync(path.join(bundle, 'Info.fcpxml'), '<fcpxml/>');
  const f = {
    root, bundle, projectId, windowId, identity,
    current: true, selection: root as string | null, installed: true, done: true,
    chooseCalls: 0, completedCalls: 0, opened: [] as string[], revealed: [] as string[], releases: [] as string[],
    beforeLookup: undefined as ((signal: AbortSignal | undefined) => Promise<void>) | undefined,
  };
  const evidence = lstatSync(bundle, {bigint: true});
  const backend: NativeFcpExportControlPort = {
    async chooseDestination(input) {
      f.chooseCalls++;
      const info = lstatSync(root, {bigint: true});
      assert.deepEqual(input, {projectId, windowId, token: input.token, directory: root, device: String(info.dev), inode: String(info.ino)});
      return {token: input.token, displayPath: '~/Selected Folder'};
    },
    async completedBundle(input, options) {
      f.completedCalls++;
      assert.deepEqual(input, {projectId, windowId, exportId});
      await f.beforeLookup?.(options?.signal);
      return f.done ? {path: bundle, device: String(evidence.dev), inode: String(evidence.ino)} : null;
    },
  };
  // Exactly the private client and utility broker are used. The only fakes
  // are the lease's project service and OS presentation functions.
  const control: Pick<ProjectEntryControlPort, 'onWindowRevoked' | 'release' | 'nativeFcpExport'> = {
    onWindowRevoked: () => () => {}, nativeFcpExport: backend, release: input => {f.releases.push(input.windowId);},
  };
  const broker = createProjectEntryControlBroker({backendId, control: control as ProjectEntryControlPort,
    send: reply => {queueMicrotask(() => client.handle(reply));}});
  const client = createProjectEntryControlClient({backendId, send: message => {queueMicrotask(() => broker.handle(message));}});
  t.after(() => {client.close(); broker.close();});
  const lifetime = new AbortController();
  const host = createFcpExportHost({
    ownerForEvent: (event: string) => event === 'editor' ? {projectId, windowId, isCurrent: () => f.current} : null,
    signal: lifetime.signal,
    backend: client.api.nativeFcpExport,
    async chooseDirectory() {return f.selection;},
    revealPath(file) {f.revealed.push(file);},
    async openInFinalCut(file) {f.opened.push(file); return true;},
    async finalCutInstalled() {return f.installed;},
  });
  const bridge = createFcpExportBridge((channel, input) => {
    assert.equal(channel, FCP_EXPORT_NATIVE_CHANNEL);
    return host.handle('editor', input);
  });
  return {root, bundle, identity, f, host, bridge, lifetime, client};
}

test('FCP chooses an owned directory and sends only the token and display path to the page', async t => {
  const {root, bridge, f} = fixture(t);
  f.selection = null;
  assert.equal(await bridge.chooseDestination(), null);
  assert.equal(f.chooseCalls, 0);
  f.selection = root;
  const first = await bridge.chooseDestination(), second = await bridge.chooseDestination();
  assert.ok(first && second);
  assert.deepEqual(Object.keys(first).sort(), ['displayPath', 'token']);
  assert.equal(first.displayPath, '~/Selected Folder');
  assert.notEqual(first.token, second.token);
  assert.equal(f.chooseCalls, 2);
  f.selection = path.join(root, 'alias');
  symlinkSync(root, f.selection);
  await assert.rejects(bridge.chooseDestination(), {code: 'FCP_EXPORT_NATIVE_UNAVAILABLE', status: 503});
  assert.equal(f.chooseCalls, 2);
});

test('FCP only reveals or opens the current project’s verified completed bundle', async t => {
  const {root, bundle, identity, bridge, host, f} = fixture(t);
  assert.equal(await bridge.finalCutInstalled(), true);
  await assert.rejects(bridge.reveal({...identity, projectId: randomUUID()}), {code: 'FCP_EXPORT_NATIVE_UNAVAILABLE', status: 503});
  assert.equal((await host.handle('candidate', {kind: 'reveal', identity})).ok, false);
  assert.equal(f.completedCalls, 0);
  f.done = false;
  assert.equal(await bridge.reveal(identity), false);
  f.done = true;
  assert.equal(await bridge.reveal(identity), true);
  f.installed = false;
  assert.equal(await bridge.finalCutInstalled(), false);
  assert.equal(await bridge.openInFinalCut(identity), false);
  f.installed = true;
  assert.equal(await bridge.openInFinalCut(identity), true);
  assert.deepEqual(f.revealed, [bundle]);
  assert.deepEqual(f.opened, [bundle]);
  renameSync(bundle, path.join(root, 'old'));
  mkdirSync(bundle);
  writeFileSync(path.join(bundle, 'Info.fcpxml'), '<fcpxml/>');
  assert.equal(await bridge.reveal(identity), false);
  assert.equal(await bridge.openInFinalCut(identity), false);
  assert.deepEqual(f.revealed, [bundle]);
  assert.deepEqual(f.opened, [bundle]);
});

test('FCP rejects renderer paths, malformed replies, and a selection after its owner was retired', async t => {
  const {identity, bridge, host, f, lifetime} = fixture(t);
  const invalid = {code: 'FCP_EXPORT_NATIVE_INVALID', status: 400};
  const unavailable = {code: 'FCP_EXPORT_NATIVE_UNAVAILABLE', status: 503};
  await assert.rejects(bridge.reveal({...identity, path: '/untrusted'} as typeof identity), invalid);
  assert.deepEqual(await host.handle('editor', {kind: 'chooseDestination', directory: '/untrusted'}), {ok: false, error: invalid});
  await assert.rejects(createFcpExportBridge(async () => ({ok: true, data: true})).chooseDestination(), unavailable);
  await assert.rejects(createFcpExportBridge(async () => {throw new Error('private detail');}).finalCutInstalled(), unavailable);
  const pending = bridge.chooseDestination();
  f.current = false;
  await assert.rejects(pending, unavailable);
  assert.equal(f.chooseCalls, 0);
  f.current = true;
  lifetime.abort();
  await assert.rejects(bridge.finalCutInstalled(), unavailable);
});

test('cancelled FCP lookup aborts its request and leaves the already open editor lease usable', async t => {
  const {client, identity, f} = fixture(t);
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  f.beforeLookup = async requestSignal => {signal = requestSignal; entered.resolve(); await finish.promise;};
  const abort = new AbortController();
  const input = {...identity, windowId: f.windowId};
  const pending = client.api.nativeFcpExport.completedBundle(input, {signal: abort.signal});
  await entered.promise;
  abort.abort();
  await assert.rejects(pending, {code: 'PROJECT_ENTRY_UNAVAILABLE'});
  assert.equal(signal?.aborted, true);
  finish.resolve();
  f.beforeLookup = undefined;
  assert.ok(await client.api.nativeFcpExport.completedBundle(input));
  assert.deepEqual(f.releases, []);
  client.api.release({windowId: f.windowId});
  await assert.rejects(client.api.nativeFcpExport.completedBundle(input), {code: 'PROJECT_ENTRY_UNAVAILABLE'});
  assert.deepEqual(f.releases, [f.windowId]);
});

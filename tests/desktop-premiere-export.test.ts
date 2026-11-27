import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createPremiereExportBridge} from '../apps/desktop/src/premiere-export-preload.ts';
import {createPremiereExportHost} from '../apps/desktop/src/premiere-export-host.ts';
import {createPremiereMacLauncher} from '../apps/desktop/src/premiere-export-macos.ts';
import {createProjectEntryControlBroker, createProjectEntryControlClient} from '../apps/desktop/src/project-entry-control.ts';
import {PREMIERE_EXPORT_NATIVE_CHANNEL} from '../packages/contracts/src/premiere-export-native.ts';
import type {NativePremiereExportControlPort, ProjectEntryControlPort} from '../packages/contracts/src/project-entry-native.ts';

const invalid = {code: 'PREMIERE_EXPORT_NATIVE_INVALID', status: 400};
const unavailable = {code: 'PREMIERE_EXPORT_NATIVE_UNAVAILABLE', status: 503};
function fileIdentity(file: string) {
  const info = lstatSync(file, {bigint: true});
  return {path: file, device: String(info.dev), inode: String(info.ino)};
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-native-premiere-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const projectId = randomUUID(), windowId = randomUUID(), backendId = randomUUID();
  const identity = {projectId, exportId: randomUUID()};
  const bundle = path.join(root, 'Premiere Test Premiere');
  const xml = path.join(bundle, 'Premiere Test.xml');
  mkdirSync(bundle);
  writeFileSync(xml, '<xmeml/>');
  const bundleIdentity = fileIdentity(bundle), xmlIdentity = fileIdentity(xml);
  const flags = {
    installed: true, done: true, current: true, choice: root as string | null,
    revealed: [] as string[], opened: [] as string[], lookups: [] as string[], releases: [] as string[],
    beforeOpen: undefined as (() => void) | undefined,
    beforeLookup: undefined as ((signal?: AbortSignal) => Promise<void>) | undefined,
  };
  const nativePremiereExport: NativePremiereExportControlPort = {
    async chooseDestination(input) {
      const folderIdentity = fileIdentity(root);
      assert.deepEqual(input, {
        projectId, windowId, token: input.token, directory: root, device: folderIdentity.device, inode: folderIdentity.inode,
      });
      return {token: input.token, displayPath: 'Temporary destination'};
    },
    async completedBundle(input) {
      assert.deepEqual(input, {...identity, windowId});
      flags.lookups.push('bundle');
      return flags.done ? bundleIdentity : null;
    },
    async completedXml(input, options) {
      assert.deepEqual(input, {...identity, windowId});
      flags.lookups.push('xml');
      await flags.beforeLookup?.(options?.signal);
      return flags.done ? xmlIdentity : null;
    },
  };
  const control: Pick<ProjectEntryControlPort, 'nativePremiereExport' | 'onWindowRevoked' | 'release'> = {
    nativePremiereExport, onWindowRevoked: () => () => {}, release: input => {flags.releases.push(input.windowId);},
  };
  const broker = createProjectEntryControlBroker({backendId, control: control as ProjectEntryControlPort,
    send: message => {queueMicrotask(() => client.handle(message));}});
  const client = createProjectEntryControlClient({backendId, send: message => {queueMicrotask(() => broker.handle(message));}});
  t.after(() => {client.close(); broker.close();});
  const lifetime = new AbortController();
  const host = createPremiereExportHost({
    ownerForEvent: (event: string) => event === 'editor' ? {projectId, windowId, isCurrent: () => flags.current} : null,
    signal: lifetime.signal,
    backend: client.api.nativePremiereExport,
    async chooseDirectory() {return flags.choice;},
    revealPath(file) {flags.revealed.push(file);},
    async openInPremiere(file, check) {
      flags.beforeOpen?.();
      if (!check()) return false;
      flags.opened.push(file);
      return true;
    },
    async premiereInstalled() {return flags.installed;},
  });
  const bridge = createPremiereExportBridge((channel, input) => {
    assert.equal(channel, PREMIERE_EXPORT_NATIVE_CHANNEL);
    return host.handle('editor', input);
  });
  return {bridge, host, flags, identity, bundle, xml, client, windowId};
}

test('Premiere selects a project-scoped destination, reveals only the package, and opens only its verified XML', async t => {
  const {bridge, host, flags, identity, bundle, xml} = fixture(t);
  assert.deepEqual(Object.keys(bridge).sort(), ['chooseDestination', 'openInPremiere', 'premiereInstalled', 'reveal']);
  assert.equal(Object.isFrozen(bridge), true);
  flags.choice = null;
  assert.equal(await bridge.chooseDestination(), null);
  flags.choice = path.dirname(bundle);
  const selected = await bridge.chooseDestination();
  assert.ok(selected);
  assert.deepEqual(Object.keys(selected).sort(), ['displayPath', 'token']);
  assert.equal(selected.displayPath, 'Temporary destination');
  await assert.rejects(bridge.openInPremiere({...identity, projectId: randomUUID()}), unavailable);
  const rendererPath = {...identity, path: '/untrusted.xml'};
  await assert.rejects(bridge.openInPremiere(rendererPath), invalid);
  assert.deepEqual(await host.handle('candidate', {kind: 'openInPremiere', identity}), {ok: false, error: unavailable});
  assert.deepEqual(flags.lookups, []);
  flags.done = false;
  assert.equal(await bridge.openInPremiere(identity), false);
  flags.done = true;
  assert.equal(await bridge.reveal(identity), true);
  flags.installed = false;
  assert.equal(await bridge.premiereInstalled(), false);
  assert.equal(await bridge.openInPremiere(identity), false);
  flags.installed = true;
  assert.equal(await bridge.openInPremiere(identity), true);
  assert.deepEqual(flags.lookups, ['xml', 'bundle', 'xml']);
  assert.deepEqual(flags.revealed, [bundle]);
  assert.deepEqual(flags.opened, [xml]);
  flags.beforeOpen = () => {
    renameSync(xml, path.join(bundle, 'old.xml'));
    writeFileSync(xml, '<xmeml/>');
  };
  assert.equal(await bridge.openInPremiere(identity), false);
  assert.deepEqual(flags.opened, [xml]);
});

test('abandoning a Premiere XML lookup stops only that request', async t => {
  const {client, identity, windowId, flags} = fixture(t);
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  let requestSignal: AbortSignal | undefined;
  flags.beforeLookup = async signal => {requestSignal = signal; entered.resolve(); await finish.promise;};
  const abort = new AbortController();
  const input = {...identity, windowId};
  const pending = client.api.nativePremiereExport.completedXml(input, {signal: abort.signal});
  await entered.promise;
  abort.abort();
  await assert.rejects(pending, {code: 'PROJECT_ENTRY_UNAVAILABLE'});
  assert.equal(requestSignal?.aborted, true);
  finish.resolve();
  flags.beforeLookup = undefined;
  assert.ok(await client.api.nativePremiereExport.completedXml(input));
  assert.deepEqual(flags.releases, []);
  client.api.release({windowId});
  await assert.rejects(client.api.nativePremiereExport.completedXml(input), {code: 'PROJECT_ENTRY_UNAVAILABLE'});
  assert.deepEqual(flags.releases, [windowId]);
});

test('macOS discovery checks the actual bundle ID before opening XML and rechecks its owner', async () => {
  const fake = '/Applications/Fake Premiere.app', real = '/Applications/Premiere Beta.app';
  const xml = '/temporary/Film Premiere/Film.xml';
  const opened: string[][] = [];
  let installed = true;
  const launcher = createPremiereMacLauncher(async (file, args) => {
    if (file === '/usr/bin/osascript') return {stdout: ''};
    if (file === '/usr/bin/mdfind') {
      assert.deepEqual(args, ['-0', 'kMDItemContentType == "com.apple.application-bundle" && kMDItemCFBundleIdentifier ==[c] "com.adobe.PremierePro*"']);
      return {stdout: fake + '\0' + real + '\0'};
    }
    if (file === '/usr/bin/plutil') {
      assert.deepEqual(args.slice(0, 5), ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-']);
      const valid = installed && args[5] === path.join(real, 'Contents', 'Info.plist');
      return {stdout: valid ? 'com.Adobe.PremierePro.Beta\n' : 'com.adobe.OtherApp\n'};
    }
    assert.equal(file, '/usr/bin/open');
    opened.push(args);
    return {stdout: ''};
  }, 'darwin');
  assert.equal(await launcher.premiereInstalled(), true);
  assert.equal(await launcher.openInPremiere(xml, () => false), false);
  assert.deepEqual(opened, []);
  assert.equal(await launcher.openInPremiere(xml, () => true), true);
  assert.deepEqual(opened, [['-a', real, xml]]);
  installed = false;
  assert.equal(await launcher.premiereInstalled(), false);
  assert.equal(await launcher.openInPremiere(xml, () => true), false);
});

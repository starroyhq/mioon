import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {
  createDesktopUpdate, DESKTOP_UPDATE_CHECK_INTERVAL_MS, DESKTOP_UPDATE_LATEST_URL, desktopUpdateNotes,
  desktopUpdateReleaseUrl, isDesktopUpdateExternalUrl,
} from '../apps/desktop/src/desktop-update.ts';
import type {DesktopUpdatePort} from '../apps/desktop/src/desktop-update.ts';
import {desktopUpdateStateSchema} from '../packages/contracts/src/desktop-update.ts';
import type {DesktopUpdateOffer, DesktopUpdateState} from '../packages/contracts/src/desktop-update.ts';

const currentVersion = '0.2.0', version = '0.2.1';
type CancellationToken = NonNullable<Parameters<DesktopUpdatePort['downloadUpdate']>[0]>;
type UpdateCheckResult = NonNullable<Awaited<ReturnType<DesktopUpdatePort['checkForUpdates']>>>;
type UpdateInfo = UpdateCheckResult['updateInfo'];
const digest = createHash('sha512').update('mock release package').digest('base64');
const file = `mioon-${version}-mac.zip`;
const info: UpdateInfo = {version, files: [{url: file, sha512: digest, size: 200}], path: file, sha512: digest,
  releaseDate: '2026-11-16T00:00:00.000Z', releaseNotes: ['<li>One</li><li>Two</li>'].join('')};

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = true;
  allowPrerelease = true;
  allowDowngrade = true;
  logger: DesktopUpdatePort['logger'] = console;
  checks = 0;
  tokens: CancellationToken[] = [];
  installs = 0;
  discarded = 0;
  outcome: Promise<UpdateCheckResult | null> = Promise.resolve({isUpdateAvailable: true, versionInfo: info, updateInfo: info});
  transfer: Promise<string[]> = Promise.resolve([file]);
  installError = false;
  stageForInstall?: () => Promise<void>;
  async checkForUpdates() { this.checks++; return this.outcome; }
  async downloadUpdate(token?: CancellationToken) {
    assert.ok(token);
    this.tokens.push(token);
    return token.createPromise<string[]>((resolve, reject) => {void this.transfer.then(resolve, reject);});
  }
  async discardDownload() { this.discarded++; }
  quitAndInstall() { this.installs++; if (this.installError) throw new Error('synthetic install failure'); }
}

function fixture(options: Partial<Parameters<typeof createDesktopUpdate>[0]> = {}) {
  const updater = new FakeUpdater();
  const states: DesktopUpdateState[] = [];
  const checks: {files: readonly string[]; offer: DesktopUpdateOffer; digest: string}[] = [];
  const engine = createDesktopUpdate({updater, enabled: true, currentVersion,
    changed: state => states.push(desktopUpdateStateSchema.parse(state)),
    verifyDownload: async (files, offer, signal, actualDigest) => {
      signal.throwIfAborted();
      checks.push({files, offer, digest: actualDigest});
    },
    ...options,
  });
  return {updater, engine, states, checks};
}

test('the production port is configured for manual download and user-authorized stable installation', async t => {
  const {updater, engine, states, checks} = fixture();
  t.after(engine.dispose);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.logger, null);
  assert.equal(engine.state().kind, 'idle');
  const available = await engine.start();
  assert.equal(available.kind, 'available');
  assert.deepEqual(available.offer, {version, currentVersion, notes: ['One', 'Two'], releaseDate: info.releaseDate, sizeBytes: 200});
  await engine.download('0.2.2');
  assert.equal(updater.tokens.length, 0);
  assert.equal(engine.setInstallOnQuit(version), false);
  assert.equal(engine.install(version), false);
  const transfer = Promise.withResolvers<string[]>();
  updater.transfer = transfer.promise;
  const downloading = engine.download(version);
  assert.equal(engine.state().kind, 'downloading');
  await Promise.resolve();
  updater.emit('download-progress', {percent: 41.8, transferred: 80, total: 200, bytesPerSecond: 10});
  assert.deepEqual(engine.state(), {kind: 'downloading', offer: available.offer, percent: 41, secondsRemaining: 12, transferredBytes: 80, totalBytes: 200});
  assert.equal(updater.autoInstallOnAppQuit, false);
  transfer.resolve([file]);
  assert.deepEqual(await downloading, {kind: 'ready', offer: available.offer, installOnQuit: false});
  assert.deepEqual(checks, [{files: [file], offer: available.offer, digest}]);
  assert.equal(engine.setInstallOnQuit('0.2.2'), false);
  assert.equal(engine.install('0.2.2'), false);
  assert.equal(engine.setInstallOnQuit(version), true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.installs, 0);
  assert.equal(engine.install(version, false), true);
  assert.equal(updater.autoRunAppAfterInstall, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(engine.install(version), false);
  assert.equal(updater.installs, 1);
  assert.deepEqual(states.map(state => state.kind), ['checking', 'available', 'downloading', 'downloading', 'ready', 'ready']);
});

test('disabled and prerelease app instances never check or start a timer', async t => {
  for (const options of [{enabled: false}, {currentVersion: '0.2.0-preview.1'}, {updater: null}]) {
    const {updater, engine, states} = fixture(options);
    t.after(engine.dispose);
    assert.equal((await engine.start()).kind, 'disabled');
    assert.equal((await engine.check()).kind, 'disabled');
    assert.equal(updater.checks, 0);
    assert.deepEqual(states, []);
  }
});

test('one startup check and manual calls share the in-flight library result, then poll every six hours', async t => {
  t.mock.timers.enable({apis: ['setInterval']});
  const {updater, engine} = fixture();
  t.after(engine.dispose);
  const pending = Promise.withResolvers<UpdateCheckResult>();
  updater.outcome = pending.promise;
  const startup = engine.start();
  assert.equal(engine.check(), startup);
  assert.equal(engine.start(), startup);
  await Promise.resolve();
  assert.equal(updater.checks, 1);
  pending.resolve({isUpdateAvailable: false, versionInfo: info, updateInfo: info});
  assert.equal((await startup).kind, 'idle');
  t.mock.timers.tick(DESKTOP_UPDATE_CHECK_INTERVAL_MS - 1);
  assert.equal(updater.checks, 1);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(updater.checks, 2);
  await engine.check();
  assert.equal(updater.checks, 2);
});

test('availability comes from the library, and a prerelease, mismatched tag or missing checksum cannot be installed', async t => {
  const {updater, engine} = fixture();
  t.after(engine.dispose);
  async function checkWith(info: UpdateInfo & {tag?: string}, isUpdateAvailable = true) {
    updater.outcome = Promise.resolve({isUpdateAvailable, versionInfo: info, updateInfo: info});
    return engine.check();
  }
  assert.equal((await checkWith(info, false)).kind, 'idle');
  assert.equal((await checkWith({...info, version: '0.2.1-dev.1'})).kind, 'idle');
  assert.equal((await checkWith({...info, tag: 'v0.3.0'})).kind, 'idle');
  assert.deepEqual(await checkWith({...info, files: []}), {kind: 'failed', stage: 'check'});
  assert.deepEqual(await checkWith({...info, files: [{...info.files[0]!, sha512: 'invalid'}]}), {kind: 'failed', stage: 'check'});
  assert.equal(engine.install(version), false);
  assert.equal((await checkWith({...info, tag: 'v' + version})).kind, 'available');
});

test('transfer cancellation ignores late outcomes and a retry uses a new library token', async t => {
  const {updater, engine, checks} = fixture();
  t.after(engine.dispose);
  await engine.check();
  const transfer = Promise.withResolvers<string[]>();
  updater.transfer = transfer.promise;
  const pending = engine.download(version);
  await Promise.resolve();
  assert.equal(engine.cancel(), true);
  assert.equal(engine.cancel(), false);
  transfer.resolve([file]);
  assert.equal((await pending).kind, 'available');
  assert.equal(updater.tokens[0]!.cancelled, true);
  assert.equal(updater.discarded, 1);
  assert.deepEqual(checks, []);
  assert.equal((await engine.download(version)).kind, 'ready');
  assert.notEqual(updater.tokens[0], updater.tokens[1]);
  assert.equal(checks.length, 1);
});

test('the state remains downloading until the verifier accepts, and refusal discards the pending update', async t => {
  const verification = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const {updater, engine} = fixture({verifyDownload: async () => {entered.resolve(); await verification.promise;}});
  t.after(engine.dispose);
  const offer = await engine.check();
  assert.equal(offer.kind, 'available');
  const downloaded = engine.download(version);
  await entered.promise;
  assert.equal(engine.state().kind, 'downloading');
  assert.equal(engine.install(version), false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  verification.reject(new Error('synthetic signature mismatch'));
  assert.deepEqual(await downloaded, {kind: 'failed', stage: 'download', offer: offer.offer});
  assert.equal(updater.discarded, 1);
  assert.equal(engine.setInstallOnQuit(version), false);
  assert.equal(engine.install(version), false);
});

test('a cancellation during verification cannot publish a later ready result', async t => {
  const verification = Promise.withResolvers<void>(), entered = Promise.withResolvers<AbortSignal>();
  const {updater, engine} = fixture({verifyDownload: async (_files, _offer, signal) => {entered.resolve(signal); await verification.promise;}});
  t.after(engine.dispose);
  await engine.check();
  const downloaded = engine.download(version);
  const signal = await entered.promise;
  assert.equal(engine.cancel(), true);
  assert.equal(signal.aborted, true);
  verification.resolve();
  assert.equal((await downloaded).kind, 'available');
  assert.equal(updater.discarded, 1);
  assert.equal(engine.install(version), false);
});

test('check, network and Squirrel errors are projected without source URLs or local paths', async t => {
  const installFailed = Promise.withResolvers<void>();
  const {updater, engine} = fixture({installFailed: installFailed.resolve});
  t.after(engine.dispose);
  updater.outcome = Promise.resolve(null);
  assert.deepEqual(await engine.check(), {kind: 'failed', stage: 'check'});
  updater.outcome = Promise.resolve({isUpdateAvailable: true, versionInfo: info, updateInfo: info});
  await engine.check();
  updater.transfer = Promise.reject(new Error('synthetic transfer failure'));
  void updater.transfer.catch(() => {});
  assert.deepEqual((await engine.download(version)).kind, 'failed');
  updater.transfer = Promise.resolve([file]);
  await engine.download(version);
  assert.equal(engine.install(version), true);
  updater.emit('error', new Error('synthetic Squirrel failure'));
  await installFailed.promise;
  assert.deepEqual(engine.state(), {kind: 'failed', stage: 'install', version, canRetry: true});
  assert.equal(engine.install(version), false);
  assert.equal(updater.discarded, 2);
});

test('a restart failure stays visible and an exact retry shares one freshly verified download', async t => {
  const {updater, engine, states, checks} = fixture({installFailure: {version, failures: 1}});
  t.after(engine.dispose);
  const failure = {kind: 'failed', stage: 'install', version, canRetry: true};
  assert.deepEqual(engine.state(), failure);
  updater.outcome = Promise.resolve(null);
  assert.deepEqual(await engine.start(), failure);
  assert.deepEqual(await engine.download('0.2.2'), failure);
  assert.equal(updater.checks, 1);

  updater.outcome = Promise.resolve({isUpdateAvailable: true, versionInfo: info, updateInfo: info});
  const [first, second] = await Promise.all([engine.download(version), engine.download(version)]);
  assert.equal(updater.checks, 2);
  assert.equal(updater.tokens.length, 1);
  assert.equal(first.kind, 'ready');
  assert.deepEqual(second, first);
  assert.equal(checks[0]?.digest, digest);
  assert.deepEqual(states.map(state => state.kind), ['downloading', 'ready']);
});

test('a replacement offer is never downloaded by a stale retry and checks cannot reopen a capped target', async t => {
  const newer = '0.2.2';
  const newerInfo = {...info, version: newer, files: [{url: `mioon-${newer}-mac.zip`, sha512: digest}]};
  const replacement = {isUpdateAvailable: true, versionInfo: newerInfo, updateInfo: newerInfo};
  const retry = fixture({installFailure: {version, failures: 1}});
  t.after(retry.engine.dispose);
  retry.updater.outcome = Promise.resolve(replacement);
  const offered = await retry.engine.download(version);
  assert.equal(offered.kind, 'available');
  assert.equal(offered.offer.version, newer);
  assert.equal(retry.updater.tokens.length, 0);

  const capped = fixture({installFailure: {version, failures: 2}});
  t.after(capped.engine.dispose);
  const failure = {kind: 'failed', stage: 'install', version, canRetry: false};
  assert.deepEqual(await capped.engine.start(), failure);
  assert.deepEqual(await capped.engine.download(version), failure);
  assert.equal(capped.updater.checks, 1);
  capped.updater.outcome = Promise.resolve(replacement);
  assert.equal((await capped.engine.check()).kind, 'available');
  capped.updater.outcome = Promise.resolve({isUpdateAvailable: true, versionInfo: info, updateInfo: info});
  assert.deepEqual(await capped.engine.check(), failure);
  assert.deepEqual(await capped.engine.download(version), failure);
  assert.equal(capped.updater.tokens.length, 0);
});

test('native Squirrel staging starts only on an explicit, exact installation and precedes quit', async t => {
  const {updater, engine} = fixture();
  t.after(engine.dispose);
  const stage = Promise.withResolvers<void>();
  let staged = 0;
  updater.stageForInstall = () => {staged++; return stage.promise;};
  await engine.check();
  await engine.download(version);
  assert.equal(staged, 0);
  assert.equal(engine.install('0.2.2'), false);
  engine.setInstallOnQuit(version);
  assert.equal(staged, 0);
  assert.equal(engine.install(version), true);
  assert.equal(engine.install(version), false);
  assert.equal(staged, 1);
  assert.equal(updater.installs, 0);
  stage.resolve();
  await stage.promise;
  assert.equal(updater.installs, 1);
});

test('duplicate native error channels can only discard and notify once', async t => {
  const failed = Promise.withResolvers<void>();
  let failures = 0;
  const {updater, engine} = fixture({installFailed: () => {failures++; failed.resolve();}});
  t.after(engine.dispose);
  const stage = Promise.withResolvers<void>();
  updater.stageForInstall = () => stage.promise;
  await engine.check();
  await engine.download(version);
  assert.equal(engine.install(version), true);
  const error = new Error('synthetic Squirrel verification failure');
  updater.emit('error', error);
  stage.reject(error);
  await failed.promise;
  assert.equal(failures, 1);
  assert.equal(updater.discarded, 1);
  assert.equal(updater.installs, 0);
  assert.equal(engine.state().kind, 'failed');
});

test('release notes become bounded text items and only the two exact GitHub release paths open externally', () => {
  assert.deepEqual(desktopUpdateNotes([
    {version, note: '<!-- mioon-release:{"tag":"v0.2.1"} --><p>One &amp; two</p><ul><li>三</li><li><a href="https://example.invalid">Link</a></li></ul>'},
    {version, note: '<script>Synthetic content</script>- [Read me](https://example.invalid)\n&#x4e94;\nSix'},
  ]), ['One & two', '三', 'Link', 'Read me', '五']);
  assert.equal(desktopUpdateNotes('😀'.repeat(210))[0]!.length, 400);
  assert.equal(desktopUpdateReleaseUrl(version), 'https://github.com/starroyhq/mioon/releases/tag/v0.2.1');
  assert.equal(desktopUpdateReleaseUrl('0.2.1-beta'), null);
  assert.equal(isDesktopUpdateExternalUrl(DESKTOP_UPDATE_LATEST_URL), true);
  assert.equal(isDesktopUpdateExternalUrl(desktopUpdateReleaseUrl(version)!), true);
  for (const url of [
    'https://github.com/starroyhq/mioon/releases/tag/v0.2.1?parameter=1',
    'https://github.com/starroyhq/mioon/releases/tag/v0.2.1#extra',
    'https://github.com/starroyhq/mioon/releases/tag/v0.2.1/',
    'https://github.com/starroyhq/mioon/releases/tag/%760.2.1',
    'https://github.com/starroyhq/mioon/releases/tag/v00.2.1',
    'https://github.com/starroyhq/mioon/releases/tag/v0.2.1-beta',
    'https://github.com/example/mioon/releases/latest',
    'https://github.com@example.invalid/starroyhq/mioon/releases/latest',
    'http://github.com/starroyhq/mioon/releases/latest',
  ]) assert.equal(isDesktopUpdateExternalUrl(url), false);
});

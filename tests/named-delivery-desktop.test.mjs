import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {timelineDeliveryBasename, timelineDeliveryContentDisposition} from '@mioon/contracts/timeline-delivery';
import {installSessionPolicy, isAllowedDownload} from '../apps/desktop/src/security.mjs';
import {namedTimelineDownloadBasename} from '../apps/desktop/src/timeline-delivery-download.ts';

const origin = 'http://127.0.0.1:41923';
const exportId = '12345678-1234-4234-8234-123456789abc';
const assetId = '22345678-1234-4234-8234-123456789abc';
const otherId = '32345678-1234-4234-8234-123456789abc';
const url = `${origin}/media/${assetId}?download=1&exportId=${exportId}`;
const header = name => timelineDeliveryContentDisposition(name, exportId) + `; mioon-export-id="${exportId}"; mioon-asset-id="${assetId}"`;
function fixture({directory = {downloadsDirectory: '/trusted/Downloads'}, name = '海边最终版', overrides = {}, window = {}, navigation, contents} = {}) {
  const session = new EventEmitter();
  for (const method of ['setPermissionRequestHandler', 'setPermissionCheckHandler', 'setDevicePermissionHandler', 'setDisplayMediaRequestHandler']) session[method] = () => {};
  session.webRequest = {onBeforeRequest() {}};
  const webContents = {getURL: () => navigation ?? `${origin}/?project=${otherId}`};
  const win = {isDestroyed: () => false, webContents, ...window};
  let options, prevented = 0, writes = 0;
  const item = new EventEmitter();
  Object.assign(item, {getURL: () => url, getURLChain: () => [url], getInitiatorOrigin: () => origin,
    getMimeType: () => 'video/mp4', getContentDisposition: () => header(name),
    getFilename: () => assert.fail('A renderer-controlled suggested filename is never consulted'),
    setSaveDialogOptions: value => {options = value;}, setSavePath: () => {writes++; assert.fail('Must keep native Save As');}, ...overrides});
  installSessionPolicy(session, origin, () => win, directory);
  session.emit('will-download', {preventDefault: () => {prevented++;}}, item, contents ?? webContents);
  return {item, options, prevented, writes};
}

test('named download uses actual response metadata and trusted Downloads only, with native overwrite and cancellation', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mioon-download-cancel-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const before = await readdir(directory);
  const f = fixture({directory: {downloadsDirectory: directory}});
  assert.equal(f.prevented, 0); assert.equal(f.writes, 0);
  assert.deepEqual(f.options, {title: '保存视频', defaultPath: path.join(directory, timelineDeliveryBasename('海边最终版', exportId)),
    filters: [{name: 'MP4 视频', extensions: ['mp4']}], properties: ['showOverwriteConfirmation']});
  f.item.emit('done', {}, 'cancelled');
  assert.deepEqual(await readdir(directory), before, 'cancel remains Chromium-owned with no helper write');
});

test('desktop accepts canonical named query and legacy managed routes, rejecting ambiguous or injected syntax', () => {
  for (const good of [url, `${origin}/media/${assetId}`, `${origin}/media/${assetId}?download`, `${origin}/media/${assetId}?download=1`]) assert.equal(isAllowedDownload(good, origin), true, good);
  for (const bad of [url + '&download=1', url + `&exportId=${exportId}`, url + '&filename=evil.mp4', url + '&path=/tmp/evil',
    url + '%0A', url + '\n', url.replace('download=1', 'download=0'), url.replace('download=1&', ''), url + '#name', url.replace(origin, 'http://localhost:41923'),
    url.replace(origin, 'https://example.invalid'), `${origin}/media/${assetId}?download&download`, `${origin}/media/${assetId}?download=no`,
    `${origin}/media/../${assetId}?download=1&exportId=${exportId}`, `${origin}/media/${assetId}?download=1&exportId=invalid`]) assert.equal(isAllowedDownload(bad, origin), false, bad);
});

test('actual frame initiator, current window, nonempty same-origin redirect chain and final identity must all agree', () => {
  const cases = [
    {overrides: {getInitiatorOrigin: () => ''}}, {overrides: {getInitiatorOrigin: () => 'null'}},
    {overrides: {getInitiatorOrigin: () => 'https://example.invalid'}}, {overrides: {getInitiatorOrigin: () => origin + '/'}},
    {overrides: {getInitiatorOrigin: undefined}}, {overrides: {getMimeType: () => 'application/octet-stream'}},
    {overrides: {getURLChain: () => []}}, {overrides: {getURLChain: () => [url.replace(origin, 'https://example.invalid'), url]}},
    {overrides: {getURLChain: () => [url.replace(exportId, otherId), url]}}, {overrides: {getURLChain: () => [url.replace(assetId, otherId), url]}},
    {overrides: {getURLChain: () => [url, url + '&download=1']}}, {overrides: {getURLChain: () => [url.replace('download=1&', ''), url]}},
    {overrides: {getURLChain: () => Array(33).fill(url)}}, {overrides: {getURL: () => url.replace(assetId, otherId)}},
    {window: {isDestroyed: () => true}}, {navigation: origin + '/api/rpc'}, {navigation: 'https://example.invalid/'},
    {contents: {getURL: () => origin + '/'}},
  ];
  for (const setup of cases) {const f = fixture(setup); assert.equal(f.prevented, 1); assert.equal(f.options, undefined); assert.equal(f.writes, 0);}
  assert.equal(fixture({overrides: {getURLChain: () => [url, url]}}).prevented, 0, 'same-identity redirects are safe');
});

test('only complete bound response headers can supply a named default', () => {
  const good = header('Final cut'), identity = {exportId, assetId};
  assert.equal(namedTimelineDownloadBasename(good, identity), timelineDeliveryBasename('Final cut', exportId));
  const cases = [undefined, '', good.repeat(40), good + '\r\nX-Bad: true', good + '; filename="evil.mp4"',
    timelineDeliveryContentDisposition('Final cut', exportId), good.replace(`mioon-asset-id="${assetId}"`, `mioon-asset-id="${otherId}"`),
    good.replace(`mioon-export-id="${exportId}"`, `mioon-export-id="${otherId}"`), good.replace('filename="Final cut', 'filename="different'),
    good.replace('Final%20cut-', '..%2Fbad-'), good.replace('Final%20cut-', '%E2%80%AEbad-'), good.replace('Final%20cut-', 'CON-'),
    good.replace('Final cut-', '../bad-'), good.replace('UTF-8', 'ISO-8859-1')];
  for (const value of cases) {assert.equal(namedTimelineDownloadBasename(value, identity), null); const f = fixture({overrides: {getContentDisposition: () => value}}); assert.equal(f.prevented, 1); assert.equal(f.options, undefined);}
});

test('path, bidi, reserved and extension-like display names remain unchanged metadata but safe native basenames', () => {
  for (const name of ['../outside/path\\evil.exe', 'CON', 'LPT1.mp4', 'A\u202Egnp', ' ... ', '交付'.repeat(60)]) {
    const f = fixture({name}); assert.equal(f.prevented, 0, name);
    assert.equal(f.options.defaultPath, path.join('/trusted/Downloads', timelineDeliveryBasename(name, exportId)));
    assert.equal(path.dirname(f.options.defaultPath), '/trusted/Downloads');
    assert.match(path.basename(f.options.defaultPath), new RegExp(`-${exportId.slice(-12)}\\.mp4$`));
    assert.doesNotMatch(path.basename(f.options.defaultPath), /[\\/\u202e]/u);
  }
});

test('legacy unnamed and storyboard downloads retain their old default and always require the real initiator', () => {
  const legacy = `${origin}/media/${assetId}?download`;
  for (const directory of [{downloadsPath: '/tmp/video.mp4'}, {downloadsDirectory: '/trusted/Downloads'}]) {
    const f = fixture({directory, overrides: {getURL: () => legacy, getURLChain: () => [legacy], getContentDisposition: () => assert.fail('Legacy does not infer a name')}});
    assert.equal(f.prevented, 0); assert.equal(f.options.defaultPath, directory.downloadsPath ?? '/trusted/Downloads/mioon.mp4');
    assert.deepEqual(f.options.properties, ['showOverwriteConfirmation']);
  }
  const f = fixture({overrides: {getURL: () => legacy, getURLChain: () => [legacy], getInitiatorOrigin: () => ''}});
  assert.equal(f.prevented, 1); assert.equal(f.options, undefined);
});

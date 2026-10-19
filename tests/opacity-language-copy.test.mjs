import test, {after, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import cp from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {LOCALES, LANGUAGE_LABELS, isLocale, normalizeLocale, translate, validateCatalogs} from '../packages/i18n/src/index.ts';
import {opacityEnvelopeMessages} from '../packages/i18n/src/catalogs/opacity-envelope.ts';
import {opacityRestoredApplicationMessages} from '../packages/i18n/src/catalogs/opacity-restored-application.ts';
import {acceptsOpacityEnvelopeText, validateRawOpacityEnvelope} from '../apps/web/src/clip-opacity-envelope-state.ts';
import {reopenOpacityCandidateApplicationStore, reopenRestoredOpacityCandidateApplicationStore} from '../packages/business/src/opacity-candidate-store.ts';
import {createOpacityCandidateApplicationServices} from '../packages/business/src/opacity-candidate-services.ts';
import {createOpacityCandidateWorkspaceBackup, restoreOpacityCandidateWorkspaceBackup} from '../packages/business/src/opacity-candidate-backup.ts';
import {createOpacityCandidateTimelineDeliveryGuards, readOpacityCandidateApplicationSource} from '../packages/business/src/opacity-candidate-delivery.ts';
import {readTimelineExportPreviewMedia, readTimelineDeliveryDownload} from '../packages/business/src/timeline-delivery-read.ts';
import {opacityBackupFixture, hash, opacityBackupStamp} from './helpers/opacity-backup-fixture.mjs';

// The copy is checked against actual cold42 ->43 permissions with opaque bytes,
// never a decoder, provider or listening backend.
let forbiddenAttempts = 0;
const forbidden = () => {forbiddenAttempts++; throw Error('Language qualification forbids listeners and subprocesses.');};
mock.method(http.Server.prototype, 'listen', forbidden);
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) mock.method(cp, name, forbidden);
syncBuiltinESMExports();
after(() => {mock.restoreAll(); syncBuiltinESMExports(); assert.equal(forbiddenAttempts, 0);});

test('restored asset copy distinguishes previewable imports from retained but held outputs', async t => {
  const f = await opacityBackupFixture(t), source = reopenOpacityCandidateApplicationStore(f.source);
  const services = createOpacityCandidateApplicationServices(source);
  const outputId = randomUUID(), bytes = Buffer.from('OWNED_SYNTHETIC_CAPTURED_OUTPUT');
  let captured, output;
  try {
    const accepted = await services.call('timeline.render', {projectId: f.projectId, requestId: randomUUID(), expectedRevision: 3, purpose: 'export'});
    const relativePath = `media/export-${accepted.id}-${randomUUID()}.mp4`;
    fs.writeFileSync(path.join(f.source, relativePath), bytes, {mode: 0o600, flag: 'wx'});
    output = {id: outputId, projectId: f.projectId, name: 'Captured output', mimeType: 'video/mp4', provenance: 'export', relativePath,
      sha256: hash(bytes), sizeBytes: bytes.length, url: `/media/${outputId}`, createdAt: opacityBackupStamp};
    captured = {...accepted, status: 'succeeded', assetId: outputId, url: output.url, updatedAt: opacityBackupStamp};
    source.put('assets', output); source.put('exports', captured);
  } finally {await services.drain(); source.close();}
  await createOpacityCandidateWorkspaceBackup({source: f.source, destination: f.backup});
  await restoreOpacityCandidateWorkspaceBackup({directory: f.backup, destination: f.destination});
  const store = reopenRestoredOpacityCandidateApplicationStore(f.destination);
  const restoredServices = createOpacityCandidateApplicationServices(store);
  f.manage(async () => {await restoredServices.drain(); store.close();});
  const page = await restoredServices.call('project.get', {projectId: f.projectId});
  assert.ok(page.assets.some(asset => asset.id === f.assetId));
  assert.ok(page.assets.some(asset => asset.id === outputId), 'held output is still visible in the asset library');
  assert.deepEqual(page.restore.heldExportIds, [captured.id]);
  assert.equal(page.exports[0].status, 'succeeded', 'historical success is retained, not treated as a new playback grant');
  assert.ok(readOpacityCandidateApplicationSource(store, f.assetId));
  assert.equal(readOpacityCandidateApplicationSource(store, outputId), null);
  const guards = createOpacityCandidateTimelineDeliveryGuards(store);
  assert.equal(readTimelineExportPreviewMedia(store.db, new URL(`http://127.0.0.1:4319/media/${outputId}?preview=1&exportId=${captured.id}`), guards), null);
  assert.equal(readTimelineDeliveryDownload(store.db, new URL(`http://127.0.0.1:4319/media/${outputId}?download=1&exportId=${captured.id}`), guards), null);
  assert.deepEqual(fs.readFileSync(path.join(f.destination, output.relativePath)), bytes, 'held bytes remain preserved; copy must not imply deletion');
  const meanings = {
    'zh-Hans': [/受支持的导入素材/u, /历史成片记录仍保留/u, /不能播放或下载这些成片/u],
    'zh-Hant': [/受支援的匯入素材/u, /歷史成片記錄仍保留/u, /無法播放或下載這些成片/u],
    en: [/supported imported assets/u, /Captured outputs remain in the history/u, /cannot play or download them/u],
    ja: [/対応する読み込み済み素材/u, /復元前の書き出しの記録は保持/u, /再生やダウンロードはできません/u],
  };
  for (const locale of LOCALES) {
    const copy = translate(locale, 'opacity.restored.assetsReadOnly');
    for (const meaning of meanings[locale]) assert.match(copy, meaning);
  }
});

test('Japanese opacity guidance matches duplicate-frame and full-width input refusal', () => {
  const envelope = points => ({opacityEnvelope: {profileId: 'mioon-clip-linear-opacity-v1', points}});
  assert.equal(validateRawOpacityEnvelope(envelope([{frame: '0', opacity: '.4'}, {frame: '0', opacity: '1'}]), 10).valid, false);
  assert.equal(validateRawOpacityEnvelope(envelope([{frame: '0', opacity: '.4'}, {frame: '10', opacity: '1'}]), 10).valid, true);
  assert.match(translate('ja', 'opacity.envelope.bounds', {duration: 10}), /重複しない昇順/u);
  for (const value of ['０．４', '1２', '１e-２']) assert.equal(acceptsOpacityEnvelopeText('opacity', value), false);
  assert.equal(acceptsOpacityEnvelopeText('opacity', '.4'), true);
  assert.match(translate('ja', 'opacity.envelope.rejected', {limit: 32}), /半角数字/u);
});

test('opacity messages keep all four catalogs complete and OS regions normalize to region-neutral labels', () => {
  assert.deepEqual(validateCatalogs(opacityEnvelopeMessages), []);
  assert.deepEqual(validateCatalogs(opacityRestoredApplicationMessages), []);
  assert.deepEqual(LOCALES, ['zh-Hans', 'zh-Hant', 'en', 'ja']);
  assert.equal(LANGUAGE_LABELS['zh-Hant'], '繁體中文');
  for (const [input, expected] of [['zh-TW', 'zh-Hant'], ['zh-HK', 'zh-Hant'], ['zh-Hant-CN', 'zh-Hant'], ['zh-Hans-TW', 'zh-Hans'], ['en-US', 'en'], ['ja-JP', 'ja']]) {
    assert.equal(normalizeLocale(input), expected);
    assert.equal(isLocale(input), false, 'OS region is input normalization, never another exposed catalog');
  }
});

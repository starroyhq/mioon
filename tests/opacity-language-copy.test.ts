import test, {after, mock} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {LOCALES, LANGUAGE_LABELS, isLocale, normalizeLocale, translate, validateCatalogs} from '../packages/i18n/src/index.ts';
import {opacityEnvelopeMessages} from '../packages/i18n/src/catalogs/opacity-envelope.ts';
import {opacityRestoredApplicationMessages} from '../packages/i18n/src/catalogs/opacity-restored-application.ts';
import {acceptsOpacityEnvelopeText, validateRawOpacityEnvelope} from '../apps/web/src/clip-opacity-envelope-state.ts';

// The copy checks never start a decoder, provider, listening backend or subprocess.
let forbiddenAttempts = 0;
const forbidden = () => {forbiddenAttempts++; throw Error('Language qualification forbids listeners and subprocesses.');};
mock.method(http.Server.prototype, 'listen', forbidden);
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) mock.method(cp as never, name as never, forbidden);
syncBuiltinESMExports();
after(() => {mock.restoreAll(); syncBuiltinESMExports(); assert.equal(forbiddenAttempts, 0);});

test('Japanese opacity guidance matches duplicate-frame and full-width input refusal', () => {
  const envelope = (points: Array<{frame: string; opacity: string}>) => ({opacityEnvelope: {profileId: 'mioon-clip-linear-opacity-v1', points}});
  assert.equal(validateRawOpacityEnvelope(envelope([{frame: '0', opacity: '.4'}, {frame: '0', opacity: '1'}]) as never, 10).valid, false);
  assert.equal(validateRawOpacityEnvelope(envelope([{frame: '0', opacity: '.4'}, {frame: '10', opacity: '1'}]) as never, 10).valid, true);
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

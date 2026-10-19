import test from 'node:test';
import assert from 'node:assert/strict';
import {preflightErrorMessage, preflightIssueMessage, createExportPreflightController} from '../apps/web/src/export-preflight-state.js';
import {translate} from '../packages/i18n/src/index.ts';
import {OPACITY_CANDIDATE_PREFLIGHT_MESSAGES} from '../packages/business/src/opacity-candidate-preflight.ts';
import {TIMELINE_COLOUR_PREFLIGHT_CODES} from '../packages/contracts/src/timeline-colour.ts';

const locales = ['zh-Hans', 'zh-Hant', 'en', 'ja'];
const codes = [...TIMELINE_COLOUR_PREFLIGHT_CODES, ...Object.keys(OPACITY_CANDIDATE_PREFLIGHT_MESSAGES)];
const secret = '/private/source.mp4 token=private-synthetic-never-display';

test('candidate source/LUT refusal codes have precise safe explanations in all four locales', () => {
  assert.equal(new Set(codes).size, 14);
  for (const locale of locales) for (const code of codes) {
    const expected = translate(locale, `export.preflight.issue.${code}`);
    assert.equal(preflightIssueMessage({code, severity: 'error', message: secret}, locale), expected);
    assert.equal(preflightErrorMessage({code, message: secret, details: {path: secret}}, locale), expected);
    assert.notEqual(expected, translate(locale, 'export.preflight.issue.unknownError'));
    assert.ok(!expected.includes('/private/') && !expected.includes('token='));
  }
});

test('custom-preset capability refusal retains the actual source reason and never creates a checked or unchecked export intent', async () => {
  let sourceReads = 0, capabilityReads = 0;
  const projectId = '70000000-0000-4000-8000-000000000001';
  const controller = createExportPreflightController({
    read: () => {sourceReads++; throw Error('A known refusal must stop further work');},
    readCapabilities: async () => {capabilityReads++; throw Object.assign(Error(secret), {code: 'TIMELINE_COLOUR_LOOK_UNAVAILABLE'});},
  });
  controller.setContext({scope: 'candidate', projectId, timelineId: '70000000-0000-4000-8000-000000000002', revision: 1, connected: true,
    exportSettings: {profileId: 'mp4_h264_v1', resolution: 'native', rateControl: {mode: 'crf', quality: 'standard'}}, settingsVersion: 1});
  controller.setVisible(true);
  try {
    await controller.check();
    const state = controller.getState();
    assert.equal(state.phase, 'error');
    assert.equal(state.errorCode, 'TIMELINE_COLOUR_LOOK_UNAVAILABLE');
    assert.equal(state.error, translate('zh-Hans', 'export.preflight.issue.TIMELINE_COLOUR_LOOK_UNAVAILABLE'));
    assert.equal(state.report, null);assert.equal(state.binding, null);assert.equal(state.uncheckedIntent, null);
    assert.equal(capabilityReads, 1);assert.equal(sourceReads, 0);
    assert.ok(!JSON.stringify(state).includes(secret));
  } finally {controller.dispose();}
});

test('unknown refusal codes keep sanitized fallback and never display backend text', () => {
  for (const locale of locales) {
    assert.equal(preflightIssueMessage({code: 'UNRECOGNIZED_SOURCE', severity: 'error', message: secret}, locale), translate(locale, 'export.preflight.issue.unknownError'));
    assert.equal(preflightErrorMessage({code: 'UNRECOGNIZED_SOURCE', message: secret}, locale), translate(locale, 'export.preflight.error.failed'));
  }
});

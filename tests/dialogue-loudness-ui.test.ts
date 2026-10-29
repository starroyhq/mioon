import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { translate } from '../packages/i18n/src/index.ts';
import { clipLoudnessMessages } from '../packages/i18n/src/catalogs/clip-loudness.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('the dialogue loudness card renders its target, each kind of row and the apply control', () => {
  const fixture = `
    import * as React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server.browser';
    import TimelineDialogueLoudness from './TimelineDialogueLoudness.tsx';
    const controller = { setDraft: () => true, analyze: async () => true, cancel: () => {}, toggle: () => true, apply: async () => true, revoke: () => {} };
    const clips = [{ id: 'a', name: 'Opening', trackId: 'voice', assetId: 'x', startFrame: 0, durationFrames: 60, gain: 1, audioRole: 'human' }];
    const base = { scope: 'p:1:w', executionScope: '1', projectId: 'p', timelineId: 't', revision: 4, sourceIdentity: 's', clips,
      tracks: [{ id: 'voice', name: 'Voice', orderIndex: 0, muted: false }], assetHashes: { x: 'h' }, connected: true, visible: true, restored: false,
      hasUnsavedDrafts: false, pending: false, draft: { integratedLufs: '-14', truePeakCeilingDbtp: '-1' }, version: 1, phase: 'idle', rows: [],
      target: null, progress: { done: 0, total: 0 }, applied: 0, error: '' };
    const row = (clipId, patch) => ({ clipId, name: 'Line ' + clipId, trackName: 'Voice', startFrame: 0, gain: 1, selected: false, ...patch });
    const rows = [
      row('a', { status: 'measured', integratedLufs: -20, truePeakDbtp: -9, requiredGainDb: 4, afterGain: 1.5849, afterTruePeakDbtp: -5, meetsTruePeak: true, selected: true }),
      row('b', { status: 'measured', integratedLufs: -19, truePeakDbtp: -2, requiredGainDb: 3, afterGain: 1.4125, afterTruePeakDbtp: 1, meetsTruePeak: false }),
      row('c', { status: 'unavailable', integratedLufs: null, truePeakDbtp: null, reason: 'NO_VALID_LOUDNESS' }),
      row('d', { status: 'failed', error: '测量超时' }),
      row('e', { status: 'skipped', skip: 'muted' }),
      row('f', { status: 'skipped', skip: 'tooLong' }),
    ];
    const render = state => renderToStaticMarkup(<TimelineDialogueLoudness loudness={{ state: { ...base, ...state }, controller }} />);
    export const markup = {
      idle: render({}),
      ready: render({ phase: 'ready', rows, progress: { done: 3, total: 3 } }),
      nothing: render({ phase: 'ready', rows: rows.map(item => ({ ...item, selected: false })) }),
      measuring: render({ phase: 'measuring', rows: rows.map((item, index) => index === 1 ? { ...item, status: 'measuring' } : item), progress: { done: 1, total: 3 } }),
      applied: render({ phase: 'applied', applied: 2 }),
      none: render({ clips: [{ ...clips[0], audioRole: 'music' }] }),
      restored: render({ restored: true }),
      dirty: render({ hasUnsavedDrafts: true }),
      applying: render({ phase: 'applying', pending: true, rows }),
      skippedOnly: render({ tracks: [{ id: 'voice', name: 'Voice', orderIndex: 0, muted: true }] }),
    };
  `;
  const script = `
    import { build } from 'esbuild';
    const { outputFiles } = await build({
      stdin: { contents: ${JSON.stringify(fixture)}, loader: 'tsx', resolveDir: ${JSON.stringify(resolve(root, 'apps/web/src'))} },
      bundle: true, format: 'esm', platform: 'browser', write: false, loader: { '.css': 'empty' },
      define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
    });
    const { markup } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
    process.stdout.write(JSON.stringify(markup));
    process.exit(0);
  `;
  const markup = JSON.parse(execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input: script, encoding: 'utf8', timeout: 30_000 })) as Record<string, string>;
  const tag = (html: string, testId: string): string => html.match(new RegExp(`<(?:button|input)[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';
  const row = (html: string, clipId: string): string => html.match(new RegExp(`<li[^>]*data-testid="dialogue-loudness-row-${clipId}"[^>]*>.*?</li>`))?.[0] ?? '';
  assert.match(markup.idle, /对白响度匹配/);
  assert.match(tag(markup.idle, 'dialogue-loudness-target-lufs'), /value="-14"/);
  assert.match(tag(markup.idle, 'dialogue-loudness-target-peak'), /value="-1"/);
  assert.doesNotMatch(tag(markup.idle, 'dialogue-loudness-analyze'), /\sdisabled=""/, 'class names mention disabled: variants, so match the attribute');
  assert.doesNotMatch(markup.idle, /dialogue-loudness-apply/, 'nothing can be applied before measuring');
  assert.match(markup.idle, /每段最长 60 秒/);

  assert.match(markup.ready, /已测量 3 段，建议调整 1 段/, 'a reading without a suggestion still counts as measured');
  assert.match(row(markup.ready, 'a'), /当前 -20\.0 LUFS · 真峰值 -9\.0 dBTP/);
  assert.match(row(markup.ready, 'a'), /建议 \+4\.0 dB（增益 1\.00 → 1\.58）/);
  assert.match(tag(markup.ready, 'dialogue-loudness-select-a'), /checked=""/);
  assert.doesNotMatch(tag(markup.ready, 'dialogue-loudness-select-b'), /checked=""/);
  assert.match(row(markup.ready, 'b'), /data-testid="dialogue-loudness-peak-b"[^>]*>调整后真峰值约 1\.0 dBTP，超过上限/);
  assert.match(row(markup.ready, 'c'), /静音、太短或低于门限/);
  assert.doesNotMatch(row(markup.ready, 'c'), /type="checkbox"/, 'an unmeasured clip offers no choice');
  assert.match(row(markup.ready, 'd'), /测量失败：测量超时/);
  assert.match(row(markup.ready, 'e'), /所在轨道已静音，跳过/);
  assert.match(row(markup.ready, 'f'), /超过 60 秒，无法测量/);
  assert.match(markup.ready, /data-testid="dialogue-loudness-apply"[^>]*>应用到 1 段</);
  assert.doesNotMatch(tag(markup.ready, 'dialogue-loudness-apply'), /\sdisabled=""/);
  assert.match(markup.ready, /撤销一次即可全部复原/);
  assert.match(tag(markup.nothing, 'dialogue-loudness-apply'), /\sdisabled=""/, 'an empty selection cannot be applied');

  assert.match(markup.measuring, /正在测量第 2\/3 段…/);
  assert.match(tag(markup.measuring, 'dialogue-loudness-analyze'), /\sdisabled=""/);
  assert.ok(tag(markup.measuring, 'dialogue-loudness-stop'));
  assert.match(tag(markup.measuring, 'dialogue-loudness-target-lufs'), /\sdisabled=""/, 'the target cannot change mid-pass');

  assert.match(markup.applied, /已调整 2 段对白的增益/);
  assert.match(markup.none, /data-testid="dialogue-loudness-none"/);
  assert.doesNotMatch(markup.none, /dialogue-loudness-analyze/);
  assert.equal(markup.restored, '', 'restored workspaces cannot measure or apply');
  assert.equal(markup.dirty, '', 'unsaved drafts hide the card, as for the whole-timeline candidate');
  assert.match(markup.applying, /正在保存增益…/, 'the card stays while its own edit is pending');
  assert.match(tag(markup.skippedOnly, 'dialogue-loudness-analyze'), /\sdisabled=""/, 'nothing to measure, nothing to start');
  assert.match(row(markup.skippedOnly, 'a'), /所在轨道已静音，跳过/, 'the reason shows before any measurement');
  assert.match(tag(markup.applying, 'dialogue-loudness-apply'), /\sdisabled=""/);
});

test('every dialogue loudness message exists in four locales and the delivery panel binds measurement and the one-edit apply', () => {
  const keys = Object.keys(clipLoudnessMessages).filter(key => key.startsWith('audio.loudness.dialogue.'));
  assert.ok(keys.length >= 25);
  for (const key of keys) for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const)
    assert.ok(translate(locale, key as never, { count: 2, selected: 1, done: 1, total: 2, seconds: 60, lufs: -20, peak: -3, db: '+4.0', before: '1.00', after: '1.58', reason: 'x', name: 'Line' } as never).length > 0, `${locale} ${key}`);
  const app = readFileSync(resolve(root, 'apps/web/src/App.tsx'), 'utf8');
  assert.match(app, /<TimelineDialogueLoudness loudness=\{dialogueLoudness\} \/><TimelineMixLoudness /, 'the card sits above the whole-timeline candidate');
  assert.match(app, /const mix = timelineMixLoudnessContext\(\)/, 'it shares the whole-timeline fences');
  assert.match(app, /rpc\('timeline\.clip\.loudness', input, options as never\)/);
  assert.match(app, /mutateTimeline\('timeline\.clip\.setGains', \{ gains \}, expectedRevision, \{ errorMessage: dialogueGainsError \}\)/);
});

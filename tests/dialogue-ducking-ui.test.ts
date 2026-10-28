import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { translate } from '../packages/i18n/src/index.ts';
import { volumeEnvelopeMessages } from '../packages/i18n/src/catalogs/volume-envelope.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('the dialogue ducking tool renders its settings, the missing-track state and the blocked state', () => {
  const fixture = `
    import * as React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server.browser';
    import ClipDialogueDuckingControls from './ClipDialogueDuckingControls.tsx';
    const music = { id: 'music', trackId: 'bed', assetId: 'song', startFrame: 0, durationFrames: 300 };
    const line = { id: 'line', trackId: 'voice', assetId: 'take', startFrame: 30, durationFrames: 90, audioRole: 'human' };
    const tracks = [{ id: 'bed', name: 'Music' }, { id: 'voice', name: 'Voice' }];
    const common = { timelineRevision: 4, hasEnvelope: false, readWaveform: async () => null, requestWaveform: async () => null, onApply: () => {} };
    export const markup = {
      ready: renderToStaticMarkup(<ClipDialogueDuckingControls {...common} clip={music} clips={[music, line]} tracks={tracks} disabled={false} />),
      alone: renderToStaticMarkup(<ClipDialogueDuckingControls {...common} clip={music} clips={[music]} tracks={tracks} disabled={false} />),
      blocked: renderToStaticMarkup(<ClipDialogueDuckingControls {...common} clip={music} clips={[music, line]} tracks={tracks} disabled={false} blockedReason="先保存位置" />),
      disabled: renderToStaticMarkup(<ClipDialogueDuckingControls {...common} clip={music} clips={[music, line]} tracks={tracks} disabled />),
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
  const tag = (html: string, testId: string): string => html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';
  const selected = (html: string, testId: string): string => html.match(new RegExp(`data-testid="${testId}"[^>]*><span data-slot="select-value"[^>]*>([^<]*)<`))?.[1] ?? '';
  assert.match(markup.ready, /按对白自动压低/);
  assert.equal(selected(markup.ready, 'dialogue-ducking-track'), 'Voice', 'the human-voice track is preselected');
  for (const field of ['thresholdDb', 'paddingFrames', 'multiplier', 'attackFrames', 'releaseFrames']) assert.match(markup.ready, new RegExp(`data-testid="dialogue-ducking-${field}"`));
  assert.equal(selected(markup.ready, 'dialogue-ducking-thresholdDb'), '-35 dBFS');
  assert.equal(selected(markup.ready, 'dialogue-ducking-multiplier'), '0.3');
  assert.ok(tag(markup.ready, 'dialogue-ducking-analyze'));
  assert.doesNotMatch(tag(markup.ready, 'dialogue-ducking-analyze'), /\sdisabled=""/, 'class names mention disabled: variants, so match the attribute');
  assert.match(markup.alone, /data-testid="dialogue-ducking-no-track"/);
  assert.doesNotMatch(markup.alone, /dialogue-ducking-analyze/);
  assert.match(markup.blocked, /data-testid="dialogue-ducking-blocked"[^>]*>先保存位置/);
  assert.match(tag(markup.blocked, 'dialogue-ducking-analyze'), /disabled=""/);
  assert.match(markup.disabled, /<fieldset disabled=""/);
});

test('every dialogue ducking message exists in four locales and the inspector binds analysis to the saved position', () => {
  const keys = Object.keys(volumeEnvelopeMessages).filter(key => key.startsWith('ducking.auto.'));
  assert.ok(keys.length >= 20);
  for (const key of keys) for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const)
    assert.ok(translate(locale, key as never, { count: 2, value: -35, frames: 6, speech: 3, regions: 2 } as never).length > 0, `${locale} ${key}`);
  const inspector = readFileSync(resolve(root, 'apps/web/src/TimelineInspector.tsx'), 'utf8');
  assert.match(inspector, /const positionDirty = \(\['trackId', 'startFrame', 'durationFrames', 'sourceInFrame'\] as const\)/);
  assert.match(inspector, /envelopeEditable && <ClipDialogueDuckingControls /);
  assert.match(inspector, /onApply=\{value => editEnvelope\(pass\(value\)\)\}/, 'applying edits only the draft');
});

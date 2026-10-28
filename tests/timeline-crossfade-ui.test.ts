import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timelineCrossfadeCandidates, CROSSFADE_CANDIDATE_LIMIT } from '../apps/web/src/timeline-crossfade-state.ts';
import type { CrossfadeTimelineClip, CrossfadeAsset } from '../apps/web/src/timeline-crossfade-state.ts';
import { touchesLockedTrack } from '../apps/web/src/timeline-track-locks.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets: CrossfadeAsset[] = [
  { id: 'music', mimeType: 'audio/wav', hasAudio: true, name: 'Music.wav' },
  { id: 'voice', mimeType: 'audio/wav', hasAudio: true, name: 'Voice.wav' },
  { id: 'film', mimeType: 'video/mp4', hasAudio: true, name: 'Film.mp4' },
  { id: 'silent', mimeType: 'video/mp4', hasAudio: false, name: 'Silent.mp4' },
  { id: 'still', mimeType: 'image/png', name: 'Still.png' },
];
const clip = (id: string, trackId: string, startFrame: number, durationFrames: number, assetId = 'music', extra: Partial<CrossfadeTimelineClip> = {}): CrossfadeTimelineClip =>
  ({ id, trackId, startFrame, durationFrames, assetId, name: id, ...extra });

test('candidates list each overlapping sounding clip on another track with the selected clip’s role', () => {
  const clips = [clip('a', 'a1', 0, 90), clip('b', 'a2', 60, 90, 'voice'), clip('c', 'v1', 120, 60, 'film'), clip('next', 'a1', 90, 30)];
  assert.deepEqual(timelineCrossfadeCandidates(clips, assets, 'b'), [
    { outgoingClipId: 'a', incomingClipId: 'b', partnerClipId: 'a', partnerName: 'a', role: 'incoming', startFrame: 60, durationFrames: 30, blocked: null },
    { outgoingClipId: 'b', incomingClipId: 'c', partnerClipId: 'c', partnerName: 'c', role: 'outgoing', startFrame: 120, durationFrames: 30, blocked: null },
  ]);
  assert.deepEqual(timelineCrossfadeCandidates(clips, assets, 'next'), [], 'an adjacent clip on the same track is not a pair');
});

test('silent, still and contained clips are left out; existing curves and locks block a listed pair', () => {
  const base = [clip('a', 'a1', 0, 90), clip('silent', 'v1', 60, 60, 'silent'), clip('still', 'v2', 60, 60, 'still'), clip('inside', 'a2', 10, 40)];
  assert.deepEqual(timelineCrossfadeCandidates(base, assets, 'a'), []);
  assert.deepEqual(timelineCrossfadeCandidates([clip('quiet', 'v1', 0, 60, 'silent'), clip('b', 'a2', 30, 60)], assets, 'quiet'), [], 'a silent selection has no pairs');
  const curved = [clip('a', 'a1', 0, 90, 'music', { volumeEnvelope: { profileId: 'mioon-clip-linear-attenuation-v1', points: [{ frame: 0, multiplier: 1 }] } }), clip('b', 'a2', 60, 90)];
  assert.equal(timelineCrossfadeCandidates(curved, assets, 'b')[0].blocked, 'envelope');
  assert.deepEqual(timelineCrossfadeCandidates([clip('a', 'a1', 0, 90), clip('b', 'a2', 0, 90)], assets, 'a').map(row => [row.role, row.startFrame, row.durationFrames]),
    [['outgoing', 0, 90], ['incoming', 0, 90]], 'clips spanning the same range pair both ways');
  assert.equal(timelineCrossfadeCandidates([clip('a', 'a1', 0, 90), clip('b', 'a2', 60, 90)], assets, 'a', new Set(['a2']))[0].blocked, 'locked');
  const many = [clip('a', 'a0', 0, 400), ...Array.from({ length: 12 }, (_, index) => clip(`p${index}`, `t${index}`, 10 + index * 20, 500))];
  const listed = timelineCrossfadeCandidates(many, assets, 'a');
  assert.equal(listed.length, CROSSFADE_CANDIDATE_LIMIT);
  assert.deepEqual(listed.map(row => row.startFrame), [10, 30, 50, 70, 90, 110, 130, 150], 'in timeline order');
});

test('a crossfade respects locks on either clip’s track', () => {
  const timeline = { clips: [{ id: 'a', trackId: 'a1' }, { id: 'b', trackId: 'a2' }], tracks: [] };
  assert.equal(touchesLockedTrack('timeline.clip.crossfade', { outgoingClipId: 'a', incomingClipId: 'b' }, timeline, new Set(['a2'])), true);
  assert.equal(touchesLockedTrack('timeline.clip.crossfade', { outgoingClipId: 'a', incomingClipId: 'b' }, timeline, new Set(['v1'])), false);
});

test('the controls render pairs, reasons and the disabled state', () => {
  const fixture = `
    import * as React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server.browser';
    import ClipCrossfadeControls from './ClipCrossfadeControls.tsx';
    const pair = { outgoingClipId: 'a', incomingClipId: 'b', partnerClipId: 'b', partnerName: 'Voice', role: 'outgoing', startFrame: 60, durationFrames: 30, blocked: null };
    export const markup = {
      empty: renderToStaticMarkup(<ClipCrossfadeControls candidates={[]} disabled={false} />),
      ready: renderToStaticMarkup(<ClipCrossfadeControls candidates={[pair, { ...pair, partnerName: 'Film', role: 'incoming', blocked: 'envelope' }]} disabled={false} onCrossfade={() => {}} />),
      dirty: renderToStaticMarkup(<ClipCrossfadeControls candidates={[pair]} disabled disabledReason="请先保存" onCrossfade={() => {}} />),
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
  assert.match(markup.empty, /data-testid="crossfade-empty"/);
  assert.doesNotMatch(markup.empty, /crossfade-apply/);
  assert.match(markup.ready, /淡出到「Voice」/);
  assert.match(markup.ready, /从「Film」淡入/);
  assert.match(markup.ready, /从第 60 帧起，共 30 帧/);
  assert.match(markup.ready, /有一段已有音量关键帧，请先清除/);
  assert.equal((markup.ready.match(/data-testid="crossfade-apply"/g) || []).length, 2);
  const applies = (html: string): string[] => html.match(/<button[^>]*data-testid="crossfade-apply"[^>]*>/g) ?? [];
  assert.deepEqual(applies(markup.ready).map(tag => /\sdisabled=""/.test(tag)), [false, true], 'only the blocked pair is disabled');
  assert.match(markup.dirty, /data-testid="crossfade-disabled"[^>]*>请先保存/);
  assert.ok(applies(markup.dirty).every(tag => /\sdisabled=""/.test(tag)));
});

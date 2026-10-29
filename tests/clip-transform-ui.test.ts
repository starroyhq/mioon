import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyframeAt, transformFields, transformFrame, transformIssue, withKeyframe, withoutKeyframe } from '../apps/web/src/clip-transform-state.ts';
import { touchesLockedTrack } from '../apps/web/src/timeline-track-locks.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profileId = 'mioon-clip-transform-v1', crop = { left: 0, top: 0, right: 0, bottom: 0 };
const zoom = { profileId, keyframes: [{ frame: 10, x: -100, y: 20, scale: 0.5 }, { frame: 50, x: 100, y: -20, scale: 1.5 }], rotation: 0, crop };
const clip = (transform?: unknown) => ({ durationFrames: 60, ...(transform === undefined ? {} : { transform }) });

test('fields show a keyframe or the interpolated value at the playhead frame', () => {
  assert.equal(transformFrame({ startFrame: 100, durationFrames: 60 }, 130), 30);
  assert.deepEqual([transformFrame({ startFrame: 100, durationFrames: 60 }, 40), transformFrame({ startFrame: 100, durationFrames: 60 }, 900)], [0, 60], 'clamped into the clip');
  assert.deepEqual(transformFields(clip(), 30), { x: '0', y: '0', scale: '100' });
  assert.deepEqual(transformFields(clip(zoom), 30), { x: '0', y: '0', scale: '100' });
  assert.deepEqual(transformFields(clip(zoom), 10), { x: '-100', y: '20', scale: '50' });
  assert.deepEqual([keyframeAt(clip(zoom), 50)?.x, keyframeAt(clip(zoom), 30)], [100, null]);
  assert.deepEqual(transformFields(clip({ ...zoom, profileId: 'other' }), 10), { x: '0', y: '0', scale: '100' }, 'an unreadable transform shows the identity');
});

test('keyframe actions build the complete next transform', () => {
  assert.deepEqual(withKeyframe(clip(), 12, { x: '8', y: '-4', scale: '125' }), { profileId, keyframes: [{ frame: 12, x: 8, y: -4, scale: 1.25 }], rotation: 0, crop });
  assert.deepEqual(withKeyframe(clip(zoom), 30, { x: '1', y: '2', scale: '90' })!.keyframes.map(point => point.frame), [10, 30, 50]);
  assert.deepEqual(withKeyframe(clip(zoom), 50, { x: '0', y: '0', scale: '100' })!.keyframes[1], { frame: 50, x: 0, y: 0, scale: 1 }, 'replaces the keyframe at that frame');
  assert.equal(Object.is(withKeyframe(clip(), 0, { x: '-0', y: '0', scale: '100' })!.keyframes[0]!.x, -0), false, 'negative zero is never saved');
  assert.deepEqual(withoutKeyframe(clip(zoom), 10)!.keyframes, [zoom.keyframes[1]]);
  assert.equal(withoutKeyframe(clip({ ...zoom, keyframes: [zoom.keyframes[0]] }), 10), null, 'the last keyframe ends the transform');
  assert.deepEqual(withoutKeyframe(clip({ ...zoom, keyframes: [zoom.keyframes[0]], rotation: 15 }), 10), { ...zoom, keyframes: [{ frame: 0, x: 0, y: 0, scale: 1 }], rotation: 15 }, 'rotation and crop stay');
  for (const fields of [{ x: '', y: '0', scale: '100' }, { x: '9000', y: '0', scale: '100' }, { x: '0', y: '0', scale: '4' }, { x: '0', y: '0', scale: '801' }, { x: 'a', y: '0', scale: '100' }])
    assert.equal(transformIssue(clip(), 0, fields), 'clip.transform.invalid', JSON.stringify(fields));
  const full = { ...zoom, keyframes: Array.from({ length: 16 }, (_, frame) => ({ frame, x: 0, y: 0, scale: 1 })) };
  assert.equal(transformIssue(clip(full), 30, { x: '0', y: '0', scale: '100' }), 'clip.transform.full');
  assert.equal(transformIssue(clip(full), 3, { x: '0', y: '0', scale: '100' }), '', 'an existing keyframe can still change');
  assert.equal(withKeyframe(clip(full), 30, { x: '0', y: '0', scale: '100' }), null);
});

test('a transform edit respects the clip track lock', () => {
  const timeline = { clips: [{ id: 'a', trackId: 'v1' }], tracks: [] };
  assert.equal(touchesLockedTrack('timeline.clip.setTransform', { clipId: 'a' }, timeline, new Set(['v1'])), true);
  assert.equal(touchesLockedTrack('timeline.clip.setTransform', { clipId: 'a' }, timeline, new Set(['v2'])), false);
});

test('the controls render the frame, keyframes, static parts and the disabled state', () => {
  const fixture = `
    import * as React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server.browser';
    import ClipTransformControls from './ClipTransformControls.tsx';
    const zoom = ${JSON.stringify(zoom)};
    const clip = transform => ({ durationFrames: 60, ...(transform ? { transform } : {}) });
    export const markup = {
      none: renderToStaticMarkup(<ClipTransformControls clip={clip()} frame={12} disabled={false} onSetTransform={() => {}} />),
      keyed: renderToStaticMarkup(<ClipTransformControls clip={clip(zoom)} frame={10} disabled={false} onSetTransform={() => {}} />),
      between: renderToStaticMarkup(<ClipTransformControls clip={clip({ ...zoom, rotation: 15, crop: { left: 0.1, top: 0, right: 0, bottom: 0 } })} frame={30} disabled={false} onSetTransform={() => {}} />),
      dirty: renderToStaticMarkup(<ClipTransformControls clip={clip(zoom)} frame={10} disabled disabledReason="请先保存" onSetTransform={() => {}} />),
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
  const button = (html: string, id: string): string => html.match(new RegExp(`<button[^>]*data-testid="clip-transform-${id}"[^>]*>`))?.[0] ?? '';
  const disabled = (html: string, id: string): boolean => /\sdisabled=""/.test(button(html, id));
  assert.match(markup.none, /片段第 12 帧 · 未设置变换/);
  assert.doesNotMatch(markup.none, /clip-transform-keyframes/);
  assert.deepEqual(['set', 'remove', 'clear'].map(id => disabled(markup.none, id)), [false, true, true]);
  assert.match(markup.keyed, /片段第 10 帧 · 此帧是关键帧/);
  assert.match(markup.keyed, /<li aria-current="true">第 10 帧 · X -100 · Y 20 · 50%<\/li>/);
  assert.match(markup.keyed, /第 50 帧 · X 100 · Y -20 · 150%/);
  assert.deepEqual(['set', 'remove', 'clear'].map(id => disabled(markup.keyed, id)), [false, false, false]);
  assert.match(markup.between, /片段第 30 帧 · 由关键帧推算的值/);
  assert.match(markup.between, /data-testid="clip-transform-static"[^>]*>另有旋转 15° 和裁切（左 10%、上 0%、右 0%、下 0%），会保留/);
  assert.equal(disabled(markup.between, 'remove'), true, 'no keyframe at this frame to remove');
  assert.match(markup.dirty, /data-testid="clip-transform-disabled"[^>]*>请先保存/);
  assert.ok(['set', 'remove', 'clear'].every(id => disabled(markup.dirty, id)));
});

test('the inspector offers transforms on visual clips of editable workspaces only', () => {
  const inspector = readFileSync(resolve(root, 'apps/web/src/TimelineInspector.tsx'), 'utf8'), app = readFileSync(resolve(root, 'apps/web/src/App.tsx'), 'utf8');
  assert.match(inspector, /\{kind !== 'audio' && onSetTransform && <ClipTransformControls /);
  assert.match(app, /onSetTransform=\{application \|\| clipInspectorRetained \|\| displayedClipInspector\.restored \? undefined : setTimelineClipTransform\}/);
  assert.match(app, /mutateTimeline\('timeline\.clip\.setTransform', \{ clipId, transform \}/);
});

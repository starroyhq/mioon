import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boxFields, boxFrame, boxValues, containedPicture, movedBoxValues, sameBoxValues, scaledBoxValues, transformBoxView } from '../apps/web/src/clip-transform-box-state.ts';
import { transformIssue } from '../apps/web/src/clip-transform-state.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profileId = 'mioon-clip-transform-v1', crop = { left: 0, top: 0, right: 0, bottom: 0 };
const timeline = { width: 1280, height: 720 }, source = { width: 640, height: 360 };
const clip = (transform?: unknown) => ({ startFrame: 100, durationFrames: 60, rect: { x: 0, y: 0, width: 1280, height: 720 }, ...(transform === undefined ? {} : { transform }) });
const placed = { profileId, keyframes: [{ frame: 0, x: -240, y: 120, scale: 0.5 }], rotation: 0, crop };
// A 700x500 content box shows the 1280x720 frame at 0.546875, letterboxed.
const picture = containedPicture({ left: 20, top: 10, width: 700, height: 500 }, timeline)!;
const near = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} ${actual} != ${expected}`);

test('the picture is the contained frame and the box is the model geometry scaled onto it', () => {
  assert.deepEqual(picture, { left: 20, top: 63.125, width: 700, height: 393.75 });
  assert.deepEqual(containedPicture({ left: 0, top: 0, width: 400, height: 400 }, { width: 200, height: 400 }), { left: 100, top: 0, width: 200, height: 400 });
  assert.equal(containedPicture({ left: 0, top: 0, width: 0, height: 400 }, timeline), null);
  assert.deepEqual([boxFrame(clip(), 99), boxFrame(clip(), 100), boxFrame(clip(), 130.4), boxFrame(clip(), 159), boxFrame(clip(), 160)], [null, 0, 30, 59, null]);
  assert.deepEqual(transformBoxView(clip(), source, timeline, picture, 0), { center: { x: 370, y: 260 }, width: 700, height: 393.75, rotation: 0, factor: 0.546875 });
  const view = transformBoxView(clip(placed), source, timeline, picture, 0)!;
  assert.deepEqual(view, { center: { x: 238.75, y: 325.625 }, width: 350, height: 196.875, rotation: 0, factor: 0.546875 });
  assert.equal(transformBoxView(clip({ ...placed, rotation: 30 }), source, timeline, picture, 0)!.rotation, 30);
  assert.equal(transformBoxView(clip(placed), { width: 0, height: 360 }, timeline, picture, 0), null, 'no source size, no box');
  assert.equal(transformBoxView(clip(placed), source, timeline, containedPicture({ left: 0, top: 0, width: 800, height: 600 }, { width: 800, height: 600 })!, 0), null, 'a render of another shape');
});

test('drags follow the pointer: moves in timeline pixels, corners in whole percent about the centre', () => {
  const start = boxValues(clip(placed), 0), view = transformBoxView(clip(placed), source, timeline, picture, 0)!;
  assert.deepEqual(start, { x: -240, y: 120, scale: 0.5 });
  const moved = movedBoxValues(start, { x: 54.6875, y: -27.34375 }, view.factor);
  assert.deepEqual(moved, { x: -140, y: 70, scale: 0.5 });
  const after = transformBoxView(clip(placed), source, timeline, picture, 0, moved)!;
  near(after.center.x - view.center.x, 54.6875); near(after.center.y - view.center.y, -27.34375);
  assert.deepEqual(movedBoxValues(start, { x: 1e7, y: -1e7 }, view.factor), { x: 8192, y: -8192, scale: 0.5 });
  assert.ok(Object.is(movedBoxValues({ x: 0.2, y: 0, scale: 1 }, { x: -0.6, y: 0 }, 1).x, 0), 'no negative zero');
  const corner = { x: view.center.x + view.width / 2, y: view.center.y + view.height / 2 };
  const doubled = scaledBoxValues(start, view.center, corner, { x: view.center.x + view.width, y: view.center.y + view.height });
  assert.deepEqual(doubled, { x: -240, y: 120, scale: 1 });
  const grown = transformBoxView(clip(placed), source, timeline, picture, 0, doubled)!;
  assert.deepEqual([grown.center, grown.width], [view.center, view.width * 2], 'the corner lands under the pointer and the centre stays');
  assert.equal(scaledBoxValues(start, view.center, corner, { x: view.center.x + 1e5, y: view.center.y + 1e5 }).scale, 8);
  assert.equal(scaledBoxValues(start, view.center, corner, view.center).scale, 0.05);
  assert.deepEqual(scaledBoxValues(start, view.center, { x: view.center.x + 1, y: view.center.y }, corner), start, 'a start on the centre cannot scale');
  assert.deepEqual(boxFields({ x: -140, y: 70, scale: 0.335 }), { x: '-140', y: '70', scale: '33.5' });
  assert.equal(sameBoxValues(start, { ...start }), true);
});

test('an unsaved drag previews the keyframe it would set, between keyframes too', () => {
  const zoom = { profileId, keyframes: [{ frame: 10, x: -100, y: 0, scale: 0.5 }, { frame: 50, x: 100, y: 0, scale: 1.5 }], rotation: 0, crop };
  const between = transformBoxView(clip(zoom), source, timeline, picture, 30)!;
  assert.deepEqual([between.center.x, between.width], [370, 700], 'interpolated: offset 0, scale 1');
  const preview = transformBoxView(clip(zoom), source, timeline, picture, 30, { x: 0, y: 0, scale: 2 })!;
  assert.equal(preview.width, 1400);
  const full = { ...zoom, keyframes: Array.from({ length: 16 }, (_, frame) => ({ frame, x: 0, y: 0, scale: 1 })) };
  assert.equal(transformIssue(clip(full), 30, boxFields(boxValues(clip(full), 30))), 'clip.transform.full', 'a full clip only moves existing keyframes');
});

test('the box renders in percent of the layer, with handles only when editable', () => {
  const fixture = `
    import * as React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server.browser';
    import { ClipTransformBoxFrame } from './ClipTransformBox.tsx';
    const layout = { width: 1000, height: 600, picture: { left: 100, top: 50, width: 800, height: 450 } };
    const view = { center: { x: 500, y: 300 }, width: 400, height: 225, rotation: 30, factor: 0.625 };
    export const markup = {
      editable: renderToStaticMarkup(<ClipTransformBoxFrame layout={layout} view={view} editable label="变换框" hint="变换框" readout="X 10 · Y -20 · 50%" />),
      blocked: renderToStaticMarkup(<ClipTransformBoxFrame layout={layout} view={view} editable={false} label="变换框" hint="先保存" />),
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
  assert.match(markup.editable, /data-editable="true" role="group" aria-label="变换框" title="变换框" style="left:50%;top:50%;width:40%;height:37.5%;transform:translate\(-50%, -50%\) rotate\(30deg\)"/);
  assert.deepEqual([...markup.editable.matchAll(/data-testid="clip-transform-handle-(\w+)"/g)].map(match => match[1]), ['nw', 'ne', 'se', 'sw']);
  assert.match(markup.editable, /<output class="clip-transform-box-readout" data-testid="clip-transform-box-readout">X 10 · Y -20 · 50%<\/output>/);
  assert.match(markup.blocked, /data-editable="false" role="group" aria-label="变换框" title="先保存"/);
  assert.doesNotMatch(markup.blocked, /clip-transform-handle|clip-transform-box-readout/);
});

test('the rendered timeline preview carries the box for visual clips the inspector can edit', () => {
  const preview = readFileSync(resolve(root, 'apps/web/src/Preview.tsx'), 'utf8'), app = readFileSync(resolve(root, 'apps/web/src/App.tsx'), 'utf8');
  assert.match(preview, /\{rendered && type === 'video' && transformBox && timeline && <ClipTransformBox box=\{transformBox\} playhead=\{playhead\} timeline=\{timeline\} media=\{media\} mediaKey=\{mediaKey\} \/>\}/);
  assert.match(app, / transformBox=\{clipTransformBox\(\)\} \/>/);
  assert.match(app, /if \(!view \|\| clipInspectorRetained \|\| view\.restored\) return null;/);
  assert.match(app, /track\.id === clip\.trackId && track\.kind === 'video'/);
  assert.match(app, /busy: timelineBusy, onSetTransform: setTimelineClipTransform,/);
  assert.match(app, /disabledReason: clipDirty \|\| clipCompositionPending \? msg\('clip\.transform\.saveFirst'\) : lockedTrackIds\.has\(clip\.trackId\) \? msg\('edit\.track\.lockedHint'\) : null/);
});

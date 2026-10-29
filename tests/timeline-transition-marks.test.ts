import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectedTransitionCuts, timelineTransitionMarks, timelineTransitionSources } from '../apps/web/src/timeline-transition-marks.ts';
import { defaultTransition, transitionFields } from '../apps/web/src/clip-transition-state.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profileId = 'mioon-clip-transition-v1';
const dissolve = { profileId, kind: 'dissolve', durationFrames: 20 } as const;
const assets = [{ id: 'video', mimeType: 'video/mp4', duration: 10 }, { id: 'still', mimeType: 'image/png', duration: null }];
const clip = (id: string, trackId: string, startFrame: number, sourceInFrame = 30, extra: Record<string, unknown> = {}) =>
  ({ id, trackId, assetId: 'video', startFrame, durationFrames: 60, sourceInFrame, ...extra });
// A [0,60), B [60,120) with a 20-frame dissolve, C [120,180) on track v; a lone clip with a transition on track w.
const clips = [clip('A', 'v', 0, 0), clip('B', 'v', 60, 30, { transitionIn: dissolve }), clip('C', 'v', 120), clip('D', 'w', 60, 30, { transitionIn: dissolve })];

test('marks span saved transitions on their track, and quick add offers the selected clip\'s open cuts', () => {
  const sources = timelineTransitionSources(assets);
  assert.deepEqual([sources('video'), sources('still'), sources('missing')], [{ image: false, frames: 300 }, { image: true, frames: 0 }, null]);
  assert.deepEqual(timelineTransitionMarks(clips, 'v'), [{ incomingId: 'B', kind: 'dissolve', durationFrames: 20, startFrame: 50, endFrame: 70 }]);
  assert.deepEqual(timelineTransitionMarks(clips, 'w'), [], 'a transition without a cut is no mark');
  // B's start already has a transition; its end leads into C, which takes 60 frames beside it.
  assert.deepEqual(selectedTransitionCuts(clips, 'B', 'v', sources), [{ incomingId: 'C', cutFrame: 120, maxFrames: 60 }]);
  assert.deepEqual(selectedTransitionCuts(clips, 'C', 'v', sources), [{ incomingId: 'C', cutFrame: 120, maxFrames: 60 }]);
  assert.deepEqual(selectedTransitionCuts(clips, 'A', 'v', sources), [], 'no clip before A, and B already has one');
  assert.deepEqual(selectedTransitionCuts(clips, 'B', 'w', sources), [], 'only the selected clip\'s track');
  assert.deepEqual(selectedTransitionCuts([...clips, clip('E', 'v', 200)], 'E', 'v', sources), [], 'a gap is no cut');
  const noLeadIn = clips.map(item => item.id === 'C' ? { ...item, sourceInFrame: 0 } : item);
  assert.deepEqual(selectedTransitionCuts(noLeadIn, 'C', 'v', sources), [{ incomingId: 'C', cutFrame: 120, maxFrames: 0 }], 'a cut without room is still offered, to say why');
  assert.deepEqual([60, 8, 0].map(frames => defaultTransition(frames).durationFrames), [15, 8, 2]);
  assert.deepEqual(defaultTransition(60), { profileId, kind: 'dissolve', durationFrames: 15 });
  assert.deepEqual(transitionFields({}, { hasCut: true, maxFrames: 8 }), { kind: 'dissolve', frames: '8' }, 'the inspector starts from the same default');
});

test('the marks render their spans and the quick-add buttons say why they wait', () => {
  const fixture = `
    import * as React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server.browser';
    import TimelineTransitionMarks from './TimelineTransitionMarks.tsx';
    const clips = ${JSON.stringify(clips)}, assets = ${JSON.stringify(assets)};
    const short = clips.map(item => item.id === 'B' ? { ...item, transitionIn: { ...item.transitionIn, durationFrames: 2 } } : item);
    const noLeadIn = clips.map(item => item.id === 'C' ? { ...item, sourceInFrame: 0 } : item);
    const render = (extra = {}) => renderToStaticMarkup(<TimelineTransitionMarks clips={clips} trackId="v" assets={assets} selectedClipId="C" pixelsPerFrame={2} disabled={false} onSelect={() => {}} onAdd={() => {}} {...extra} />);
    export const markup = {
      open: render(), view: render({ onAdd: undefined }), short: render({ clips: short, onAdd: undefined }),
      blocked: render({ disabledReason: '请先保存' }), noRoom: render({ clips: noLeadIn }), busy: render({ disabled: true }),
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
  const tag = (html: string, id: string): string => html.match(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? '';
  const mark = tag(markup.view!, 'timeline-transition-B');
  assert.match(mark, /aria-label="转场：交叉溶解，20 帧"/);
  assert.match(mark, /data-kind="dissolve"/);
  assert.match(mark, /style="left:100px;width:40px"/, 'frames 50 to 70 at 2 px a frame');
  assert.match(tag(markup.short!, 'timeline-transition-B'), /style="left:117px;width:6px"/, 'a short transition keeps a 6px bar centred on its span');
  assert.equal(tag(markup.view!, 'timeline-transition-add-C'), '', 'without onAdd there is no quick add');
  const add = tag(markup.open!, 'timeline-transition-add-C');
  assert.match(add, /aria-label="在这里加 15 帧溶解"/);
  assert.match(add, /title="在这里加 15 帧溶解"/);
  assert.doesNotMatch(add, /aria-disabled="true"/);
  assert.match(add, /style="left:240px"/);
  for (const [name, reason] of [['blocked', '请先保存'], ['noRoom', '两段的素材余量或片段长度不够，放不下转场']] as const) {
    const waiting = tag(markup[name]!, 'timeline-transition-add-C');
    assert.match(waiting, new RegExp(`title="${reason}"`), name);
    assert.match(waiting, new RegExp(`aria-description="${reason}"`), name);
    assert.match(waiting, /aria-disabled="true"/, `${name} stays focusable so the reason is reachable`);
    assert.doesNotMatch(waiting, /\sdisabled=""/, name);
  }
  assert.match(tag(markup.busy!, 'timeline-transition-add-C'), /aria-disabled="true"[^>]*title="在这里加 15 帧溶解"|title="在这里加 15 帧溶解"[^>]*aria-disabled="true"/);
});

test('App adds from the timeline only where the inspector could, and selects the incoming clip after', () => {
  const app = readFileSync(resolve(root, 'apps/web/src/App.tsx'), 'utf8');
  assert.match(app, /onAddTransition=\{application \|\| restored \? undefined : addTimelineTransition\}/);
  assert.match(app, /transitionAddBlocked=\{clipDirty \|\| clipCompositionPending \? msg\('clip\.transition\.saveFirst'\) : null\}/);
  assert.match(app, /if \(await setTimelineClipTransition\(clipId, transition\) && viewRef\.current!\.editing\.selectedClipId !== clipId\) await selectClip\(clipId, false\);/);
});

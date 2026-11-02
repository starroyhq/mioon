import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextTransition, transitionChanged, transitionFields, transitionIssue } from '../apps/web/src/clip-transition-state.ts';
import { touchesLockedTrack } from '../apps/web/src/timeline-track-locks.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profileId = 'mioon-clip-transition-v1';
const push = { profileId, kind: 'pushLeft', durationFrames: 24 };
const open = { hasCut: true, maxFrames: 40 };

test('fields start from the saved transition or a dissolve that fits, and only valid changes apply', () => {
  assert.deepEqual(transitionFields({}, open), { kind: 'dissolve', frames: '15' });
  assert.deepEqual(transitionFields({}, { hasCut: true, maxFrames: 8 }), { kind: 'dissolve', frames: '8' }, 'a short cut gets what fits');
  assert.deepEqual(transitionFields({ transitionIn: push }, open), { kind: 'pushLeft', frames: '24' });
  assert.deepEqual(transitionFields({ transitionIn: { ...push, kind: 'fade' } }, open), { kind: 'dissolve', frames: '15' }, 'an unreadable transition is ignored');
  assert.equal(transitionIssue({ kind: 'dissolve', frames: '15' }, { hasCut: false, maxFrames: 0 }), 'clip.transition.noCut');
  assert.equal(transitionIssue({ kind: 'dissolve', frames: '15' }, { hasCut: true, maxFrames: 1 }), 'clip.transition.noRoom');
  for (const frames of ['', '1', '41', '10.5', 'x']) assert.equal(transitionIssue({ kind: 'dissolve', frames }, open), 'clip.transition.invalid', frames);
  assert.equal(transitionIssue({ kind: 'dissolve', frames: '40' }, open), '');
  assert.deepEqual(nextTransition({ kind: 'wipeRight', frames: '12' }), { profileId, kind: 'wipeRight', durationFrames: 12 });
  assert.equal(transitionChanged({ transitionIn: push }, { kind: 'pushLeft', frames: '24' }), false);
  assert.equal(transitionChanged({ transitionIn: push }, { kind: 'pushRight', frames: '24' }), true);
  assert.equal(transitionChanged({}, { kind: 'dissolve', frames: '15' }), true);
});

test('a transition edit respects the clip track lock', () => {
  const timeline = { clips: [{ id: 'b', trackId: 'v1' }], tracks: [] };
  assert.equal(touchesLockedTrack('timeline.clip.setTransition', { clipId: 'b' }, timeline, new Set(['v1'])), true);
  assert.equal(touchesLockedTrack('timeline.clip.setTransition', { clipId: 'b' }, timeline, new Set(['v2'])), false);
});

test('the controls render the cut, the room, the saved transition and the disabled states', () => {
  const fixture = `
    import * as React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server.browser';
    import ClipTransitionControls from './ClipTransitionControls.tsx';
    const push = ${JSON.stringify(push)};
    const render = (clip, context, extra = {}) => renderToStaticMarkup(<ClipTransitionControls clip={clip} context={context} disabled={false} onSetTransition={() => {}} {...extra} />);
    export const markup = {
      noCut: render({}, { hasCut: false, maxFrames: 0 }),
      noRoom: render({}, { hasCut: true, maxFrames: 1 }),
      fresh: render({}, { hasCut: true, maxFrames: 40 }),
      saved: render({ transitionIn: push }, { hasCut: true, maxFrames: 40 }),
      dirty: render({ transitionIn: push }, { hasCut: true, maxFrames: 40 }, { disabled: true, disabledReason: '请先保存' }),
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
  const button = (html: string, id: string): string => html.match(new RegExp(`<button[^>]*data-testid="clip-transition-${id}"[^>]*>`))?.[0] ?? '';
  const disabled = (html: string, id: string): boolean => /\sdisabled=""/.test(button(html, id));
  assert.match(markup.noCut, /data-testid="clip-transition-issue"[^>]*>同一轨道上没有在这一段开始处结束的片段/);
  assert.deepEqual(['apply', 'remove'].map(id => disabled(markup.noCut, id)), [true, true]);
  assert.match(markup.noRoom, /两段的素材余量或片段长度不够/);
  assert.match(markup.fresh, /data-testid="clip-transition-status"[^>]*>这个切点最多放 40 帧/);
  assert.match(markup.fresh, /data-testid="clip-transition-frames"[^>]*value="15"/);
  assert.deepEqual(['apply', 'remove'].map(id => disabled(markup.fresh, id)), [false, true]);
  assert.match(markup.saved, /当前：向左推移，24 帧 · 这个切点最多放 40 帧/);
  assert.deepEqual(['apply', 'remove'].map(id => disabled(markup.saved, id)), [true, false], 'nothing to apply until a field changes');
  assert.match(markup.dirty, /data-testid="clip-transition-disabled"[^>]*>请先保存/);
  assert.ok(['apply', 'remove'].every(id => disabled(markup.dirty, id)));
});

test('the inspector offers transitions on visual clips and App keeps the user told', () => {
  const inspector = readFileSync(resolve(root, 'apps/web/src/TimelineInspector.tsx'), 'utf8'), app = readFileSync(resolve(root, 'apps/web/src/App.tsx'), 'utf8');
  assert.match(inspector, /\{kind !== 'audio' && <InspectorGroup groupKey="visual"(?:(?!<\/InspectorGroup>)[^])*?\{onSetTransition && <ClipTransitionControls /);
  assert.match(app, /onSetTransition=\{clipInspectorRetained \|\| displayedClipInspector\.restored \? undefined : setTimelineClipTransition\}/);
  assert.match(app, /mutateTimeline\('timeline\.clip\.setTransition', \{ clipId, transition \}/);
  assert.match(app, /maxFrames: clipTransitionRoom\(timeline\.clips, clip, sources\)/);
  // Another edit that drops a transition says so; undo, redo and the transition edit itself do not.
  assert.match(app, /if \(!transitions\.length \|\| \['timeline\.clip\.setTransition', 'timeline\.undo', 'timeline\.redo'\]\.includes\(operation\)\) return run\('timeline:mutation', operation, request/);
  assert.match(app, /if \(lost\) notify\(msg\('clip\.transition\.removed', \{ count: lost \}\), 'warning'\);/);
});

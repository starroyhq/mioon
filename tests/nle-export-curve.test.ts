import assert from 'node:assert/strict';
import test from 'node:test';
import {compileEditorExportSpeed, type EditorExportSpeed} from '../packages/business/src/editor-export-speed.ts';
import type {Format5Clip, Format5Timeline} from '../packages/contracts/src/project-format5.ts';
import {compileTimeMap, initialTimeMap, projectTimeMapToCurrentClipFields, timeMapCurveReference, timeMapPlanFrames,
  timeMapPlanInfo, timeMapTailInverse, trimTimeMap, type TimeMapResult} from '../packages/contracts/src/timeline-time-map.ts';

const fps = 30;
const timebase = {fpsNumerator: fps, fpsDenominator: 1};
const id = (n: number): string => `04000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const boundary = (value: number) => ({kind: 'rational' as const, numerator: String(value), denominator: '1'});

function value<T>(result: TimeMapResult<T>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

function curveFixture(direction: 'forward' | 'reverse', trimmed = false) {
  const rates = direction === 'forward' ? [[8, 1, 2], [16, 3, 4], [32, 3, 2]] : [[22, 3, 1], [34, 1, 1], [58, 1, 2]];
  const basis = {
    profile: 'timeline-speed-v1' as const, sourceFps: timebase, outputFps: timebase,
    sourceRange: {start: boundary(rates[0]![0]!), end: boundary(rates.at(-1)![0]!)},
    speed: {kind: 'curve' as const, presetId: 'asymmetric', interpolation: 'log-pchip-v1' as const,
      points: rates.map(([sourceFrame, numerator, denominator]) => ({sourceFrame: sourceFrame!,
        rate: {numerator: numerator!, denominator: denominator!}}))},
  };
  const full = initialTimeMap(value(compileTimeMap(basis)), direction);
  const plan = trimmed ? value(trimTimeMap(full, 4, full.durationFrames - 4)) : full;
  const {loTime, hiTime, outputWindow} = value(timeMapPlanInfo(plan));
  const draft: Format5Clip = {id: id(2), name: 'Curve proof', trackId: id(1), assetId: id(3), sourceState: 'ready',
    sourceInFrame: rates[0]![0]!, startFrame: 0, durationFrames: plan.durationFrames, gain: 1,
    rect: {x: 0, y: 0, width: 1080, height: 1920}};
  const clip: Format5Clip = {...draft, ...value(projectTimeMapToCurrentClipFields(draft, plan)),
    timing: {profile: 'timeline-speed-v1', basis, view: {direction, loTime, hiTime}, outputWindow, pitchShift: false, interpolation: 'off'}};
  const stamp = '2026-01-01T00:00:00.000Z';
  const timeline: Format5Timeline = {
    id: id(4), projectId: id(5), fps, revision: 1, width: 1080, height: 1920, durationFrames: clip.durationFrames,
    createdAt: stamp, updatedAt: stamp, mainTrack: {trackId: id(1), sequenceNodeId: id(6)},
    tracks: [{id: id(1), name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false}], clips: [clip],
  };
  return {clip, timeline, plan};
}

function sourceAt(points: EditorExportSpeed['points'], output: number): number {
  const last = points.at(-1)!;
  if (output === last.outputFrame) return last.sourceFrame;
  const rightIndex = points.findIndex(point => point.outputFrame > output);
  assert.ok(rightIndex > 0);
  const left = points[rightIndex - 1]!, right = points[rightIndex]!;
  return left.sourceFrame + (right.sourceFrame - left.sourceFrame) *
    ((output - left.outputFrame) / (right.outputFrame - left.outputFrame));
}

test('curve error measures entire output frame intervals, including both sides of the rounded tail', () => {
  for (const direction of ['forward', 'reverse'] as const) {
    const {clip, timeline, plan} = curveFixture(direction);
    const cutoff = value(timeMapCurveReference(plan)).motionEnd;
    assert.ok(cutoff > clip.durationFrames - 1 && cutoff < clip.durationFrames);
    const samples = Array.from({length: clip.durationFrames * 100 + 1}, (_, tick) => tick * 10_000);
    samples.push(Math.floor(cutoff * 1_000_000) - 1, Math.ceil(cutoff * 1_000_000) + 1);
    const reference = samples.map(tick => {
      const {position} = value(timeMapTailInverse(plan, {
        numerator: String(plan.outputWindow.fromFrame * 1_000_000 + tick), denominator: '1000000',
      }, {tailInverse: direction === 'forward' ? 'latest' : 'earliest'}));
      return position.kind === 'numeric' ? position.value : Number(position.numerator) / Number(position.denominator);
    });
    const selected = value(timeMapPlanFrames(plan));
    for (const units of ['project', 'native'] as const) {
      const graph = compileEditorExportSpeed(clip, timeline, {fps, frameCount: 72}, units);
      assert.ok(graph);
      assert.equal(graph.points.some(point => !Number.isInteger(point.outputFrame)), units === 'project');
      assert.ok(graph.points.every((point, index) => !index || point.outputFrame > graph.points[index - 1]!.outputFrame));
      for (const [frame, expected] of selected.entries()) {
        assert.equal(Math.floor(sourceAt(graph.points, frame)), expected, `${units} ${direction} source frame ${frame}`);
      }
      const observed = samples.reduce((maximum, tick, index) =>
        Math.max(maximum, Math.abs(sourceAt(graph.points, tick / 1_000_000) - reference[index]!)), 0);
      assert.ok(observed <= graph.maxErrorFrames && graph.maxErrorFrames - observed < 0.004,
        `${units} ${direction}: measured ${observed}, reported ${graph.maxErrorFrames}`);
      if (direction === 'reverse') {
        assert.ok(graph.maxErrorFrames >= 1 && graph.maxErrorFrames < (units === 'project' ? 1.01 : 1.11));
      } else {
        assert.ok(graph.maxErrorFrames < (units === 'project' ? 0.05 : 0.25));
      }
    }
  }
});

test('a trimmed curve stops on its own output window before the rounded root tail', () => {
  const {clip, timeline, plan} = curveFixture('reverse', true);
  assert.ok(value(timeMapCurveReference(plan)).motionEnd > clip.durationFrames);
  const graph = compileEditorExportSpeed(clip, timeline, {fps, frameCount: 72});
  assert.ok(graph);
  assert.ok(graph.maxErrorFrames <= 0.05);
  for (const [frame, expected] of value(timeMapPlanFrames(plan)).entries()) {
    assert.equal(Math.floor(sourceAt(graph.points, frame)), expected);
  }
});

test('constant-rate curves on different source and output clocks retain their exact slope', () => {
  const plan = initialTimeMap(value(compileTimeMap({
    profile: 'timeline-speed-v1', sourceFps: {fpsNumerator: 24, fpsDenominator: 1}, outputFps: timebase,
    sourceRange: {start: boundary(8), end: boundary(48)},
    speed: {kind: 'curve', presetId: 'constant-curve', interpolation: 'log-pchip-v1',
      points: [{sourceFrame: 8, rate: {numerator: 2, denominator: 1}}, {sourceFrame: 48, rate: {numerator: 2, denominator: 1}}]},
  })));
  const trimmed = value(trimTimeMap(plan, 2, 17));
  const curve = value(timeMapCurveReference(trimmed));
  assert.equal(curve.motionEnd, 23);
  assert.ok(Math.abs(value(curve.sampleMotion(0.5)).value - 12) < 1e-12);
  assert.ok(value(curve.maxLinearError(0, 15, 11.2, 35.2)) < 1e-12);
});

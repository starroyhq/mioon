type Pixel={r:number;g:number;b:number;alpha:number};
type NumericExpression=(n:number,pixel:Pixel)=>number;
type StrictIntersection<T> = (T extends unknown ? (value: T)=>void : never) extends ((value: infer I)=>void) ? I : never;
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileTimelineOpacityFilterCandidate as compile,
  TIMELINE_OPACITY_FILTER_BYTE_CAP_CANDIDATE as FILTER_CAP,
  TIMELINE_OPACITY_EXPRESSION_BYTE_CAP_CANDIDATE as EXPRESSION_CAP,
  TIMELINE_OPACITY_STAGE_ORDER_CANDIDATE as STAGE_ORDER,
type CompiledTimelineOpacityStageCandidate,
} from '../packages/business/src/timeline-opacity-filter-candidate.ts';
import {
  OPACITY_ENVELOPE_PROFILE, OPACITY_ENVELOPE_LIMITS, createOpacityEnvelopeEvaluator,
} from '../packages/contracts/src/timeline-opacity-envelope.ts';
import {planTimelineExportRange} from '../packages/business/src/timeline-export-range-plan.ts';

const clip = (points: readonly (readonly [number,number])[], durationFrames: number|undefined = 18000) => ({durationFrames,
  opacityEnvelope: {profileId: OPACITY_ENVELOPE_PROFILE, points: points.map(([frame, opacity]) => ({frame, opacity}))},
});
const white = {r: 255, g: 255, b: 255, alpha: 255};

// Independent closed-grammar interpreter for the emitted geq stage. This parses
// every branch and rejects leftover text; it does not eval JS, invoke FFmpeg or
// establish pixel-format negotiation, integer rounding or native filter support.
function parseStage(stage: Readonly<CompiledTimelineOpacityStageCandidate>) {
  if (stage.filter === '') return (_n?: unknown, pixel?: Record<string,unknown>) => ({...(pixel as Record<string, unknown>)});
  const match = stage.filter.match(/^format=gbrap,geq=r=([^:]*):g=([^:]*):b=([^:]*):a=([^:]*):interpolation=nearest,format=rgba$/);
  assert.ok(match, 'exact, unique RGB/A option mapping and fixed stage wrappers');
  const channels = match.slice(1);
  const names: (keyof Pixel)[] = ['r', 'g', 'b', 'alpha'];
  const readers = channels.map((escaped) => {
    assert.ok(!/(?<!\\),/.test(escaped));
    assert.ok(!/\\(?!,)/.test(escaped));
    const text = escaped.replaceAll('\\,', ',');
    const tokens = text.match(/(?:\d+(?:\.\d+)?(?:e[+-]?\d+)?|alpha|lte|lt|if|[rgbNXY]|[()+*,/\-])/g) ?? [];
    assert.equal(tokens.join(''), text);
    let cursor = 0;
    const take = (value: string) => { assert.equal(tokens[cursor++], value); };
    function atom():NumericExpression {
      const token = tokens[cursor++];
      if (token === '(') { const a = add(); take(')'); return a; }
      if (token === 'N') return (n:number) => n;
      if (names.includes(token as keyof Pixel)) {
        take('('); take('X'); take(','); take('Y'); take(')');
        return (_n:number,pixel:Pixel) => pixel[token as keyof Pixel];
      }
      if (['if', 'lt', 'lte'].includes(token)) {
        take('('); const a = add(); take(','); const b = add();
        if (token === 'if') { take(','); const c = add(); take(')'); return (n:number,pixel:Pixel) => a(n, pixel) ? b(n, pixel) : c(n, pixel); }
        take(')'); return token === 'lt' ? (n:number,pixel:Pixel) => +(a(((n) as unknown as Parameters<NonNullable<typeof a>>[0]), pixel) < b(((n) as unknown as Parameters<NonNullable<typeof b>>[0]), pixel)) : (n:number,pixel:Pixel) => +(a(((n) as unknown as Parameters<NonNullable<typeof a>>[0]), pixel) <= b(((n) as unknown as Parameters<NonNullable<typeof b>>[0]), pixel));
      }
      assert.match(token, /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/);
      return () => Number(token);
    }
    function mul():NumericExpression {
      let a = atom();
      while (['*', '/'].includes(tokens[cursor])) {
        const op = tokens[cursor++], left = a, right = atom();
        a = op === '*' ? (n:number,pixel:Pixel) => left(((n) as unknown as Parameters<NonNullable<typeof left>>[0]), pixel) * right(((n) as unknown as Parameters<NonNullable<typeof right>>[0]), pixel) : (n:number,pixel:Pixel) => left(((n) as unknown as Parameters<NonNullable<typeof left>>[0]), pixel) / right(((n) as unknown as Parameters<NonNullable<typeof right>>[0]), pixel);
      }
      return a;
    }
    function add():NumericExpression {
      let a = mul();
      while (['+', '-'].includes(tokens[cursor])) {
        const op = tokens[cursor++], left = a, right = mul();
        a = op === '+' ? (n:number,pixel:Pixel) => left(((n) as unknown as Parameters<NonNullable<typeof left>>[0]), pixel) + right(((n) as unknown as Parameters<NonNullable<typeof right>>[0]), pixel) : (n:number,pixel:Pixel) => left(((n) as unknown as Parameters<NonNullable<typeof left>>[0]), pixel) - right(((n) as unknown as Parameters<NonNullable<typeof right>>[0]), pixel);
      }
      return a;
    }
    const result = add(); assert.equal(cursor, tokens.length); return result;
  });
  return (n:number,pixel:Pixel) => Object.fromEntries(names.map((name, index) => [name, readers[index](n, pixel)])) as Pixel;
}

function compare(stage: Readonly<CompiledTimelineOpacityStageCandidate>, original: unknown, frames: number[], pixel: Pixel = white) {
  const evaluate = parseStage(stage), reference = createOpacityEnvelopeEvaluator(original);
  for (const n of frames) {
    const factor = reference.atFrame(n + stage.offsetFrames);
    assert.equal(stage.atSegmentFrame(n), factor);
    assert.deepEqual(evaluate(n, ((pixel) as unknown as StrictIntersection<Parameters<NonNullable<typeof evaluate>>[1]>)), {
      r: pixel.r * (stage.alphaMode === 'premultiplied' ? factor : 1),
      g: pixel.g * (stage.alphaMode === 'premultiplied' ? factor : 1),
      b: pixel.b * (stage.alphaMode === 'premultiplied' ? factor : 1),
      alpha: pixel.alpha * factor,
    });
  }
}

test('absence/null preserve exact legacy graph; one frozen stage contract serves both purposes', () => {
  const legacy = '[v]format=rgba[normal];[base][normal]overlay[out]';
  for (const c of ([{durationFrames: 1}, {durationFrames: 1, opacityEnvelope: null}] as const)) {
    for (const mode of (['straight', 'premultiplied'] as const)) {
      const stage = compile(c, 0, 1, ((mode) as unknown as Parameters<typeof compile>[3]));
      assert.equal(stage.filter, '');
      assert.equal(legacy + stage.filter, legacy);
      assert.equal(stage.stage, 'clip-opacity');
      assert.equal(stage.atSegmentFrame(0), 1);
      assert.ok(Object.isFrozen(stage));
      assert.equal(stage.stageOrder, STAGE_ORDER);
      assert.ok(Object.isFrozen(stage.stageOrder));
    }
  }
  const c = clip([[0, 0.1], [12, 0.9]], 12);
  // The compiler exposes no purpose switch; both consumers receive this single
  // candidate stage shape and identical filter bytes for identical coordinates.
  const preview = compile(((c) as unknown as Parameters<typeof compile>[0]), 3, 5, 'straight'), exported = compile(((c) as unknown as Parameters<typeof compile>[0]), 3, 5, 'straight');
  assert.equal(preview.filter, exported.filter);
  assert.equal(preview.stageOrder, exported.stageOrder);
  assert.deepEqual(STAGE_ORDER, ['source-colour', 'creative-lut', 'resize-contain',
    'normalize-rgba-and-frame-timebase', 'clip-opacity', 'overlay', 'subtitles', 'output']);
});

test('emitted expressions match held endpoints, exact anchors and every integer frame', () => {
  const c = clip([[2, 0.8], [4, 0.1], [7, 1], [9, 0], [12, 0.3]], 12);
  const original = structuredClone(c);
  for (const mode of (['straight', 'premultiplied'] as const)) {
    const stage = compile(((c) as unknown as Parameters<typeof compile>[0]), 0, 12, ((mode) as unknown as Parameters<typeof compile>[3]));
    compare(stage, c, Array.from({length: 12}, (_, n) => n));
    const evaluate = parseStage(stage);
    for (const point of c.opacityEnvelope.points.filter(((p) => p.frame < 12))) assert.equal(evaluate(point.frame, white).alpha, 255 * point.opacity);
    c.opacityEnvelope.points[0].opacity = 0.4;
    assert.equal(stage.atSegmentFrame(0), original.opacityEnvelope.points[0].opacity);
    assert.equal(evaluate(0, white).alpha, 255 * original.opacityEnvelope.points[0].opacity);
    c.opacityEnvelope.points[0].opacity = original.opacityEnvelope.points[0].opacity;
  }
  assert.deepEqual(c, original);
});

test('selected range retains original segment/clip clock across unrelated clip edges', () => {
  const main = {...clip([[0, 0], [5, 1], [12, 0.2], [30, 0.6]], 30), startFrame: 5};
  const snapshot = {timeline: {fps: 30, durationFrames: 40, clips: [main,
    {startFrame: 12, durationFrames: 8}, {startFrame: 23, durationFrames: 8}, {startFrame: 35, durationFrames: 5}]}},
    full = planTimelineExportRange(snapshot), range = {startFrame: 9, endFrame: 29},
    selected = planTimelineExportRange({...snapshot, exportRange: range});
  const fullPixels = new Map();
  for (const segment of full.segments) {
    if (segment.beginFrame < main.startFrame || segment.endFrame > main.startFrame + main.durationFrames) continue;
    const stage = compile(((main) as unknown as Parameters<typeof compile>[0]), segment.beginFrame - main.startFrame, segment.endFrame - segment.beginFrame, 'premultiplied'), evaluate = parseStage(stage);
    for (let n = 0; n < stage.frameCount; n++) fullPixels.set(segment.beginFrame + n, evaluate(n, white));
  }
  assert.equal(selected.segments[0].beginFrame, 5);
  assert.equal(selected.segments[0].videoOutputTrim, 'trim=start_frame=4:end_frame=7,');
  assert.ok(!full.segments.some(segment => segment.beginFrame === 10 || segment.beginFrame === 17), 'opacity anchors do not create reseek segments');
  let outputFrames = 0;
  for (const segment of selected.segments) {
    const stage = compile(((main) as unknown as Parameters<typeof compile>[0]), segment.beginFrame - main.startFrame, segment.endFrame - segment.beginFrame, 'premultiplied'), evaluate = parseStage(stage);
    for (let absolute = Math.max(range.startFrame, segment.beginFrame); absolute < Math.min(range.endFrame, segment.endFrame); absolute++) {
      const n = absolute - segment.beginFrame;
      assert.deepEqual(evaluate(n, white), fullPixels.get(absolute));
      assert.equal(stage.atSegmentFrame(n), createOpacityEnvelopeEvaluator(main).atFrame(absolute - main.startFrame));
      outputFrames++;
    }
  }
  assert.equal(outputFrames, selected.outputFrames);
  assert.equal(outputFrames, 20);
});

test('straight changes only A; premultiplied changes RGB/A together before overlay', () => {
  const source = {r: 200, g: 100, b: 25, alpha: 128}, background = {r: 30, g: 70, b: 120};
  // A nonlinear synthetic creative LUT runs before premultiplication/opacity.
  // This proves the planned algebra; the frozen renderer does not consume it.
  const looked = {...source, r: source.r ** 2 / 255, g: source.g ** 2 / 255, b: source.b ** 2 / 255};
  const premultiplied:Pixel = {...looked, ...Object.fromEntries((['r', 'g', 'b'] as const).map(key => [key, looked[key] * looked.alpha / 255]))};
  assert.ok(STAGE_ORDER.indexOf('creative-lut') < STAGE_ORDER.indexOf('clip-opacity'));
  assert.ok(STAGE_ORDER.indexOf('clip-opacity') < STAGE_ORDER.indexOf('overlay'));
  for (const opacity of ([0, 0.25, 0.5, 1] as const)) {
    const c = clip([[0, opacity]], 1), straight = parseStage(compile(((c) as unknown as Parameters<typeof compile>[0]), 0, 1, 'straight'))(0, looked),
      premult = parseStage(compile(((c) as unknown as Parameters<typeof compile>[0]), 0, 1, 'premultiplied'))(0, premultiplied);
    assert.equal(straight.r, looked.r); assert.equal(straight.alpha, looked.alpha * opacity);
    for (const key of (['r', 'g', 'b'] as const)) {
      assert.equal((premult as Pixel)[key], premultiplied[key] * opacity);
      const straightOver = (straight as Pixel)[key] * (straight as Pixel).alpha / 255 + background[key] * (1 - straight.alpha / 255),
        premultOver = (premult as Pixel)[key] + background[key] * (1 - (premult as Pixel).alpha / 255);
      assert.ok(Math.abs(straightOver - premultOver) < 1e-12);
    }
    if (opacity === 0) assert.deepEqual(premult, {r: 0, g: 0, b: 0, alpha: 0});
  }
  const transparent = {r: 0, g: 0, b: 0, alpha: 0};
  assert.deepEqual(parseStage(compile(((clip([[0, 0.5]], 1)) as unknown as Parameters<typeof compile>[0]), 0, 1, 'premultiplied'))(0, transparent), transparent);
});

test('independent grammar reader rejects swapped/duplicate channel options and extra graph text', () => {
  const stage = compile(((clip([[0, 0.5]], 1)) as unknown as Parameters<typeof compile>[0]), 0, 1, 'straight');
  for (const filter of ([
    stage.filter.replace(':g=', ':temporary=').replace(':b=', ':g=').replace(':temporary=', ':b='),
    stage.filter.replace(':g=', ':b='),
    stage.filter + ';null',
    stage.filter.replace('r(X\\,Y)', 'r(X,Y)'),
    stage.filter.replace(':interpolation=nearest', ':interpolation=bilinear'),
  ] as const)) assert.throws(() => parseStage({...stage, filter}));
});

test('single point and seven-point closed grammar stay within conservative byte caps', () => {
  for (const value of ([0, 1, 0.1, Number.MIN_VALUE, 1e-7, 0.9999999999999999] as const)) {
    for (const mode of (['straight', 'premultiplied'] as const)) compare(compile(((clip([[18000, value]])) as unknown as Parameters<typeof compile>[0]), 17999, 1, ((mode) as unknown as Parameters<typeof compile>[3])), clip([[18000, value]]), [0]);
  }
  // Per interval: three <=32-byte opacity literals, two <=12-byte N terms,
  // three <=8-byte frame/delta literals, <=48 fixed bytes. Initial hold/final
  // literal reserve 128; each of four channels plus escaping reserves <=512.
  const expressionBound = (OPACITY_ENVELOPE_LIMITS.points - 1) * (3 * 32 + 2 * 12 + 3 * 8 + 48) + 128,
    filterBound = 4 * expressionBound + 512;
  assert.ok(expressionBound <= EXPRESSION_CAP); assert.ok(filterBound <= FILTER_CAP);
  const c = clip(Array.from({length: OPACITY_ENVELOPE_LIMITS.points}, (_, index) => [17994 + index, index % 2 ? 0.9999999999999999 : Number.MIN_VALUE]));
  for (const mode of (['straight', 'premultiplied'] as const)) {
    const stage = compile(((c) as unknown as Parameters<typeof compile>[0]), 17999, 1, ((mode) as unknown as Parameters<typeof compile>[3]));
    assert.ok(Buffer.byteLength(stage.filter) <= filterBound);
    assert.match(stage.filter, /^[\x20-\x7e]+$/);
    compare(stage, c, [0]);
    compare(compile(((c) as unknown as Parameters<typeof compile>[0]), 0, 18000, ((mode) as unknown as Parameters<typeof compile>[3])), c, [0, 17993, 17994, 17995, 17996, 17997, 17998, 17999]);
  }
});

test('malformed coordinates, alpha representations and expression injection reject', () => {
  const good = clip([[0, 0], [1, 1]], 1);
  for (const c of ([good, {durationFrames: 1}] as const)) {
    for (const [offset, count] of ([[-0, 1], [-1, 1], [0.5, 1], [0, 1.5], [0, 0], [0, -0], [1, 1], [0, 2], [NaN, 1], [0, Infinity], ['0', 1], [0, '1'], [Number.MAX_SAFE_INTEGER, 1]] as const)) {
      assert.throws(() => compile(((c) as unknown as Parameters<typeof compile>[0]), ((offset) as unknown as Parameters<typeof compile>[1]), ((count) as unknown as Parameters<typeof compile>[2]), 'straight'), error => (error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code === 'INVALID_OPACITY_ENVELOPE_FILTER');
    }
    for (const mode of ([undefined, null, '', 'premultiplied:drawbox', {}, 'rgb'] as const)) assert.throws(() => compile(((c) as unknown as Parameters<typeof compile>[0]), 0, 1, ((mode) as unknown as Parameters<typeof compile>[3])), error => (error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code === 'INVALID_OPACITY_ENVELOPE_FILTER');
  }
  for (const c of ([clip([[-0, 1]], 1), clip([[0, -0]], 1), clip([[0, NaN]], 1), clip([[0, Infinity]], 1), clip([[0, 2]], 1), clip([[0, 1], [0, 0]], 1), clip([[2, 1]], 1), clip([], 1), clip(Array.from({length: 8}, (_, n) => [n, 1])), {durationFrames: 1, opacityEnvelope: undefined}] as const)) assert.throws(() => compile(((c) as unknown as Parameters<typeof compile>[0]), 0, 1, 'straight'));
  for (const key of (['frame', 'opacity'] as const)) {
    const c = clip([[0, 1]], 1); (c.opacityEnvelope.points[0] as unknown as Record<typeof key,string>)[key] = '0);movie=/private/input;[out]';
    assert.throws(() => compile(((c) as unknown as Parameters<typeof compile>[0]), 0, 1, 'straight'));
  }
  const profile = clip([[0, 1]], 1); profile.opacityEnvelope.profileId = 'anullsrc';
  assert.throws(() => compile(((profile) as unknown as Parameters<typeof compile>[0]), 0, 1, 'straight'));
  const extra = clip([[0, 1]], 1); (extra.opacityEnvelope as unknown as {expression:("drawbox")}).expression = 'drawbox';
  assert.throws(() => compile(((extra) as unknown as Parameters<typeof compile>[0]), 0, 1, 'straight'));
  const ordinaryClip = {...good, expression: 'drawbox', label: '[out]'};
  assert.equal(compile(((ordinaryClip) as unknown as Parameters<typeof compile>[0]), 0, 1, 'straight').filter, compile(((good) as unknown as Parameters<typeof compile>[0]), 0, 1, 'straight').filter, 'other clip data grants no filter/label capability');
});

test('ordinary data accessors and sparse/extended points reject without executing getters', () => {
  let getters = 0;
  for (const mutate of ([
(    c: { opacityEnvelope: { points: string|unknown[]; }; }) => { (c.opacityEnvelope.points as {length: number}).length = 2; },
(    c: { opacityEnvelope: { points: { extra: number; }; }; }) => { c.opacityEnvelope.points.extra = 1; },
(    c: { opacityEnvelope: { points: { extra: number; }[]; }; }) => { c.opacityEnvelope.points[0].extra = 1; },
(    c: { opacityEnvelope: { points: Date[]; }; }) => { c.opacityEnvelope.points[0] = new Date(); },
(    c: { opacityEnvelope: { points: unknown; }; }) => { Object.defineProperty(c.opacityEnvelope.points, '0', {get() { getters++; }, enumerable: true}); },
(    c?: unknown) => { Object.defineProperty(c, 'opacityEnvelope', {get() { getters++; }, enumerable: true}); },
(    c?: unknown) => { Object.defineProperty(c, 'durationFrames', {get() { getters++; }, enumerable: true}); },
  ] as const)) {
    const c = clip([[0, 1]], 1); (mutate as (value:unknown)=>unknown)(((((c) as unknown as Parameters<typeof mutate>[0])) as unknown as StrictIntersection<Parameters<NonNullable<typeof mutate>>[0]>));
    assert.throws(() => compile(((c) as unknown as Parameters<typeof compile>[0]), 0, 1, 'straight'), error => (error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code === 'INVALID_OPACITY_ENVELOPE');
  }
  assert.equal(getters, 0);
  const stage = compile(((clip([[0, 1]], 1)) as unknown as Parameters<typeof compile>[0]), 0, 1, 'straight');
  for (const n of ([-0, -1, 1, 0.5, NaN, Infinity, '0'] as const)) assert.throws(() => stage.atSegmentFrame(((n) as unknown as Parameters<typeof stage.atSegmentFrame>[0])), error => (error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code === 'INVALID_OPACITY_ENVELOPE_FILTER');
});

test('deterministic emitted curves and shared evaluator agree at original clip coordinates', () => {
  let state = 0x12345678;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  for (let run = 0; run < 20; run++) {
    const c = clip(Array.from({length: OPACITY_ENVELOPE_LIMITS.points}, (_, index) => [index * 3000, next()])), before = structuredClone(c),
      offset = Math.floor(next() * 18000), count = 18000 - offset,
      mode = run % 2 ? 'straight' : 'premultiplied', stage = compile(((c) as unknown as Parameters<typeof compile>[0]), offset, count, mode);
    compare(stage, c, Array.from({length: 100}, () => Math.floor(next() * count)), {r: 123, g: 45, b: 6, alpha: 128});
    assert.deepEqual(c, before);
    assert.equal(stage.filter, compile(((c) as unknown as Parameters<typeof compile>[0]), offset, count, mode).filter);
  }
});

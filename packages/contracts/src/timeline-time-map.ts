/** Shared time mapping for the 0.4.0 speed features (SP-M).
 *
 * This module is pure: it has no DOM, database, FFmpeg, clock or I/O
 * dependency and it never writes project data. Source coordinates are
 * positions on the project's source clock (the plan's source frame unit);
 * output coordinates are positions on the output clock. A map is an immutable
 * *basis* (a fixed forward integral clock T) plus a *view* (lo/hi output-time
 * boundaries, a direction and an output window). Splitting and trimming only
 * move the view window, so a split keeps the exact source phase instead of
 * re-rounding a rounded source in-point.
 *
 * Numeric profile `timeline-time-map-v1`:
 * - constant speed uses exact reduced rational arithmetic (BigInt) end to end;
 *   the root length, every inverse source position, every floor/ceil decision
 *   and every split/tail rule are exact;
 * - a log-PCHIP curve is evaluated with a versioned deterministic double
 *   pipeline that only uses IEEE-754 + - * / (no libm), so the same inputs
 *   produce bit-identical integers in Node and in a browser. Integration and
 *   inverse decisions carry an explicit, conservative error bound. A frame
 *   boundary that is not decidable under the bound is refined to tighter
 *   integration levels; if the configured refinement budget is exhausted the
 *   compile fails with `UNRESOLVED_BOUNDARY` instead of silently adding an
 *   epsilon. The escalation levels are pinned in this file.
 * - freeze maps are exact integer holds.
 *
 * The persisted format is not part of this module (format 6 is SP-D). The
 * clip seam at the bottom converts the current clip record into an identity
 * 1x map and projects a compiled map back onto the current
 * `durationFrames/sourceInFrame` fields; it does not add fields to the
 * project format.
 */

export const TIMELINE_TIME_MAP_PROFILE = 'timeline-time-map-v1' as const;
export const TIMELINE_TIME_MAP_BASIS_PROFILE = 'timeline-speed-v1' as const;
export const TIMELINE_TIME_MAP_INTERPOLATION = 'log-pchip-v1' as const;

export const TIMELINE_TIME_MAP_LIMITS = Object.freeze({
  /** Curve control points include both domain ends. */
  maxCurvePoints: 32,
  /** Reduced speed numerator/denominator bound, and the supported speed range. */
  maxRateTerm: 1_000_000,
  minRate: Object.freeze({numerator: 1, denominator: 10}),
  maxRate: Object.freeze({numerator: 10, denominator: 1}),
  /** P5 edit frame budget for one compiled window. */
  maxOutputFrames: 300_000,
  /** Conservative cap for the source range of one basis. */
  maxSourceFrames: 3_000_000,
  /** Default curve budget: source-frame cells for the cumulative table. */
  maxCurveCells: 1_000_000,
  /** Step ceiling for the cumulative curve table, in source frames. */
  maxCurveCellStep: 64,
});

export const TIMELINE_TIME_MAP_ERROR_CODES = Object.freeze([
  'UNSUPPORTED_PROFILE', 'INVALID_TIMEBASE', 'INVALID_SOURCE_RANGE', 'INVALID_RATE', 'INVALID_CURVE_POINTS',
  'POINT_LIMIT', 'OUTPUT_FRAME_LIMIT', 'SOURCE_FRAME_LIMIT', 'NUMERIC_BUDGET_EXCEEDED', 'UNRESOLVED_BOUNDARY',
  'INVALID_WINDOW', 'INVALID_REQUEST',
] as const);
export type TimeMapErrorCode = typeof TIMELINE_TIME_MAP_ERROR_CODES[number];

export interface TimeMapFailure {
  readonly ok: false;
  readonly code: TimeMapErrorCode;
  readonly detail: string;
}
export type TimeMapResult<T> = {readonly ok: true; readonly value: T} | TimeMapFailure;
const fail = <T>(code: TimeMapErrorCode, detail: string): TimeMapResult<T> => ({ok: false, code, detail});
const done = <T>(value: T): TimeMapResult<T> => ({ok: true, value});

/** Reduced positive rational expressed by safe integers (UI speed values). */
export interface TimeMapSpeedRate { readonly numerator: number; readonly denominator: number }
/** Frames-per-second rational timebase, e.g. `{fpsNumerator: 30, fpsDenominator: 1}`. */
export interface TimeMapTimebase { readonly fpsNumerator: number; readonly fpsDenominator: number }
/** An exact source boundary: a reduced rational or a canonical signed Q64 tick value. */
export type TimeMapSourceBoundary =
  | {readonly kind: 'rational'; readonly numerator: string; readonly denominator: string}
  | {readonly kind: 'q64'; readonly ticks: string};
export interface TimeMapSourceRange { readonly start: TimeMapSourceBoundary; readonly end: TimeMapSourceBoundary }
export interface TimeMapCurvePoint { readonly sourceFrame: number; readonly rate: TimeMapSpeedRate }
export type TimeMapSpeed =
  | {readonly kind: 'constant'; readonly rate: TimeMapSpeedRate}
  | {readonly kind: 'curve'; readonly interpolation: typeof TIMELINE_TIME_MAP_INTERPOLATION; readonly presetId: string; readonly points: readonly TimeMapCurvePoint[]};
export interface TimeMapBasis {
  readonly profile: typeof TIMELINE_TIME_MAP_BASIS_PROFILE;
  readonly sourceFps: TimeMapTimebase;
  readonly outputFps: TimeMapTimebase;
  /** Continuous source range of this basis. A curve keeps its original absolute
   * control points; this range only bounds the forward integral clock. */
  readonly sourceRange: TimeMapSourceRange;
  readonly speed: TimeMapSpeed;
}

export interface TimeMapViewBoundary { readonly anchor: 'start' | 'end'; readonly offsetOutputFrames: number }
export interface TimeMapOutputWindow { readonly fromFrame: number; readonly toFrame: number }

/** Opaque compiled forward mapping. Same input means same `mapHash` everywhere. */
export interface CompiledTimeMapRoot {
  readonly profile: typeof TIMELINE_TIME_MAP_PROFILE;
  readonly interpolation: 'constant' | typeof TIMELINE_TIME_MAP_INTERPOLATION | 'freeze';
  readonly mapHash: string;
  /** Natural output length ceil(L) of the complete basis range. */
  readonly durationFrames: number;
  readonly sourceRange: TimeMapSourceRange;
  readonly sourceFps: TimeMapTimebase;
  readonly outputFps: TimeMapTimebase;
}

/** Opaque compiled window: one immutable root plus a view. */
export interface CompiledTimeMap {
  readonly profile: typeof TIMELINE_TIME_MAP_PROFILE;
  readonly root: CompiledTimeMapRoot;
  readonly direction: 'forward' | 'reverse';
  /** Integer output window inside the view; duration is `toFrame - fromFrame`. */
  readonly outputWindow: TimeMapOutputWindow;
  readonly durationFrames: number;
}

export interface TimeMapSourceWindow {
  readonly startFrame: number;
  readonly endFrame: number;
  readonly frameCount: number;
  readonly direction: 'forward' | 'reverse';
  readonly outputFromFrame: number;
  readonly outputToFrame: number;
}
export type ContinuousSourcePosition =
  | {readonly kind: 'exact'; readonly numerator: string; readonly denominator: string}
  | {readonly kind: 'numeric'; readonly value: number; readonly errorBound: number};
export interface TimeMapVisibleSourceRange {
  readonly lo: ContinuousSourcePosition;
  readonly hi: ContinuousSourcePosition;
  readonly sourceWindow: {readonly startFrame: number; readonly endFrame: number};
}
export interface TimeMapSourceSample {
  readonly outputFrame: number;
  /** Continuous source position the decoder should show at this output frame. */
  readonly source: ContinuousSourcePosition;
  /** Source clock frame selected by the direction rule (forward floor, reverse ceil-1). */
  readonly sourceFrame: number;
  readonly nextSourceFrame: number;
  /** Fractional part of the continuous position inside `[sourceFrame, sourceFrame+1)`. */
  readonly phase: number;
  readonly tail: boolean;
}
export interface TimeMapOutputAtSource {
  readonly status: 'inside' | 'before' | 'after';
  readonly firstOutputFrame: number | null;
  readonly lastOutputFrame: number | null;
}

export interface TimeMapCompileOptions {
  /** Resource budget for the curve cumulative table (source cells). */
  readonly maxCurveCells?: number;
  /** Refinement ladder index cap for undecidable curve boundaries. */
  readonly maxRefinementLevel?: number;
}
export interface TimeMapFreezeInput {
  readonly sourceFrame: number;
  readonly durationFrames: number;
  readonly sourceFps?: TimeMapTimebase;
  readonly outputFps?: TimeMapTimebase;
}

// ---------------------------------------------------------------------------
// Exact rational helpers (reduced, denominator > 0, BigInt backed).
// ---------------------------------------------------------------------------

interface Rat { readonly n: bigint; readonly d: bigint }
const RAT_BITS = 128;
const absBig = (n: bigint): bigint => n < 0n ? -n : n;
function gcdBig(a: bigint, b: bigint): bigint {
  a = absBig(a); b = absBig(b);
  while (b !== 0n) {const t = a % b; a = b; b = t;}
  return a;
}
function ratNorm(n: bigint, d: bigint): Rat {
  if (d === 0n) throw new Error('zero denominator');
  if (d < 0n) {n = -n; d = -d;}
  const g = gcdBig(n, d);
  return {n: n / g, d: d / g};
}
const ratInt = (value: number | bigint): Rat => ratNorm(BigInt(value), 1n);
const ratAdd = (a: Rat, b: Rat): Rat => ratNorm(a.n * b.d + b.n * a.d, a.d * b.d);
const ratNeg = (a: Rat): Rat => ratNorm(-a.n, a.d);
const ratSub = (a: Rat, b: Rat): Rat => ratAdd(a, ratNeg(b));
const ratMul = (a: Rat, b: Rat): Rat => ratNorm(a.n * b.n, a.d * b.d);
const ratDiv = (a: Rat, b: Rat): Rat => ratNorm(a.n * b.d, a.d * b.n);
const ratCmp = (a: Rat, b: Rat): number => {const left = a.n * b.d, right = b.n * a.d; return left === right ? 0 : left > right ? 1 : -1;};
const ratFloor = (a: Rat): bigint => a.n >= 0n ? a.n / a.d : -((-a.n + a.d - 1n) / a.d);
const ratCeil = (a: Rat): bigint => -ratFloor(ratNeg(a));
const ratIsInteger = (a: Rat): boolean => a.d === 1n;
const ratNumber = (a: Rat): number => Number(a.n) / Number(a.d);
const ratText = (a: Rat): string => a.d === 1n ? String(a.n) : `${a.n}/${a.d}`;
const ratFromBoundary = (boundary: TimeMapSourceBoundary): Rat => {
  if (boundary.kind === 'rational') {
    const n = BigInt(boundary.numerator), d = BigInt(boundary.denominator);
    return ratNorm(n, d);
  }
  return ratNorm(BigInt(boundary.ticks), 1n << 64n);
};
const ratToBoundary = (value: Rat): TimeMapSourceBoundary => ({kind: 'rational', numerator: String(value.n), denominator: String(value.d)});
function bitLength(value: bigint): number {let bits = 0; let n = absBig(value); while (n > 0n) {bits++; n >>= 1n;} return bits;}
function ratBounded(value: Rat): boolean {return bitLength(value.n) <= RAT_BITS && bitLength(value.d) <= RAT_BITS;}

const gcdNumber = (a: number, b: number): number => {a = Math.abs(a); b = Math.abs(b); while (b !== 0) {const t = a % b; a = b; b = t;} return a;};
function speedRate(value: {numerator: number; denominator: number}): TimeMapResult<Rat> {
  const {numerator, denominator} = value;
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator <= 0 || denominator <= 0
    || numerator > TIMELINE_TIME_MAP_LIMITS.maxRateTerm || denominator > TIMELINE_TIME_MAP_LIMITS.maxRateTerm) {
    return fail('INVALID_RATE', 'speed must be a reduced positive rational within the supported bound');
  }
  if (gcdNumber(numerator, denominator) !== 1) return fail('INVALID_RATE', 'speed rational must be reduced');
  const rate = ratNorm(BigInt(numerator), BigInt(denominator));
  if (ratCmp(rate, ratNorm(1n, 10n)) < 0 || ratCmp(rate, ratNorm(10n, 1n)) > 0) {
    return fail('INVALID_RATE', 'speed must stay within 0.1x and 10x');
  }
  return done(rate);
}
function timebase(value: TimeMapTimebase): TimeMapResult<Rat> {
  const {fpsNumerator, fpsDenominator} = value;
  if (!Number.isSafeInteger(fpsNumerator) || !Number.isSafeInteger(fpsDenominator) || fpsNumerator <= 0 || fpsDenominator <= 0
    || fpsNumerator > 10_000 || fpsDenominator > 10_000 || gcdNumber(fpsNumerator, fpsDenominator) !== 1) {
    return fail('INVALID_TIMEBASE', 'timebase must be a reduced positive rational');
  }
  return done(ratNorm(BigInt(fpsNumerator), BigInt(fpsDenominator)));
}

// ---------------------------------------------------------------------------
// Deterministic double primitives (no libm; + - * / only).
// ---------------------------------------------------------------------------

const LN2 = 0.6931471805599453;
const LN10 = 2.302585092994046;
const EXP_RECIPROCAL_FACTORIAL = Object.freeze([
  1, 1 / 2, 1 / 6, 1 / 24, 1 / 120, 1 / 720, 1 / 5040, 1 / 40320, 1 / 362880, 1 / 3628800,
  1 / 39916800, 1 / 479001600, 1 / 6227020800, 1 / 87178291200, 1 / 1307674368000,
  1 / 20922789888000,
]);
/** Deterministic `exp(x)`: range reduction by ln 2 plus a fixed Maclaurin series.
 * Only + - * /, Math.round and powers of two are used. Math.round has exact
 * specification semantics, and scaling by a power of two is exact, so Node and
 * a Chromium page produce bit-identical doubles for the same input. */
function detExp(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  if (x > 709) return Number.MAX_VALUE;
  if (x < -745) return 0;
  const k = Math.round(x / LN2);
  const hi = x - k * LN2;
  const low = (x - hi) - k * LN2;
  const remainder = hi + low;
  let term = 1, result = 1;
  for (const reciprocal of EXP_RECIPROCAL_FACTORIAL) {
    term *= remainder;
    result += term * reciprocal;
  }
  return scaleByPowerOfTwo(result, k);
}
function scaleByPowerOfTwo(value: number, exponent: number): number {
  let result = value;
  let factor = exponent < 0 ? 0.5 : 2;
  let count = exponent < 0 ? -exponent : exponent;
  while (count > 0) {
    if ((count & 1) === 1) result *= factor;
    factor *= factor;
    count >>= 1;
  }
  return result;
}
/** Deterministic `ln(x)` for finite x > 0: range reduction by 2 and the atanh series. */
function detLog(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return NaN;
  let exponent = 0;
  let value = x;
  while (value >= 2) {value /= 2; exponent++;}
  while (value < 1) {value *= 2; exponent--;}
  const z = (value - 1) / (value + 1);
  const z2 = z * z;
  let sum = 0, power = z;
  for (let k = 0; k < 40; k++) {
    sum += power / (2 * k + 1);
    power *= z2;
  }
  return 2 * sum + exponent * LN2;
}
const clampNumber = (value: number, lo: number, hi: number): number => value < lo ? lo : value > hi ? hi : value;

// ---------------------------------------------------------------------------
// Deterministic hashing and stable JSON for committed fixtures.
// ---------------------------------------------------------------------------

const FNV_OFFSET = 0xcbf29ce484222325n, FNV_PRIME = 0x100000001b3n, MASK64 = (1n << 64n) - 1n;
function fnv1a64(text: string): string {
  let hash = FNV_OFFSET;
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index) & 0xff);
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash.toString(16).padStart(16, '0');
}
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item === undefined ? null : item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}
/** Stable FNV-1a/64 over canonical JSON. Used for cross-runtime fixtures. */
export function timeMapStableHash(value: unknown): string { return fnv1a64(stableJson(value)); }
export function timeMapStableJson(value: unknown): string { return stableJson(value); }

// ---------------------------------------------------------------------------
// Root/plan registry: opaque objects keep their numeric state module-local.
// ---------------------------------------------------------------------------

interface CurveState {
  readonly points: readonly TimeMapCurvePoint[];
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly hs: Float64Array;
  readonly ms: Float64Array;
  /** Integral at each control point, in source integral units, from xs[0]. */
  readonly prefix: Float64Array;
  readonly prefixError: Float64Array;
}
interface RootState {
  readonly kind: 'constant' | 'curve' | 'freeze';
  readonly basis: TimeMapBasis;
  readonly sourceStart: Rat;
  readonly sourceEnd: Rat;
  readonly sourceFps: Rat;
  readonly outputFps: Rat;
  /** Output frames per source-integral unit, Fo/Fs. */
  readonly framesPerIntegral: Rat;
  readonly rate: Rat | null;
  readonly curve: CurveState | null;
  readonly freezeFrame: number | null;
  /** Forward integral at sourceStart (normally 0; non-zero when the basis range starts inside a curve). */
  readonly integralOrigin: number;
  readonly integralOriginError: number;
  /** Integral over [sourceStart, sourceEnd). */
  readonly integralTotal: number;
  readonly integralError: number;
  /** Exact output length for constant/freeze roots. */
  readonly lengthExact: Rat | null;
  readonly lengthNumber: number;
  readonly lengthError: number;
  readonly floorLength: bigint;
  readonly ceilLength: bigint;
  readonly lengthIsInteger: boolean;
  readonly durationFrames: number;
  readonly frameRange: {readonly start: number; readonly end: number};
  readonly frames: Map<'forward' | 'reverse', Int32Array>;
}
interface PlanState {
  readonly root: CompiledTimeMapRoot;
  readonly direction: 'forward' | 'reverse';
  readonly loTime: TimeMapViewBoundary;
  readonly hiTime: TimeMapViewBoundary;
  readonly outputWindow: TimeMapOutputWindow;
}
const ROOT_STATE = new WeakMap<object, RootState>();
const PLAN_STATE = new WeakMap<object, PlanState>();
const rootState = (root: CompiledTimeMapRoot): RootState => {
  const state = ROOT_STATE.get(root);
  if (!state) throw new Error('Unknown compiled time map root');
  return state;
};
const planState = (plan: CompiledTimeMap): PlanState => {
  const state = PLAN_STATE.get(plan);
  if (!state) throw new Error('Unknown compiled time map');
  return state;
};
const EPSILON = Number.EPSILON;
const numberFromRat = (value: Rat): number => ratNumber(value);
type RootTimeValue = {readonly kind: 'clock'; readonly frames: number} | {readonly kind: 'rootEnd'; readonly offset: number};
const clockTime = (frames: number): RootTimeValue => ({kind: 'clock', frames});
const timeShift = (value: RootTimeValue, delta: number): RootTimeValue => value.kind === 'clock'
  ? {kind: 'clock', frames: value.frames + delta} : {kind: 'rootEnd', offset: value.offset + delta};
const boundaryTimeValue = (boundary: TimeMapViewBoundary): RootTimeValue => boundary.anchor === 'start'
  ? clockTime(boundary.offsetOutputFrames) : {kind: 'rootEnd', offset: boundary.offsetOutputFrames};
const boundaryFromTimeValue = (value: RootTimeValue): TimeMapViewBoundary => value.kind === 'clock'
  ? {anchor: 'start', offsetOutputFrames: value.frames} : {anchor: 'end', offsetOutputFrames: value.offset};
/** Canonical boundary for a clock value: prefer `start + integer` while it stays
 * indexable, and use `end + offset` for the root end or a fractional length. */
function canonicalTimeBoundary(state: RootState, value: RootTimeValue): TimeMapViewBoundary {
  if (value.kind === 'clock') {
    if (state.lengthIsInteger && value.frames === state.lengthNumber) return {anchor: 'end', offsetOutputFrames: 0};
    return {anchor: 'start', offsetOutputFrames: value.frames};
  }
  if (state.lengthIsInteger) {
    const absolute = state.lengthNumber + value.offset;
    if (absolute === 0) return {anchor: 'start', offsetOutputFrames: 0};
    if (absolute === state.lengthNumber) return {anchor: 'end', offsetOutputFrames: 0};
    return {anchor: 'start', offsetOutputFrames: absolute};
  }
  return {anchor: 'end', offsetOutputFrames: value.offset};
}
function timeNumber(state: RootState, value: RootTimeValue): number {
  return value.kind === 'clock' ? value.frames : state.lengthNumber + value.offset;
}
function timeExact(state: RootState, value: RootTimeValue): Rat | null {
  if (state.lengthExact === null) return null;
  return value.kind === 'clock' ? ratInt(value.frames) : ratAdd(state.lengthExact, ratInt(value.offset));
}
function timeUncertainty(state: RootState, value: RootTimeValue): number {
  if (value.kind === 'clock') return 4 * EPSILON * (Math.abs(value.frames) + 1);
  return state.lengthError + 4 * EPSILON * (Math.abs(state.lengthNumber + value.offset) + 1);
}

// ---------------------------------------------------------------------------
// Root construction, hashing and the compile entry points.
// ---------------------------------------------------------------------------

function canonicalBoundary(boundary: TimeMapSourceBoundary): unknown {
  if (boundary.kind === 'q64') return {kind: 'q64', ticks: BigInt(boundary.ticks).toString()};
  const rat = ratNorm(BigInt(boundary.numerator), BigInt(boundary.denominator));
  return {kind: 'rational', numerator: String(rat.n), denominator: String(rat.d)};
}
function canonicalBasis(basis: TimeMapBasis): unknown {
  return {
    profile: basis.profile, sourceFps: basis.sourceFps, outputFps: basis.outputFps,
    sourceRange: {start: canonicalBoundary(basis.sourceRange.start), end: canonicalBoundary(basis.sourceRange.end)},
    speed: basis.speed.kind === 'constant'
      ? {kind: 'constant', rate: {numerator: basis.speed.rate.numerator, denominator: basis.speed.rate.denominator}}
      : {kind: 'curve', interpolation: basis.speed.interpolation,
          // The point set is authoritative; the preset label is presentation metadata.
          points: basis.speed.points.map(point => ({sourceFrame: point.sourceFrame, rate: {numerator: point.rate.numerator, denominator: point.rate.denominator}}))},
  };
}
function rootHash(basis: TimeMapBasis): string {
  return timeMapStableHash({profile: TIMELINE_TIME_MAP_PROFILE, basis: canonicalBasis(basis)});
}
function makeRoot(state: RootState): CompiledTimeMapRoot {
  const root: CompiledTimeMapRoot = Object.freeze({
    profile: TIMELINE_TIME_MAP_PROFILE,
    interpolation: state.kind === 'constant' ? 'constant' : state.kind === 'freeze' ? 'freeze' : TIMELINE_TIME_MAP_INTERPOLATION,
    mapHash: rootHash(state.basis),
    durationFrames: state.durationFrames,
    sourceRange: state.basis.sourceRange,
    sourceFps: state.basis.sourceFps,
    outputFps: state.basis.outputFps,
  });
  ROOT_STATE.set(root, state);
  return root;
}
function makePlan(root: CompiledTimeMapRoot, view: {loTime: TimeMapViewBoundary; hiTime: TimeMapViewBoundary; direction: 'forward' | 'reverse'; outputWindow: TimeMapOutputWindow}): CompiledTimeMap {
  const duration = view.outputWindow.toFrame - view.outputWindow.fromFrame;
  const plan: CompiledTimeMap = Object.freeze({
    profile: TIMELINE_TIME_MAP_PROFILE, root, direction: view.direction,
    outputWindow: Object.freeze({fromFrame: view.outputWindow.fromFrame, toFrame: view.outputWindow.toFrame}),
    durationFrames: duration,
  });
  PLAN_STATE.set(plan, {root, direction: view.direction, loTime: Object.freeze({...view.loTime}), hiTime: Object.freeze({...view.hiTime}),
    outputWindow: plan.outputWindow});
  return plan;
}

/** Compiles the immutable forward mapping of a basis. */
export function compileTimeMap(basis: TimeMapBasis, options: TimeMapCompileOptions = {}): TimeMapResult<CompiledTimeMapRoot> {
  return compileBasis(basis, options);
}

function compileBasis(basis: TimeMapBasis, options: TimeMapCompileOptions): TimeMapResult<CompiledTimeMapRoot> {
  if (basis.profile !== TIMELINE_TIME_MAP_BASIS_PROFILE) return fail('UNSUPPORTED_PROFILE', 'unsupported timing basis profile');
  const sourceFps = timebase(basis.sourceFps);
  if (!sourceFps.ok) return sourceFps;
  const outputFps = timebase(basis.outputFps);
  if (!outputFps.ok) return outputFps;
  const start = ratFromBoundary(basis.sourceRange.start), end = ratFromBoundary(basis.sourceRange.end);
  if (ratCmp(start, ratInt(0n)) < 0 || ratCmp(start, end) >= 0) return fail('INVALID_SOURCE_RANGE', 'source range must be a non-empty interval with a non-negative start');
  const span = ratSub(end, start);
  if (ratCmp(span, ratInt(BigInt(TIMELINE_TIME_MAP_LIMITS.maxSourceFrames))) > 0) return fail('SOURCE_FRAME_LIMIT', 'source range exceeds the profile limit');
  if (!ratBounded(start) || !ratBounded(end)) return fail('INVALID_SOURCE_RANGE', 'source boundary exceeds the exact rational bound');
  const framesPerIntegral = ratDiv(outputFps.value, sourceFps.value);
  const frameRange = {start: Number(ratFloor(start)), end: Number(ratCeil(end)) - 1};
  if (basis.speed.kind === 'constant') {
    const rate = speedRate(basis.speed.rate);
    if (!rate.ok) return rate;
    return compileExactSpeed(basis, start, end, rate.value, framesPerIntegral, sourceFps.value, outputFps.value, frameRange, 'constant');
  }
  if (basis.speed.kind === 'curve') {
    if (basis.speed.interpolation !== TIMELINE_TIME_MAP_INTERPOLATION) return fail('UNSUPPORTED_PROFILE', 'unsupported curve interpolation');
    const shape = validateCurvePoints(basis.speed.points, start, end);
    if (shape) return shape;
    const constantRate = constantCurveRate(basis.speed.points);
    if (constantRate) return compileExactSpeed(basis, start, end, constantRate, framesPerIntegral, sourceFps.value, outputFps.value, frameRange, 'curve');
    const curve = compileCurve(basis.speed.points, start, end, framesPerIntegral, options);
    if (!curve.ok) return curve;
    const compiled = curve.value;
    if (compiled.durationFrames > TIMELINE_TIME_MAP_LIMITS.maxOutputFrames) return fail('OUTPUT_FRAME_LIMIT', 'compiled duration exceeds the output frame limit');
    const state: RootState = {
      kind: 'curve', basis, sourceStart: start, sourceEnd: end, sourceFps: sourceFps.value, outputFps: outputFps.value,
      framesPerIntegral, rate: null, curve: compiled.curve, freezeFrame: null,
      integralOrigin: compiled.integralOrigin, integralOriginError: compiled.integralOriginError,
      integralTotal: compiled.integralTotal, integralError: compiled.integralError,
      lengthExact: null, lengthNumber: compiled.lengthNumber, lengthError: compiled.lengthError,
      floorLength: compiled.floorLength, ceilLength: compiled.ceilLength, lengthIsInteger: false,
      durationFrames: compiled.durationFrames, frameRange, frames: new Map(),
    };
    return done(makeRoot(state));
  }
  return fail('UNSUPPORTED_PROFILE', 'unsupported speed kind');
}
function compileExactSpeed(basis: TimeMapBasis, start: Rat, end: Rat, rate: Rat, framesPerIntegral: Rat, sourceFps: Rat, outputFps: Rat,
  frameRange: {start: number; end: number}, kind: 'constant' | 'curve'): TimeMapResult<CompiledTimeMapRoot> {
  const span = ratSub(end, start);
  const length = ratMul(ratMul(framesPerIntegral, span), ratDiv(ratInt(1n), rate));
  const duration = Number(ratCeil(length));
  if (duration < 1) return fail('INVALID_SOURCE_RANGE', 'compiled duration must be positive');
  if (duration > TIMELINE_TIME_MAP_LIMITS.maxOutputFrames) return fail('OUTPUT_FRAME_LIMIT', 'compiled duration exceeds the output frame limit');
  const state: RootState = {
    kind, basis, sourceStart: start, sourceEnd: end, sourceFps, outputFps, framesPerIntegral, rate, curve: null, freezeFrame: null,
    integralOrigin: 0, integralOriginError: 0, integralTotal: 0, integralError: 0,
    lengthExact: length, lengthNumber: ratNumber(length), lengthError: 0,
    floorLength: ratFloor(length), ceilLength: ratCeil(length), lengthIsInteger: ratIsInteger(length),
    durationFrames: duration, frameRange, frames: new Map(),
  };
  return done(makeRoot(state));
}

/** Structural curve validation shared by the exact constant-equivalent path and
 * the numeric compiler, so a malformed curve cannot slip through the shortcut. */
function validateCurvePoints(points: readonly TimeMapCurvePoint[], sourceStart: Rat, sourceEnd: Rat): TimeMapFailure | null {
  if (!Array.isArray(points) || points.length < 2) return {ok: false, code: 'INVALID_CURVE_POINTS', detail: 'a curve needs at least two control points'};
  if (points.length > TIMELINE_TIME_MAP_LIMITS.maxCurvePoints) return {ok: false, code: 'POINT_LIMIT', detail: 'a curve supports at most 32 control points'};
  for (const [index, point] of points.entries()) {
    if (!Number.isSafeInteger(point.sourceFrame) || point.sourceFrame < 0) return {ok: false, code: 'INVALID_CURVE_POINTS', detail: 'control point source frames must be non-negative safe integers'};
    if (index > 0 && point.sourceFrame <= points[index - 1]!.sourceFrame) return {ok: false, code: 'INVALID_CURVE_POINTS', detail: 'control point source frames must be strictly increasing'};
    if (!speedRate(point.rate).ok) return {ok: false, code: 'INVALID_RATE', detail: 'control rates must be reduced rationals inside 0.1x..10x'};
  }
  if (ratCmp(ratInt(points[0]!.sourceFrame), sourceStart) > 0 || ratCmp(ratInt(points[points.length - 1]!.sourceFrame), sourceEnd) < 0) {
    return {ok: false, code: 'INVALID_CURVE_POINTS', detail: 'control points must cover both ends of the source range'};
  }
  return null;
}

/** A curve whose every control rate is identical is exactly a constant map; the
 * identity custom curve must not pay the numeric pipeline (or its ties rules). */
function constantCurveRate(points: readonly TimeMapCurvePoint[]): Rat | null {
  if (!Array.isArray(points) || points.length === 0) return null;
  const first = points[0]?.rate;
  if (!first || points.some(point => point.rate.numerator !== first.numerator || point.rate.denominator !== first.denominator)) return null;
  const rate = speedRate(first);
  return rate.ok ? rate.value : null;
}

/** Freeze: one source frame held for an integer output duration. */
export function compileFreezeTimeMap(input: TimeMapFreezeInput): TimeMapResult<CompiledTimeMapRoot> {
  const {sourceFrame, durationFrames} = input;
  if (!Number.isSafeInteger(sourceFrame) || sourceFrame < 0 || !Number.isSafeInteger(durationFrames) || durationFrames < 1 || durationFrames > TIMELINE_TIME_MAP_LIMITS.maxOutputFrames) {
    return fail('INVALID_REQUEST', 'freeze needs a non-negative safe source frame and a bounded positive duration');
  }
  const sourceFps = timebase(input.sourceFps ?? {fpsNumerator: 30, fpsDenominator: 1});
  if (!sourceFps.ok) return sourceFps;
  const outputFps = timebase(input.outputFps ?? input.sourceFps ?? {fpsNumerator: 30, fpsDenominator: 1});
  if (!outputFps.ok) return outputFps;
  const basis: TimeMapBasis = {profile: TIMELINE_TIME_MAP_BASIS_PROFILE, sourceFps: input.sourceFps ?? {fpsNumerator: 30, fpsDenominator: 1},
    outputFps: input.outputFps ?? input.sourceFps ?? {fpsNumerator: 30, fpsDenominator: 1},
    sourceRange: {start: ratToBoundary(ratInt(sourceFrame)), end: ratToBoundary(ratInt(sourceFrame + 1))},
    speed: {kind: 'constant', rate: {numerator: 1, denominator: 1}}};
  const state: RootState = {
    kind: 'freeze', basis, sourceStart: ratInt(sourceFrame), sourceEnd: ratInt(sourceFrame + 1),
    sourceFps: sourceFps.value, outputFps: outputFps.value, framesPerIntegral: ratDiv(outputFps.value, sourceFps.value),
    rate: null, curve: null, freezeFrame: sourceFrame,
    integralOrigin: 0, integralOriginError: 0, integralTotal: 0, integralError: 0,
    lengthExact: ratInt(durationFrames), lengthNumber: durationFrames, lengthError: 0,
    floorLength: BigInt(durationFrames), ceilLength: BigInt(durationFrames), lengthIsInteger: true,
    durationFrames, frameRange: {start: sourceFrame, end: sourceFrame}, frames: new Map(),
  };
  return done(makeRoot(state));
}

// ---------------------------------------------------------------------------
// Curve compilation: log-PCHIP points plus a deterministic integration core.
// ---------------------------------------------------------------------------

interface CurveCompile {
  readonly curve: CurveState;
  readonly integralOrigin: number;
  readonly integralOriginError: number;
  readonly integralTotal: number;
  readonly integralError: number;
  readonly lengthNumber: number;
  readonly lengthError: number;
  readonly floorLength: bigint;
  readonly ceilLength: bigint;
  readonly durationFrames: number;
}
interface SimpsonEstimate {readonly value: number; readonly errorBound: number; readonly cells: number}
const SIMPSON_MAX_DEPTH = 28;
const PREFIX_TOLERANCES = Object.freeze([1e-11, 1e-13]);

/** log-speed PCHIP coefficients, same formulas as the SP0 prototype. */
function buildCurveState(points: readonly TimeMapCurvePoint[]): CurveState {
  const xs = Float64Array.from(points.map(point => point.sourceFrame));
  const ys = Float64Array.from(points.map(point => detLog(ratNumber(ratNorm(BigInt(point.rate.numerator), BigInt(point.rate.denominator))))));
  const hs = new Float64Array(xs.length - 1);
  for (let index = 0; index < hs.length; index++) hs[index] = xs[index + 1]! - xs[index]!;
  const slopes = new Float64Array(hs.length);
  for (let index = 0; index < hs.length; index++) slopes[index] = (ys[index + 1]! - ys[index]!) / hs[index]!;
  const ms = new Float64Array(xs.length);
  for (let index = 1; index < xs.length - 1; index++) {
    const left = slopes[index - 1]!, right = slopes[index]!;
    if (left * right <= 0) continue;
    const a = 2 * hs[index]! + hs[index - 1]!, b = hs[index]! + 2 * hs[index - 1]!;
    ms[index] = (a + b) / (a / left + b / right);
  }
  const endpoint = (left: number, right: number, first: number, second: number): number => {
    let value = ((2 * left + right) * first - left * second) / (left + right);
    if (value * first <= 0) value = 0;
    else if (first * second < 0 && Math.abs(value) > 3 * Math.abs(first)) value = 3 * first;
    return value;
  };
  if (slopes.length === 1) {
    ms[0] = slopes[0]!; ms[1] = slopes[0]!;
  } else {
    ms[0] = endpoint(hs[0]!, hs[1]!, slopes[0]!, slopes[1]!);
    ms[ms.length - 1] = endpoint(hs.at(-1)!, hs.at(-2)!, slopes.at(-1)!, slopes.at(-2)!);
  }
  return {points, xs, ys, hs, ms, prefix: new Float64Array(xs.length), prefixError: new Float64Array(xs.length)};
}
function curveSegment(curve: CurveState, u: number): number {
  const xs = curve.xs;
  if (u <= xs[0]!) return 0;
  if (u >= xs[xs.length - 1]!) return xs.length - 2;
  let low = 0, high = xs.length - 2;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (xs[middle]! <= u) low = middle; else high = middle - 1;
  }
  return low;
}
/** log speed p(u) at a source position. */
function curveLogRate(curve: CurveState, u: number): number {
  const index = curveSegment(curve, u);
  const h = curve.hs[index]!;
  const t = (u - curve.xs[index]!) / h;
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  return h00 * curve.ys[index]! + h10 * h * curve.ms[index]! + h01 * curve.ys[index + 1]! + h11 * h * curve.ms[index + 1]!;
}
const curveRate = (curve: CurveState, u: number): number => detExp(curveLogRate(curve, u));
function curveLogRateAtSegment(curve: CurveState, index: number, u: number): number {
  const h = curve.hs[index]!;
  const t = (u - curve.xs[index]!) / h;
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  return h00 * curve.ys[index]! + h10 * h * curve.ms[index]! + h01 * curve.ys[index + 1]! + h11 * h * curve.ms[index + 1]!;
}
const curveRateAtSegment = (curve: CurveState, index: number, u: number): number => detExp(curveLogRateAtSegment(curve, index, u));
const curveIntegrand = (curve: CurveState, u: number): number => detExp(-curveLogRate(curve, u));
function simpson(fa: number, fm: number, fb: number, width: number): number { return width / 6 * (fa + 4 * fm + fb); }
/** Adaptive Simpson on one PCHIP segment cell. The accepted result carries the
 * standard 15x error estimate and a conservative rounding allowance. */
function integrateCurveCell(curve: CurveState, segIndex: number, a: number, b: number, tolerance: number, cellBudget: number): SimpsonEstimate | null {
  const xs = curve.xs, hs = curve.hs;
  const evaluate = (u: number): number => curveIntegrand(curve, u);
  const start = Math.max(a, segIndex === 0 ? xs[0]! : xs[segIndex]!);
  const end = Math.min(b, xs[segIndex + 1]!);
  void hs;
  if (!(end > start)) return {value: 0, errorBound: 0, cells: 0};
  const fa = evaluate(start), fb = evaluate(end);
  const middle = (start + end) / 2;
  const fm = evaluate(middle);
  const whole = simpson(fa, fm, fb, end - start);
  let cells = 1;
  if (cells > cellBudget) return null;
  let value = 0, errorBound = 0;
  const stack: {a: number; b: number; fa: number; fm: number; fb: number; whole: number; tolerance: number; depth: number}[] =
    [{a: start, b: end, fa, fm, fb, whole, tolerance, depth: 0}];
  while (stack.length > 0) {
    const item = stack.pop()!;
    const middlePoint = (item.a + item.b) / 2;
    const leftMiddle = (item.a + middlePoint) / 2, rightMiddle = (middlePoint + item.b) / 2;
    const fl = evaluate(leftMiddle), fr = evaluate(rightMiddle);
    const left = simpson(item.fa, fl, item.fm, middlePoint - item.a);
    const right = simpson(item.fm, fr, item.fb, item.b - middlePoint);
    const delta = left + right - item.whole;
    const width = item.b - item.a;
    if (Math.abs(delta) <= 15 * item.tolerance || item.depth >= SIMPSON_MAX_DEPTH) {
      value += left + right + delta / 15;
      errorBound += Math.abs(delta) / 15 + 8 * EPSILON * (Math.abs(left + right) + width);
      cells += 2;
      if (cells > cellBudget) return null;
    } else {
      const childTolerance = item.tolerance / 2;
      stack.push({a: item.a, b: middlePoint, fa: item.fa, fm: fl, fb: item.fm, whole: left, tolerance: childTolerance, depth: item.depth + 1});
      stack.push({a: middlePoint, b: item.b, fa: item.fm, fm: fr, fb: item.fb, whole: right, tolerance: childTolerance, depth: item.depth + 1});
    }
  }
  return {value, errorBound, cells};
}
/** Integrates exp(-p(u)) over [from,to], splitting at control points. */
function integrateCurve(curve: CurveState, from: number, to: number, tolerance: number, cellBudget: number): SimpsonEstimate | null {
  if (to <= from) return {value: 0, errorBound: 0, cells: 0};
  let value = 0, errorBound = 0, cells = 0;
  let cursor = from;
  while (cursor < to) {
    const segIndex = curveSegment(curve, cursor);
    const stop = Math.min(to, curve.xs[segIndex + 1]!);
    const estimate = integrateCurveCell(curve, segIndex, cursor, stop, tolerance, cellBudget - cells);
    if (!estimate) return null;
    value += estimate.value; errorBound += estimate.errorBound; cells += estimate.cells;
    if (stop <= cursor) break;
    cursor = stop;
  }
  return {value, errorBound, cells};
}
function compileCurve(inputPoints: readonly TimeMapCurvePoint[], sourceStart: Rat, sourceEnd: Rat, framesPerIntegral: Rat, options: TimeMapCompileOptions): TimeMapResult<CurveCompile> {
  if (!Array.isArray(inputPoints) || inputPoints.length < 2) return fail('INVALID_CURVE_POINTS', 'a curve needs at least two control points');
  if (inputPoints.length > TIMELINE_TIME_MAP_LIMITS.maxCurvePoints) return fail('POINT_LIMIT', 'a curve supports at most 32 control points');
  for (const [index, point] of inputPoints.entries()) {
    if (!Number.isSafeInteger(point.sourceFrame) || point.sourceFrame < 0) return fail('INVALID_CURVE_POINTS', 'control point source frames must be non-negative safe integers');
    if (index > 0 && point.sourceFrame <= inputPoints[index - 1]!.sourceFrame) return fail('INVALID_CURVE_POINTS', 'control point source frames must be strictly increasing');
    const rate = speedRate(point.rate);
    if (!rate.ok) return rate;
  }
  if (ratCmp(ratInt(inputPoints[0]!.sourceFrame), sourceStart) > 0 || ratCmp(ratInt(inputPoints[inputPoints.length - 1]!.sourceFrame), sourceEnd) < 0) {
    return fail('INVALID_CURVE_POINTS', 'control points must cover both ends of the source range');
  }
  const curve = buildCurveState(inputPoints);
  const budget = options.maxCurveCells ?? TIMELINE_TIME_MAP_LIMITS.maxCurveCells;
  const framesPerIntegralValue = numberFromRat(framesPerIntegral);
  let prefix: Float64Array | null = null, prefixError: Float64Array | null = null;
  for (const tolerance of PREFIX_TOLERANCES) {
    const nextPrefix = new Float64Array(curve.xs.length);
    const nextError = new Float64Array(curve.xs.length);
    let cells = 0;
    let failed = false;
    for (let index = 0; index < curve.hs.length; index++) {
      const estimate = integrateCurve(curve, curve.xs[index]!, curve.xs[index + 1]!, tolerance, budget - cells);
      if (!estimate) {failed = true; break;}
      cells += estimate.cells;
      nextPrefix[index + 1] = nextPrefix[index]! + estimate.value;
      nextError[index + 1] = nextError[index]! + estimate.errorBound;
    }
    if (failed) return fail('NUMERIC_BUDGET_EXCEEDED', 'curve compilation exceeded the configured cell budget');
    prefix = nextPrefix; prefixError = nextError;
    // Resolve the root length under this precision. A boundary that stays
    // undecidable after the last level is an explicit compile failure.
    const startEstimate = integrateCurve(curve, curve.xs[0]!, numberFromRat(sourceStart), tolerance, Math.max(1, budget - cells));
    const endEstimate = integrateCurve(curve, numberFromRat(sourceEnd), curve.xs[curve.xs.length - 1]!, tolerance, Math.max(1, budget - cells));
    if (!startEstimate || !endEstimate) return fail('NUMERIC_BUDGET_EXCEEDED', 'curve compilation exceeded the configured cell budget');
    const integralOrigin = startEstimate.value;
    const integralOriginError = startEstimate.errorBound;
    // prefix[last] is C at the curve domain end; the basis end may sit before
    // it, so the interval C(sourceStart)..C(sourceEnd) subtracts that tail.
    const endAtDomain = prefix[curve.xs.length - 1]! - endEstimate.value;
    const integralTotal = endAtDomain - integralOrigin;
    const integralError = prefixError[curve.xs.length - 1]! + endEstimate.errorBound + integralOriginError;
    const lengthNumber = integralTotal * framesPerIntegralValue;
    const lengthError = integralError * framesPerIntegralValue + 8 * EPSILON * (Math.abs(lengthNumber) + 1);
    if (!(lengthNumber > 0) || !Number.isFinite(lengthNumber)) return fail('INVALID_SOURCE_RANGE', 'curve duration must be positive');
    const lowFloor = Math.floor(lengthNumber - lengthError), highFloor = Math.floor(lengthNumber + lengthError);
    if (lowFloor !== highFloor) {
      if (tolerance !== PREFIX_TOLERANCES[PREFIX_TOLERANCES.length - 1]) continue;
      return fail('UNRESOLVED_BOUNDARY', 'curve root length intersects an integer frame boundary under the refinement budget');
    }
    const durationFrames = lowFloor + 1;
    if (durationFrames > TIMELINE_TIME_MAP_LIMITS.maxOutputFrames) return fail('OUTPUT_FRAME_LIMIT', 'compiled duration exceeds the output frame limit');
    curve.prefix.set(prefix);
    curve.prefixError.set(prefixError);
    return done({curve, integralOrigin, integralOriginError,
      integralTotal, integralError,
      lengthNumber, lengthError, floorLength: BigInt(lowFloor), ceilLength: BigInt(highFloor + 1), durationFrames});
  }
  return fail('NUMERIC_BUDGET_EXCEEDED', 'curve compilation did not converge');
}

// ---------------------------------------------------------------------------
// View algebra. Boundaries are 0|L plus integer output-frame offsets; direction
// flips swap the direction of the same visible clock interval and reset the
// window, so flipping twice restores the exact original sampling.
// ---------------------------------------------------------------------------

function timeValueNumber(state: RootState, value: RootTimeValue): number { return timeNumber(state, value); }
function timeValueLess(state: RootState, left: RootTimeValue, right: RootTimeValue): boolean {
  if (state.lengthExact !== null) {
    const leftExact = timeExact(state, left), rightExact = timeExact(state, right);
    if (leftExact && rightExact) return ratCmp(leftExact, rightExact) < 0;
  }
  return timeValueNumber(state, left) < timeValueNumber(state, right);
}
/** Visible clock interval of a window, clamped to the view bounds. */
function planClockInterval(state: RootState, plan: {
  loTime: TimeMapViewBoundary; hiTime: TimeMapViewBoundary; direction: 'forward' | 'reverse'; outputWindow: TimeMapOutputWindow;
}): {readonly lo: RootTimeValue; readonly hi: RootTimeValue} {
  const {fromFrame, toFrame} = plan.outputWindow;
  if (plan.direction === 'forward') {
    const base = boundaryTimeValue(plan.loTime), hiBound = boundaryTimeValue(plan.hiTime);
    const lo = timeShift(base, fromFrame);
    let hi = timeShift(base, toFrame);
    if (!timeValueLess(state, hi, hiBound)) hi = hiBound;
    return {lo, hi};
  }
  const base = boundaryTimeValue(plan.hiTime), loBound = boundaryTimeValue(plan.loTime);
  const hi = timeShift(base, -fromFrame);
  let lo = timeShift(base, -toFrame);
  if (timeValueLess(state, lo, loBound)) lo = loBound;
  return {lo, hi};
}

/** Initial full-basis view. `reverse` keeps the same clock interval and flips
 * only the traversal direction. */
export function initialTimeMap(root: CompiledTimeMapRoot, direction: 'forward' | 'reverse' = 'forward'): CompiledTimeMap {
  const state = rootState(root);
  return makePlan(root, {loTime: {anchor: 'start', offsetOutputFrames: 0}, hiTime: {anchor: 'end', offsetOutputFrames: 0},
    direction, outputWindow: {fromFrame: 0, toFrame: state.durationFrames}});
}

/** Reopen a persisted view after checking it against its compiled root. */
export function restoreTimeMap(root: CompiledTimeMapRoot, view: Omit<PlanState, 'root'>): TimeMapResult<CompiledTimeMap> {
  const state = rootState(root);
  const {loTime, hiTime, outputWindow: {fromFrame, toFrame}} = view;
  const limit = state.durationFrames;
  if (![loTime.offsetOutputFrames, hiTime.offsetOutputFrames].every(value => Number.isSafeInteger(value) && Math.abs(value) <= limit)
      || !Number.isSafeInteger(fromFrame) || !Number.isSafeInteger(toFrame)
      || fromFrame < 0 || fromFrame >= toFrame || toFrame > limit) {
    return fail('INVALID_WINDOW', 'view and output window must use bounded integer offsets');
  }
  const lo = boundaryTimeValue(loTime), hi = boundaryTimeValue(hiTime);
  if (timeValueLess(state, lo, clockTime(0)) || timeValueLess(state, {kind: 'rootEnd', offset: 0}, hi)
      || !timeValueLess(state, timeShift(lo, toFrame - 1), hi)) {
    return fail('INVALID_WINDOW', 'view or output window leaves its motion interval');
  }
  return done(makePlan(root, view));
}

/** The edit domain includes the full half-open output window, including motion
 * after the last sampled frame start. Endpoints already in the basis stay exact. */
export function timeMapSourceRangeForEdit(plan: CompiledTimeMap): TimeMapResult<TimeMapSourceRange> {
  const state = rootState(plan.root);
  const interval = planClockInterval(state, planState(plan));
  function boundary(time: RootTimeValue, original: TimeMapSourceBoundary): TimeMapResult<TimeMapSourceBoundary> {
    if ((time.kind === 'clock' && time.frames === 0) || (time.kind === 'rootEnd' && time.offset === 0)) {
      return done(original);
    }
    const position = invertAtTime(state, time, CURVE_REFINEMENT_TOLERANCES.length - 1);
    if (!position.ok) return position;
    if (position.value.kind === 'exact') {
      const {numerator, denominator} = position.value;
      return done({kind: 'rational', numerator, denominator});
    }
    const projected = projectSourceBoundaryToQ64(position.value);
    return projected.ok ? done(projected.value.boundary) : projected;
  }
  const start = boundary(interval.lo, plan.root.sourceRange.start);
  if (!start.ok) return start;
  const end = boundary(interval.hi, plan.root.sourceRange.end);
  return end.ok ? done({start: start.value, end: end.value}) : end;
}

/** PCHIP is shape-preserving, so only the visible ends and interior control
 * points can determine the minimum rate. */
export function timeMapHasSlowMotion(plan: CompiledTimeMap): TimeMapResult<boolean> {
  const state = rootState(plan.root);
  if (state.rate) return done(ratCmp(state.rate, ratInt(1n)) < 0);
  const curve = state.curve;
  if (!curve) return done(false);
  const interval = planClockInterval(state, planState(plan));
  const start = invertAtTime(state, interval.lo, 0);
  if (!start.ok) return start;
  const end = invertAtTime(state, interval.hi, 0);
  if (!end.ok) return end;
  const toFrame = (position: ContinuousSourcePosition) => position.kind === 'numeric'
    ? position.value : Number(position.numerator) / Number(position.denominator);
  const lo = toFrame(start.value), hi = toFrame(end.value);
  return done(curveRate(curve, lo) < 1 || curveRate(curve, hi) < 1 ||
    state.basis.speed.kind === 'curve' && state.basis.speed.points.some(point =>
      point.sourceFrame > lo && point.sourceFrame < hi && point.rate.numerator < point.rate.denominator));
}

/** Flips the traversal direction over the same visible clock interval. The
 * output length and the tail rule stay put; nothing is re-rounded. */
export function reverseTimeMap(plan: CompiledTimeMap): CompiledTimeMap {
  const state = planState(plan);
  const interval = planClockInterval(rootState(plan.root), state);
  const root = rootState(plan.root);
  return makePlan(plan.root, {loTime: canonicalTimeBoundary(root, interval.lo), hiTime: canonicalTimeBoundary(root, interval.hi),
    direction: state.direction === 'forward' ? 'reverse' : 'forward', outputWindow: {fromFrame: 0, toFrame: plan.durationFrames}});
}

/** Splits a view window at an output frame offset. Both halves keep the same
 * immutable root, so phases stay exact and joining them back is the identity. */
export function splitTimeMap(plan: CompiledTimeMap, atOutputFrameOffset: number): TimeMapResult<{readonly left: CompiledTimeMap; readonly right: CompiledTimeMap}> {
  const state = planState(plan);
  const duration = plan.durationFrames;
  if (!Number.isSafeInteger(atOutputFrameOffset) || atOutputFrameOffset <= 0 || atOutputFrameOffset >= duration) {
    return fail('INVALID_WINDOW', 'split offset must be an integer inside the window');
  }
  const {fromFrame: u, toFrame: v} = state.outputWindow;
  return done({
    left: makePlan(plan.root, {loTime: state.loTime, hiTime: state.hiTime, direction: state.direction, outputWindow: {fromFrame: u, toFrame: u + atOutputFrameOffset}}),
    right: makePlan(plan.root, {loTime: state.loTime, hiTime: state.hiTime, direction: state.direction, outputWindow: {fromFrame: u + atOutputFrameOffset, toFrame: v}}),
  });
}

/** Trims to a sub-window of the current output window. */
export function trimTimeMap(plan: CompiledTimeMap, fromFrame: number, toFrame: number): TimeMapResult<CompiledTimeMap> {
  const state = planState(plan);
  if (!Number.isSafeInteger(fromFrame) || !Number.isSafeInteger(toFrame) || fromFrame < 0 || fromFrame >= toFrame || toFrame > plan.durationFrames) {
    return fail('INVALID_WINDOW', 'trim must select a non-empty integer window inside the current window');
  }
  const {fromFrame: u} = state.outputWindow;
  return done(makePlan(plan.root, {loTime: state.loTime, hiTime: state.hiTime, direction: state.direction, outputWindow: {fromFrame: u + fromFrame, toFrame: u + toFrame}}));
}

/** Strict no-op detection for a same-value speed setting write. */
export function timeMapSettingEquals(left: TimeMapBasis, right: TimeMapBasis): boolean {
  return rootHash(left) === rootHash(right);
}

// ---------------------------------------------------------------------------
// Frame vectors. Constant maps use exact rational stepping; curve maps march the
// inverse ODE du/dC = r(u) with step-doubling error control and refresh from the
// exact integral at control points.
// ---------------------------------------------------------------------------

const CURVE_REFINEMENT_TOLERANCES = Object.freeze([1e-10, 1e-11, 1e-12]);
const LOCAL_CELL_BUDGET = 65_536;
const MARCH_REFRESH_INTERVAL = 2048;
const clampFrame = (state: RootState, frame: number): number => frame < state.frameRange.start ? state.frameRange.start : frame > state.frameRange.end ? state.frameRange.end : frame;

function rootFrames(state: RootState, direction: 'forward' | 'reverse'): TimeMapResult<Int32Array> {
  const cached = state.frames.get(direction);
  if (cached) return done(cached);
  let frames: Int32Array;
  if (state.kind === 'freeze') {
    frames = new Int32Array(state.durationFrames).fill(state.freezeFrame!);
  } else if (state.rate !== null) {
    // A curve whose every control rate is identical is exactly a constant map.
    frames = constantFrames(state, direction);
  } else {
    const marched = marchCurveFrames(state, direction);
    if (!marched.ok) return marched;
    frames = marched.value;
  }
  state.frames.set(direction, frames);
  return done(frames);
}
function constantFrames(state: RootState, direction: 'forward' | 'reverse'): Int32Array {
  const frames = new Int32Array(state.durationFrames);
  const step = ratDiv(state.rate!, state.framesPerIntegral);
  let cursor = direction === 'forward' ? state.sourceStart : state.sourceEnd;
  for (let index = 0; index < frames.length; index++) {
    frames[index] = clampFrame(state, Number(direction === 'forward' ? ratFloor(cursor) : ratCeil(cursor) - 1n));
    cursor = direction === 'forward' ? ratAdd(cursor, step) : ratSub(cursor, step);
  }
  return frames;
}
type MarchStep = {readonly ok: true; readonly value: {readonly u: number; readonly error: number}} | {readonly ok: false}
/** Marches deltaC in integral space, subdividing until step-doubling reports a
 * small local error. The returned position covers the whole requested deltaC. */
function marchCurveStep(curve: CurveState, segment: number, u: number, deltaC: number): MarchStep {
  let position = u;
  let remaining = deltaC;
  let accumulated = 0;
  let guard = 0;
  while (Math.abs(remaining) > 0) {
    if (++guard > 64) return {ok: false};
    let step = remaining;
    let accepted = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const one = rk4(curve, segment, position, step);
      const two = rk4(curve, segment, rk4(curve, segment, position, step / 2), step / 2);
      const error = Math.abs(one - two);
      if (error <= 1e-9 * Math.max(1, Math.abs(step)) + 1e-12) {
        position = two;
        accumulated += error * 16 + 8 * EPSILON * (Math.abs(two) + 1);
        remaining -= step;
        accepted = true;
        break;
      }
      step /= 2;
    }
    if (!accepted) return {ok: false};
  }
  return {ok: true, value: {u: position, error: accumulated}};
}
function rk4(curve: CurveState, segment: number, u: number, deltaC: number): number {
  const k1 = curveRateAtSegment(curve, segment, u);
  const k2 = curveRateAtSegment(curve, segment, u + deltaC * k1 / 2);
  const k3 = curveRateAtSegment(curve, segment, u + deltaC * k2 / 2);
  const k4 = curveRateAtSegment(curve, segment, u + deltaC * k3);
  return u + deltaC * (k1 + 2 * k2 + 2 * k3 + k4) / 6;
}
/** Inverts the forward integral clock at an absolute integral value. */
function invertCurve(state: RootState, targetIntegral: number, targetError: number, level: number): TimeMapResult<{readonly value: number; readonly errorBound: number}> {
  const curve = state.curve!;
  const tolerance = CURVE_REFINEMENT_TOLERANCES[Math.min(level, CURVE_REFINEMENT_TOLERANCES.length - 1)]!;
  const startNumber = numberFromRat(state.sourceStart), endNumber = numberFromRat(state.sourceEnd);
  if (targetIntegral <= state.integralOrigin + targetError) {
    return done({value: startNumber, errorBound: Math.max(0, state.integralOrigin - targetIntegral) / Math.min(1, curveRate(curve, startNumber))});
  }
  const endAbsolute = state.integralOrigin + state.integralTotal;
  if (targetIntegral >= endAbsolute - targetError) {
    return done({value: endNumber, errorBound: Math.max(0, targetIntegral - endAbsolute) / Math.min(1, curveRate(curve, endNumber))});
  }
  let low = 0, high = curve.xs.length - 2;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (curve.prefix[middle]! <= targetIntegral) low = middle; else high = middle - 1;
  }
  const seg = low;
  const segmentStart = curve.xs[seg]!, segmentEnd = curve.xs[seg + 1]!;
  const spanIntegral = curve.prefix[seg + 1]! - curve.prefix[seg]!;
  let u = spanIntegral > 0 ? segmentStart + (targetIntegral - curve.prefix[seg]!) * (segmentEnd - segmentStart) / spanIntegral : segmentStart;
  u = clampNumber(u, segmentStart, segmentEnd);
  let lowerSource = segmentStart, upperSource = segmentEnd;
  for (let iteration = 0; iteration < 64; iteration++) {
    const estimate = integrateCurve(curve, segmentStart, u, tolerance, LOCAL_CELL_BUDGET);
    if (!estimate) return fail('NUMERIC_BUDGET_EXCEEDED', 'curve inverse exceeded the local integration budget');
    const integral = curve.prefix[seg]! + estimate.value;
    const residual = integral - targetIntegral;
    const error = curve.prefixError[seg]! + estimate.errorBound + targetError + 8 * EPSILON * (Math.abs(integral) + 1);
    const slope = curveIntegrand(curve, u);
    if (Math.abs(residual) <= error) return done({value: u, errorBound: (error + Math.abs(residual)) / Math.max(0.1, slope) + 8 * EPSILON * (Math.abs(u) + 1)});
    if (!(slope > 0) || !Number.isFinite(slope)) break;
    if (residual > 0) upperSource = u; else lowerSource = u;
    // A steep first or last segment can send an unconstrained Newton step
    // past the domain even when the target is well inside that segment.
    const newton = u - residual / slope;
    const next = newton > lowerSource && newton < upperSource ? newton : lowerSource + (upperSource - lowerSource) / 2;
    if (next === u) break;
    u = next;
  }
  return fail('UNRESOLVED_BOUNDARY', 'curve inverse did not converge within its source bracket');
}
/** Decides the source frame for a continuous position with the direction rule. */
function decideFramePosition(state: RootState, u: number, error: number, direction: 'forward' | 'reverse',
  precise: (level: number) => TimeMapResult<{readonly value: number; readonly errorBound: number}>): TimeMapResult<number> {
  let value = u, bound = error;
  for (let level = 0; level < CURVE_REFINEMENT_TOLERANCES.length; level++) {
    if (direction === 'forward') {
      const lower = Math.floor(value - bound), upper = Math.floor(value + bound);
      if (lower === upper) return done(clampFrame(state, lower));
    } else {
      const lower = Math.ceil(value - bound), upper = Math.ceil(value + bound);
      if (lower === upper) return done(clampFrame(state, lower - 1));
    }
    if (level === CURVE_REFINEMENT_TOLERANCES.length - 1) break;
    const next = precise(level + 1);
    if (!next.ok) return next;
    value = next.value.value; bound = next.value.errorBound;
  }
  // Versioned tie rule: if the best estimate still straddles one integer inside
  // the documented error bound, the integer is treated as reached (forward) or
  // passed (reverse). The rule is part of the map profile; it only covers the
  // final sub-2^-30 band and never changes a decided frame.
  return done(clampFrame(state, direction === 'forward' ? Math.floor(value) : Math.ceil(value) - 1));
}
function marchCurveFrames(state: RootState, direction: 'forward' | 'reverse'): TimeMapResult<Int32Array> {
  const curve = state.curve!;
  const integralPerFrame = 1 / numberFromRat(state.framesPerIntegral);
  const frames = new Int32Array(state.durationFrames);
  const endAbsolute = state.integralOrigin + state.integralTotal;
  const forward = direction === 'forward';
  if (forward) {
    frames[0] = clampFrame(state, Number(ratFloor(state.sourceStart)));
  } else {
    frames[0] = clampFrame(state, Number(ratCeil(state.sourceEnd)) - 1);
  }
  let u = forward ? numberFromRat(state.sourceStart) : numberFromRat(state.sourceEnd);
  let seg = curveSegment(curve, u);
  let cAtU = forward ? state.integralOrigin : endAbsolute;
  let accumulatedError = forward ? state.integralOriginError : state.integralError + state.integralOriginError;
  for (let index = 1; index < frames.length; index++) {
    const target = forward ? state.integralOrigin + index * integralPerFrame : endAbsolute - index * integralPerFrame;
    const targetError = 8 * EPSILON * (Math.abs(target) + 1) + index * 4 * EPSILON * Math.abs(integralPerFrame);
    let guard = 0;
    while (true) {
      if (++guard > 8) return fail('NUMERIC_BUDGET_EXCEEDED', 'curve marching did not converge');
      const boundaryIndex = forward ? seg + 1 : seg;
      if (forward ? seg < curve.xs.length - 1 : seg > 0) {
        const boundaryIntegral = curve.prefix[boundaryIndex]!;
        const boundaryError = curve.prefixError[boundaryIndex]!;
        const remaining = forward ? target - cAtU : cAtU - target;
        const available = forward ? boundaryIntegral - cAtU : cAtU - boundaryIntegral;
        if (available <= 0 || remaining > available + boundaryError + accumulatedError + targetError) {
          u = curve.xs[boundaryIndex]!;
          seg = forward ? seg + 1 : seg - 1;
          cAtU = boundaryIntegral;
          accumulatedError = boundaryError;
          continue;
        }
        if (remaining > available - boundaryError - accumulatedError - targetError) {
          const precise = invertCurve(state, target, targetError, CURVE_REFINEMENT_TOLERANCES.length - 1);
          if (!precise.ok) return precise;
          u = precise.value.value; cAtU = target; accumulatedError = precise.value.errorBound;
          seg = curveSegment(curve, u);
          break;
        }
      }
      const deltaC = target - cAtU;
      if (Math.abs(deltaC) <= targetError) break;
      const step = marchCurveStep(curve, seg, u, deltaC);
      if (!step.ok) return fail('NUMERIC_BUDGET_EXCEEDED', 'curve marching step did not converge');
      u = clampNumber(step.value.u, numberFromRat(state.sourceStart), numberFromRat(state.sourceEnd));
      cAtU = target;
      accumulatedError += step.value.error;
      break;
    }
    if (index % MARCH_REFRESH_INTERVAL === 0) {
      const precise = invertCurve(state, target, targetError, CURVE_REFINEMENT_TOLERANCES.length - 1);
      if (!precise.ok) return precise;
      u = precise.value.value; cAtU = target; accumulatedError = precise.value.errorBound;
      seg = curveSegment(curve, u);
    }
    const decided = decideFramePosition(state, u, accumulatedError + targetError * Math.max(1, curveRate(curve, u)), direction,
      level => invertCurve(state, target, targetError, level));
    if (!decided.ok) return decided;
    frames[index] = decided.value;
  }
  return done(frames);
}

// ---------------------------------------------------------------------------
// Time inversion helpers for samples, windows and tail rules.
// ---------------------------------------------------------------------------

function invertAtTime(state: RootState, value: RootTimeValue, level: number): TimeMapResult<ContinuousSourcePosition> {
  if (state.kind === 'freeze') return done({kind: 'exact', numerator: String(state.freezeFrame!), denominator: '1'});
  const endpoint = value.kind === 'clock' && value.frames === 0 ? state.sourceStart
    : value.kind === 'rootEnd' && value.offset === 0 ? state.sourceEnd : null;
  if (endpoint) return done({kind: 'exact', numerator: String(endpoint.n), denominator: String(endpoint.d)});
  const time = timeNumber(state, value);
  const timeError = timeUncertainty(state, value);
  if (state.lengthExact !== null && state.rate !== null) {
    void level;
    const exact = timeExact(state, value)!;
    const source = ratAdd(state.sourceStart, ratMul(exact, ratDiv(state.rate!, state.framesPerIntegral)));
    const clamped = ratCmp(source, state.sourceStart) < 0 ? state.sourceStart : ratCmp(source, state.sourceEnd) > 0 ? state.sourceEnd : source;
    return done({kind: 'exact', numerator: String(clamped.n), denominator: String(clamped.d)});
  }
  const framesPerIntegralValue = numberFromRat(state.framesPerIntegral);
  const targetIntegral = state.integralOrigin + time / framesPerIntegralValue;
  const targetError = timeError / framesPerIntegralValue + 4 * EPSILON * (Math.abs(targetIntegral) + 1);
  const inverted = invertCurve(state, targetIntegral, targetError, level);
  if (!inverted.ok) return inverted;
  const startNumber = numberFromRat(state.sourceStart), endNumber = numberFromRat(state.sourceEnd);
  return done({kind: 'numeric', value: clampNumber(inverted.value.value, startNumber, endNumber), errorBound: inverted.value.errorBound});
}
function resolvePositionInteger(state: RootState, value: RootTimeValue, mode: 'floor' | 'ceil'): TimeMapResult<number> {
  let lastValue = 0;
  for (let level = 0; level < CURVE_REFINEMENT_TOLERANCES.length; level++) {
    const inverted = invertAtTime(state, value, level);
    if (!inverted.ok) return inverted;
    const position = inverted.value;
    if (position.kind === 'exact') {
      const rat = ratNorm(BigInt(position.numerator), BigInt(position.denominator));
      return done(Number((mode === 'floor' ? ratFloor : ratCeil)(rat)));
    }
    const low = mode === 'floor' ? Math.floor(position.value - position.errorBound) : Math.ceil(position.value - position.errorBound);
    const high = mode === 'floor' ? Math.floor(position.value + position.errorBound) : Math.ceil(position.value + position.errorBound);
    if (low === high) return done(low);
    lastValue = position.value;
    if (level === CURVE_REFINEMENT_TOLERANCES.length - 1) break;
  }
  return done(mode === 'floor' ? Math.floor(lastValue) : Math.ceil(lastValue));
}
function planTimeValue(state: PlanState, outputOffset: number): RootTimeValue {
  const global = state.outputWindow.fromFrame + outputOffset;
  return timeShift(boundaryTimeValue(state.direction === 'forward' ? state.loTime : state.hiTime), state.direction === 'forward' ? global : -global);
}
// ---------------------------------------------------------------------------
// Public describe/compile surface for plans.
// ---------------------------------------------------------------------------

export interface TimeMapRootInfo {
  readonly profile: typeof TIMELINE_TIME_MAP_PROFILE;
  readonly interpolation: 'constant' | typeof TIMELINE_TIME_MAP_INTERPOLATION | 'freeze';
  readonly mapHash: string;
  readonly durationFrames: number;
  readonly sourceRange: TimeMapSourceRange;
  readonly sourceFps: TimeMapTimebase;
  readonly outputFps: TimeMapTimebase;
  readonly frameRange: {readonly start: number; readonly end: number};
  readonly rootLength: {readonly kind: 'exact'; readonly numerator: string; readonly denominator: string}
    | {readonly kind: 'numeric'; readonly value: number; readonly errorBound: number};
}
export function timeMapRootInfo(root: CompiledTimeMapRoot): TimeMapRootInfo {
  const state = rootState(root);
  return {profile: root.profile, interpolation: root.interpolation, mapHash: root.mapHash, durationFrames: state.durationFrames,
    sourceRange: root.sourceRange, sourceFps: root.sourceFps, outputFps: root.outputFps,
    frameRange: {...state.frameRange},
    rootLength: state.lengthExact ? {kind: 'exact', numerator: String(state.lengthExact.n), denominator: String(state.lengthExact.d)}
      : {kind: 'numeric', value: state.lengthNumber, errorBound: state.lengthError}};
}
export interface TimeMapPlanInfo {
  readonly direction: 'forward' | 'reverse';
  readonly durationFrames: number;
  readonly outputWindow: TimeMapOutputWindow;
  readonly loTime: TimeMapViewBoundary;
  readonly hiTime: TimeMapViewBoundary;
  readonly rootDurationFrames: number;
  readonly mapHash: string;
  readonly visibleSourceRange: TimeMapVisibleSourceRange;
  readonly sourceWindow: TimeMapSourceWindow;
}
/** Entire integer source frame vector for one direction of the root. */
export function timeMapRootFrames(root: CompiledTimeMapRoot, direction: 'forward' | 'reverse' = 'forward'): TimeMapResult<Int32Array> {
  return rootFrames(rootState(root), direction);
}
/** Output frame vector of a plan, derived from the same root vectors. */
export function timeMapPlanFrames(plan: CompiledTimeMap): TimeMapResult<Int32Array> {
  const planInfo = planState(plan), state = rootState(plan.root);
  const frames = new Int32Array(plan.durationFrames);
  const first = planTimeValue(planInfo, 0);
  const needed: 'forward' | 'reverse' = first.kind === 'clock' ? 'forward' : 'reverse';
  // A flipped sub-window can traverse the other direction on this grid.
  // Only the grid matching the traversal uses the cached floor/ceil vector.
  const vector = needed === plan.direction ? rootFrames(state, needed) : null;
  if (vector && !vector.ok) return vector;
  for (let index = 0; index < frames.length; index++) {
    const time = planTimeValue(planInfo, index);
    const vectorIndex = time.kind === 'clock' ? time.frames : -time.offset;
    if (time.kind !== first.kind || !Number.isSafeInteger(vectorIndex)) {
      return fail('INVALID_WINDOW', 'view window leaves the compiled frame vector');
    }
    if (vector && vectorIndex >= 0 && vectorIndex < vector.value.length) {
      frames[index] = vector.value[vectorIndex]!;
    } else {
      const forward = plan.direction === 'forward';
      const sample = resolvePositionInteger(state, time, forward ? 'floor' : 'ceil');
      if (!sample.ok) return sample;
      frames[index] = clampFrame(state, forward ? sample.value : sample.value - 1);
    }
  }
  return done(frames);
}
/** The first and last displayed source positions and the decode sample window.
 * Persisted clip capacity uses the full motion interval, including the time
 * after the last displayed frame start. */
export function timeMapVisibleSourceRange(plan: CompiledTimeMap): TimeMapResult<TimeMapVisibleSourceRange> {
  const state = rootState(plan.root), planInfo = planState(plan);
  if (state.freezeFrame !== null) {
    const position = {kind: 'exact' as const, numerator: String(state.freezeFrame), denominator: '1'};
    return done({lo: position, hi: position, sourceWindow: {startFrame: state.freezeFrame, endFrame: state.freezeFrame + 1}});
  }
  const first = planTimeValue(planInfo, 0), last = planTimeValue(planInfo, plan.durationFrames - 1);
  const {lo, hi} = timeValueLess(state, last, first) ? {lo: last, hi: first} : {lo: first, hi: last};
  const forward = plan.direction === 'forward';
  const startBoundary = resolvePositionInteger(state, lo, forward ? 'floor' : 'ceil');
  if (!startBoundary.ok) return startBoundary;
  const endBoundary = resolvePositionInteger(state, hi, forward ? 'floor' : 'ceil');
  if (!endBoundary.ok) return endBoundary;
  const low = invertAtTime(state, lo, 0);
  if (!low.ok) return low;
  const high = invertAtTime(state, hi, 0);
  if (!high.ok) return high;
  const startFrame = Math.max(state.frameRange.start, forward ? startBoundary.value : startBoundary.value - 1);
  const endFrame = Math.min(state.frameRange.end + 1, forward ? endBoundary.value + 1 : endBoundary.value);
  if (endFrame <= startFrame) return fail('INVALID_WINDOW', 'visible source envelope is empty');
  return done({lo: low.value, hi: high.value, sourceWindow: {startFrame, endFrame}});
}
export function timeMapSourceWindowForOutput(plan: CompiledTimeMap, options: {contextFrames?: number} = {}): TimeMapResult<TimeMapSourceWindow> {
  const state = rootState(plan.root);
  const visible = timeMapVisibleSourceRange(plan);
  if (!visible.ok) return visible;
  const context = options.contextFrames === undefined ? 0 : Math.max(0, Math.trunc(options.contextFrames));
  const startFrame = Math.max(state.frameRange.start, visible.value.sourceWindow.startFrame - context);
  const endFrame = Math.min(state.frameRange.end + 1, visible.value.sourceWindow.endFrame + context);
  return done({startFrame, endFrame, frameCount: endFrame - startFrame, direction: plan.direction,
    outputFromFrame: 0, outputToFrame: plan.durationFrames});
}
export function timeMapPlanInfo(plan: CompiledTimeMap): TimeMapResult<TimeMapPlanInfo> {
  const state = planState(plan), root = rootState(plan.root);
  const visible = timeMapVisibleSourceRange(plan);
  if (!visible.ok) return visible;
  const window = timeMapSourceWindowForOutput(plan);
  if (!window.ok) return window;
  return done({direction: state.direction, durationFrames: plan.durationFrames, outputWindow: plan.outputWindow,
    loTime: state.loTime, hiTime: state.hiTime, rootDurationFrames: root.durationFrames, mapHash: plan.root.mapHash,
    visibleSourceRange: visible.value, sourceWindow: window.value});
}
/** Continuous source position and the selected frame at an output frame start. */
export function timeMapSourceAtOutputFrame(plan: CompiledTimeMap, outputFrame: number): TimeMapResult<TimeMapSourceSample> {
  const planInfo = planState(plan), state = rootState(plan.root);
  if (!Number.isSafeInteger(outputFrame) || outputFrame < 0 || outputFrame >= plan.durationFrames) return fail('INVALID_WINDOW', 'output frame outside the window');
  const frames = timeMapPlanFrames(plan);
  if (!frames.ok) return frames;
  const position = invertAtTime(state, planTimeValue(planInfo, outputFrame), CURVE_REFINEMENT_TOLERANCES.length - 1);
  if (!position.ok) return position;
  const frame = frames.value[outputFrame]!;
  const continuous = position.value;
  const number = continuous.kind === 'exact' ? ratNumber(ratNorm(BigInt(continuous.numerator), BigInt(continuous.denominator))) : continuous.value;
  const phase = clampNumber(number - Math.floor(number), 0, 1);
  const nextOffset = plan.direction === 'forward' ? 1 : -1;
  return done({outputFrame, source: continuous, sourceFrame: frame,
    nextSourceFrame: clampFrame(state, frame + nextOffset), phase, tail: false});
}
/** Output frames whose displayed source frame equals `sourceFrame`. */
export function timeMapOutputAtSourceFrame(plan: CompiledTimeMap, sourceFrame: number): TimeMapResult<TimeMapOutputAtSource> {
  if (!Number.isSafeInteger(sourceFrame)) return fail('INVALID_REQUEST', 'source frame must be a safe integer');
  const frames = timeMapPlanFrames(plan);
  if (!frames.ok) return frames;
  const vector = frames.value;
  const forward = plan.direction === 'forward';
  let low = 0, high = vector.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (forward ? vector[middle]! < sourceFrame : vector[middle]! > sourceFrame) low = middle + 1; else high = middle;
  }
  const first = low;
  low = 0; high = vector.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (forward ? vector[middle]! <= sourceFrame : vector[middle]! >= sourceFrame) low = middle + 1; else high = middle;
  }
  const last = low - 1;
  if (first <= last) return done({status: 'inside', firstOutputFrame: first, lastOutputFrame: last});
  const minimum = forward ? vector[0]! : vector[vector.length - 1]!;
  const maximum = forward ? vector[vector.length - 1]! : vector[0]!;
  return done({status: sourceFrame < minimum ? 'before' : sourceFrame > maximum ? 'after' : 'inside',
    firstOutputFrame: null, lastOutputFrame: null});
}

// ---------------------------------------------------------------------------
// Tail generalized inverse: callers must pick the earliest/latest source frame
// explicitly; the mapping never guesses past the motion range with an epsilon.
// ---------------------------------------------------------------------------

export interface TimeMapOutputPosition {readonly numerator: string; readonly denominator: string}
function tailResult(plan: CompiledTimeMap, _state: RootState, options: {tailInverse: 'earliest' | 'latest'}): TimeMapResult<{readonly position: ContinuousSourcePosition; readonly frame: number; readonly tail: boolean}> {
  const visible = timeMapVisibleSourceRange(plan);
  if (!visible.ok) return visible;
  const latest = options.tailInverse === 'latest';
  const frame = latest ? visible.value.sourceWindow.endFrame - 1 : visible.value.sourceWindow.startFrame;
  return done({position: {kind: 'numeric', value: latest ? visible.value.sourceWindow.endFrame : visible.value.sourceWindow.startFrame, errorBound: 0},
    frame, tail: true});
}
function curveInverseTarget(state: RootState, base: RootTimeValue, signed: Rat) {
  const integralPerFrame = 1 / numberFromRat(state.framesPerIntegral);
  const rawNumber = timeNumber(state, base) + ratNumber(signed);
  const rawError = timeUncertainty(state, base) + 8 * EPSILON * (Math.abs(rawNumber) + 1);
  if (rawNumber - rawError > state.lengthNumber || rawNumber + rawError < 0) return null;
  const integral = state.integralOrigin + rawNumber * integralPerFrame;
  return {integral, error: rawError * integralPerFrame + 8 * EPSILON * (Math.abs(integral) + 1)};
}
/** Resolves an output clock position (in output frames from the view start) to a
 * source position. Positions beyond the motion range are the explicit tail hold
 * chosen by `tailInverse`; positions inside are inverted with the refinement
 * ladder. Frame selection follows the plan direction. */
export function timeMapTailInverse(plan: CompiledTimeMap, position: TimeMapOutputPosition, options: {tailInverse: 'earliest' | 'latest'}): TimeMapResult<{readonly position: ContinuousSourcePosition; readonly frame: number; readonly tail: boolean}> {
  const planInfo = planState(plan), state = rootState(plan.root);
  let offset: Rat;
  try { offset = ratNorm(BigInt(position.numerator), BigInt(position.denominator)); }
  catch { return fail('INVALID_REQUEST', 'output position is not a valid rational'); }
  if (ratCmp(offset, ratInt(0n)) < 0) return fail('INVALID_REQUEST', 'output position must be non-negative');
  const base = boundaryTimeValue(planInfo.direction === 'forward' ? planInfo.loTime : planInfo.hiTime);
  const signed = planInfo.direction === 'forward' ? offset : ratNeg(offset);
  if (state.kind === 'freeze') {
    return done({position: {kind: 'exact', numerator: String(state.freezeFrame!), denominator: '1'}, frame: state.freezeFrame!, tail: false});
  }
  if (state.lengthExact !== null && state.rate !== null) {
    const raw = ratAdd(timeExact(state, base)!, signed);
    if (ratCmp(raw, ratInt(0n)) < 0 || ratCmp(raw, state.lengthExact) > 0) return tailResult(plan, state, options);
    const source = ratAdd(state.sourceStart, ratMul(raw, ratMul(state.rate!, state.framesPerIntegral)));
    const clamped = ratCmp(source, state.sourceStart) < 0 ? state.sourceStart : ratCmp(source, state.sourceEnd) > 0 ? state.sourceEnd : source;
    const frame = planInfo.direction === 'forward' ? Number(ratFloor(clamped)) : Number(ratCeil(clamped) - 1n);
    return done({position: {kind: 'exact', numerator: String(clamped.n), denominator: String(clamped.d)}, frame: clampFrame(state, frame),
      tail: false});
  }
  const target = curveInverseTarget(state, base, signed);
  if (!target) return tailResult(plan, state, options);
  const {integral: targetIntegral, error: targetError} = target;
  const inverted = invertCurve(state, targetIntegral, targetError, CURVE_REFINEMENT_TOLERANCES.length - 1);
  if (!inverted.ok) return inverted;
  const decided = decideFramePosition(state, inverted.value.value, inverted.value.errorBound, planInfo.direction,
    level => invertCurve(state, targetIntegral, targetError, level));
  if (!decided.ok) return decided;
  return done({position: {kind: 'numeric', value: inverted.value.value, errorBound: inverted.value.errorBound}, frame: decided.value, tail: false});
}

// Curve audio repeatedly inverts nearby positions at sample resolution.
// Keep one bounded, lazy prefix per control-point segment of the immutable root.
const audioIntegrationCells = 64;
const audioCellTolerance = 1e-12;
interface AudioIntegralTable {
  readonly positions: Float64Array;
  readonly integrals: Float64Array;
  readonly errors: Float64Array;
}
const audioIntegralTables = new WeakMap<RootState, Map<number, AudioIntegralTable | null>>();

function audioIntegralTable(state: RootState, segment: number): AudioIntegralTable | null {
  let tables = audioIntegralTables.get(state);
  if (!tables) {tables = new Map(); audioIntegralTables.set(state, tables);}
  const cached = tables.get(segment);
  if (cached !== undefined) return cached;
  const table = buildAudioIntegralTable(state.curve!, segment);
  tables.set(segment, table);
  return table;
}

function buildAudioIntegralTable(curve: CurveState, segment: number): AudioIntegralTable | null {
  const positions = new Float64Array(audioIntegrationCells + 1), integrals = new Float64Array(positions.length), errors = new Float64Array(positions.length);
  const begin = curve.xs[segment]!, end = curve.xs[segment + 1]!;
  positions[0] = begin;
  integrals[0] = curve.prefix[segment]!;
  errors[0] = curve.prefixError[segment]!;
  let budget = LOCAL_CELL_BUDGET;
  for (let i = 1; i <= audioIntegrationCells; i++) {
    const cellEnd = i === audioIntegrationCells ? end : begin + ((end - begin) * i) / audioIntegrationCells;
    positions[i] = cellEnd;
    const estimate = integrateCurveCell(curve, segment, positions[i - 1]!, cellEnd, audioCellTolerance / audioIntegrationCells, budget);
    if (!estimate || estimate.value <= 0) return null;
    budget -= estimate.cells;
    integrals[i] = integrals[i - 1]! + estimate.value;
    errors[i] = errors[i - 1]! + estimate.errorBound + 8 * EPSILON * (Math.abs(integrals[i]!) + 1);
  }
  return {positions, integrals, errors};
}

function audioIntegralInverse(state: RootState, target: number, targetError: number): {readonly value: number; readonly errorBound: number} | null {
  if (target <= state.integralOrigin + targetError || target >= state.integralOrigin + state.integralTotal - targetError) {
    return null;
  }
  const curve = state.curve!;
  let low = 0, high = curve.xs.length - 2;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (curve.prefix[middle]! <= target) low = middle; else high = middle - 1;
  }
  const segment = low;
  const table = audioIntegralTable(state, segment);
  if (!table) return null;
  low = 0;
  high = audioIntegrationCells - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (table.integrals[middle]! <= target) low = middle; else high = middle - 1;
  }
  const cell = low, integral = table.integrals[cell]!, cellStart = table.positions[cell]!, cellEnd = table.positions[cell + 1]!;
  let lowerSource = cellStart, upperSource = cellEnd;
  const cellIntegral = table.integrals[cell + 1]! - integral;
  if (!(cellIntegral > 0)) return null;
  let u = clampNumber(cellStart + (target - integral) * (cellEnd - cellStart) / cellIntegral, lowerSource, upperSource);
  for (let iteration = 0; iteration < 12; iteration++) {
    const estimate = integrateCurveCell(curve, segment, cellStart, u, audioCellTolerance, LOCAL_CELL_BUDGET);
    if (!estimate) break;
    const atPosition = integral + estimate.value;
    const residual = atPosition - target;
    const error = table.errors[cell]! + estimate.errorBound + targetError + 8 * EPSILON * (Math.abs(atPosition) + 1);
    if (Math.abs(residual) <= error) {
      // The supported rate cap is 10. Bound conversion from integral to source
      // distance with its reciprocal, leaving room for rate rounding.
      const errorBound = (error + Math.abs(residual)) / (0.1 - 64 * EPSILON) + 8 * EPSILON * (Math.abs(u) + 1);
      return {value: u, errorBound};
    }
    const slope = curveIntegrand(curve, u);
    if (!(slope > 0) || !Number.isFinite(slope)) break;
    if (residual > 0) upperSource = u; else lowerSource = u;
    const newton = u - residual / slope;
    const next = newton > lowerSource && newton < upperSource ? newton : lowerSource + (upperSource - lowerSource) / 2;
    if (next === u) break;
    u = next;
  }
  return null;
}

/** A source position for audio resampling. The prefix is eligible only within
 * the caller's error limit in source frames. Other positions use the established inverse. */
export function timeMapAudioInverse(plan: CompiledTimeMap, position: TimeMapOutputPosition, prefixErrorLimit: number):
  TimeMapResult<{readonly position: ContinuousSourcePosition; readonly tail: boolean}> {
  const exact = () => timeMapTailInverse(plan, position, {tailInverse: 'latest'});
  const state = rootState(plan.root);
  if (!state.curve || !Number.isFinite(prefixErrorLimit) || prefixErrorLimit <= 0) return exact();
  let offset: Rat;
  try { offset = ratNorm(BigInt(position.numerator), BigInt(position.denominator)); }
  catch { return exact(); }
  if (offset.n < 0n) return exact();
  const {direction, loTime, hiTime} = planState(plan);
  const base = boundaryTimeValue(direction === 'forward' ? loTime : hiTime);
  const target = curveInverseTarget(state, base, direction === 'forward' ? offset : ratNeg(offset));
  if (!target) return exact();
  const inverted = audioIntegralInverse(state, target.integral, target.error);
  if (!inverted || inverted.errorBound > prefixErrorLimit || inverted.value < numberFromRat(state.sourceStart) ||
      inverted.value > numberFromRat(state.sourceEnd)) return exact();
  return done({position: {kind: 'numeric', ...inverted}, tail: false});
}

// ---------------------------------------------------------------------------
// Curve presets (normalized point sets; instantiated to the source range on pick).
// ---------------------------------------------------------------------------

export interface TimeMapPresetPoint { readonly position: number; readonly rate: TimeMapSpeedRate }
export interface TimeMapCurvePreset { readonly id: string; readonly kind: 'constant' | 'curve'; readonly points: readonly TimeMapPresetPoint[] }

/** The eight presets fixed by SP-M for review: `none` is the 1x baseline,
 * `custom` is the editable identity curve, and the other six are the published
 * point sets (normalized to the source range when picked). */
export const TIMELINE_SPEED_PRESETS: readonly TimeMapCurvePreset[] = Object.freeze([
  {id: 'none', kind: 'constant', points: Object.freeze([])},
  {id: 'custom', kind: 'curve', points: Object.freeze([
    {position: 0, rate: {numerator: 1, denominator: 1}}, {position: 1, rate: {numerator: 1, denominator: 1}}])},
  {id: 'fastToSlow', kind: 'curve', points: Object.freeze([
    {position: 0, rate: {numerator: 3, denominator: 1}}, {position: 1 / 2, rate: {numerator: 3, denominator: 2}},
    {position: 1, rate: {numerator: 1, denominator: 2}}])},
  {id: 'slowToFast', kind: 'curve', points: Object.freeze([
    {position: 0, rate: {numerator: 1, denominator: 2}}, {position: 1 / 2, rate: {numerator: 3, denominator: 2}},
    {position: 1, rate: {numerator: 3, denominator: 1}}])},
  {id: 'slowMiddle', kind: 'curve', points: Object.freeze([
    {position: 0, rate: {numerator: 2, denominator: 1}}, {position: 1 / 2, rate: {numerator: 1, denominator: 4}},
    {position: 1, rate: {numerator: 2, denominator: 1}}])},
  {id: 'fastMiddle', kind: 'curve', points: Object.freeze([
    {position: 0, rate: {numerator: 1, denominator: 2}}, {position: 1 / 2, rate: {numerator: 4, denominator: 1}},
    {position: 1, rate: {numerator: 1, denominator: 2}}])},
  {id: 'flashIn', kind: 'curve', points: Object.freeze([
    {position: 0, rate: {numerator: 4, denominator: 1}}, {position: 1 / 4, rate: {numerator: 1, denominator: 1}},
    {position: 1, rate: {numerator: 1, denominator: 1}}])},
  {id: 'flashOut', kind: 'curve', points: Object.freeze([
    {position: 0, rate: {numerator: 1, denominator: 1}}, {position: 3 / 4, rate: {numerator: 1, denominator: 1}},
    {position: 1, rate: {numerator: 4, denominator: 1}}])},
] as unknown as readonly TimeMapCurvePreset[]);
export function timeMapPreset(presetId: string): TimeMapCurvePreset | undefined {
  return TIMELINE_SPEED_PRESETS.find(preset => preset.id === presetId);
}
/** Snap a preset's normalized points onto an integer source range. Endpoints are
 * exact; interior positions use round-half-up and are bumped to stay strictly
 * increasing. The instantiated point sets are committed test vectors. */
export function instantiateSpeedPreset(presetId: string, startFrame: number, endFrame: number): TimeMapResult<TimeMapSpeed> {
  const preset = timeMapPreset(presetId);
  if (!preset) return fail('INVALID_REQUEST', 'unknown speed preset');
  if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame) || endFrame - startFrame < 2) {
    return fail('INVALID_SOURCE_RANGE', 'preset needs an integer source range of at least two frames');
  }
  if (preset.kind === 'constant') return done({kind: 'constant', rate: {numerator: 1, denominator: 1}});
  const span = endFrame - startFrame;
  const used = new Set<number>();
  const points: TimeMapCurvePoint[] = [];
  for (const [index, point] of preset.points.entries()) {
    const first = index === 0, last = index === preset.points.length - 1;
    let frame = first ? startFrame : last ? endFrame : startFrame + Math.floor(point.position * span + 0.5);
    if (framesTaken(used, frame)) {
      while (used.has(frame)) frame++;
    }
    if (points.length > 0 && frame <= points[points.length - 1]!.sourceFrame) frame = points[points.length - 1]!.sourceFrame + 1;
    if (frame > endFrame) break;
    used.add(frame);
    points.push({sourceFrame: frame, rate: {...point.rate}});
  }
  if (points.length < 2 || points[points.length - 1]!.sourceFrame !== endFrame) {
    points.push({sourceFrame: endFrame, rate: {...preset.points[preset.points.length - 1]!.rate}});
  }
  return done({kind: 'curve', interpolation: TIMELINE_TIME_MAP_INTERPOLATION, presetId: preset.id, points});
}
const framesTaken = (used: Set<number>, frame: number): boolean => used.has(frame);

// ---------------------------------------------------------------------------
// Q64 source boundary projection (the explicit format semantics for a new curve
// basis; not a format-5 field).
// ---------------------------------------------------------------------------

const Q64_SCALE = 1n << 64n;
function rationalFromNumberBound(bound: number): Rat {
  if (!(bound > 0)) return ratInt(0n);
  return ratDiv(ratInt(Math.round(bound * 2 ** 40)), ratInt(2n ** 40n));
}
function roundRatToQ64(value: Rat): bigint {
  const scaled = ratMul(value, ratInt(Q64_SCALE));
  const floorValue = ratFloor(scaled);
  const remainder = ratSub(scaled, ratInt(floorValue));
  const half = ratNorm(1n, 2n);
  const comparison = ratCmp(remainder, half);
  if (comparison < 0) return floorValue;
  if (comparison > 0) return floorValue + 1n;
  return floorValue % 2n === 0n ? floorValue : floorValue + 1n;
}
function exactDouble(value: number): Rat {
  if (!Number.isFinite(value)) throw new Error('not a finite double');
  const buffer = new DataView(new ArrayBuffer(8));
  buffer.setFloat64(0, value);
  const bits = buffer.getBigUint64(0);
  const negative = (bits >> 63n) === 1n;
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  let mantissa = fraction, power = -1074;
  if (exponent !== 0) { mantissa = fraction | (1n << 52n); power = exponent - 1075; }
  const numerator = negative ? -mantissa : mantissa;
  return normDyadic(numerator, power);
}
function normDyadic(numerator: bigint, power: number): Rat {
  if (power >= 0) return ratNorm(numerator << BigInt(power), 1n);
  return ratNorm(numerator, 1n << BigInt(-power));
}
/** Rounds an exact or error-bounded continuous source position onto the Q64 grid
 * with ties-to-even. A bound that still crosses a rounding boundary after the
 * refinement ladder fails instead of guessing. */
export function projectSourceBoundaryToQ64(value: ContinuousSourcePosition, options: {maxRefinementLevel?: number} = {}): TimeMapResult<{readonly boundary: TimeMapSourceBoundary; readonly rounded: 'exact' | 'nearest'}> {
  if (value.kind === 'exact') {
    const exact = ratNorm(BigInt(value.numerator), BigInt(value.denominator));
    return done({boundary: {kind: 'q64', ticks: String(roundRatToQ64(exact))}, rounded: 'exact'});
  }
  if (!Number.isFinite(value.value) || !Number.isFinite(value.errorBound) || value.errorBound < 0) return fail('INVALID_REQUEST', 'invalid numeric source position');
  const levels = options.maxRefinementLevel === undefined ? 2 : Math.min(Math.max(options.maxRefinementLevel, 0), 2);
  let bound = value.errorBound;
  const exact = exactDouble(value.value);
  for (let level = 0; level <= levels; level++) {
    const rounded = roundRatToQ64(exact);
    const low = roundRatToQ64(ratSub(exact, rationalFromNumberBound(bound)));
    const high = roundRatToQ64(ratAdd(exact, rationalFromNumberBound(bound)));
    if (low === rounded && high === rounded) return done({boundary: {kind: 'q64', ticks: String(rounded)}, rounded: 'nearest'});
    if (level === levels) break;
    bound /= 1024;
  }
  return fail('NUMERIC_BUDGET_EXCEEDED', 'source boundary is not decidable on the Q64 grid under the error bound');
}
export function q64ToExactBoundary(ticks: string): TimeMapSourceBoundary {
  const value = ratNorm(BigInt(ticks), Q64_SCALE);
  return {kind: 'rational', numerator: String(value.n), denominator: String(value.d)};
}

// ---------------------------------------------------------------------------
// VFR PTS adaptation: the source clock position is not a media frame ordinal.
// ---------------------------------------------------------------------------

/** Adapts a continuous source-clock position to a real media frame ordinal using
 * a sorted PTS list (presentation times in seconds). The phase is the position
 * between the chosen frame and the next PTS; the adapter never treats the source
 * clock value as an encoded frame number. */
export function timeMapVfrFrame(ptsSeconds: readonly number[], sourceFramesPerSecond: number, sourcePosition: ContinuousSourcePosition): TimeMapResult<{readonly frame: number; readonly nextFrame: number | null; readonly phase: number}> {
  if (!Number.isFinite(sourceFramesPerSecond) || sourceFramesPerSecond <= 0) return fail('INVALID_TIMEBASE', 'VFR adaptation needs a positive source clock');
  if (!Array.isArray(ptsSeconds) || ptsSeconds.length < 2 || ptsSeconds.some((entry, index) => !Number.isFinite(entry) || (index > 0 && entry <= ptsSeconds[index - 1]!))) {
    return fail('INVALID_REQUEST', 'PTS index must contain at least two strictly increasing finite times');
  }
  const positionSeconds = sourcePosition.kind === 'exact'
    ? ratNumber(ratNorm(BigInt(sourcePosition.numerator), BigInt(sourcePosition.denominator))) / sourceFramesPerSecond
    : sourcePosition.value / sourceFramesPerSecond;
  const lastStart = ptsSeconds[ptsSeconds.length - 2]!, lastEnd = ptsSeconds[ptsSeconds.length - 1]!;
  if (positionSeconds < ptsSeconds[0]! || positionSeconds > lastEnd + (lastEnd - lastStart)) {
    return fail('INVALID_SOURCE_RANGE', 'source position is outside the PTS index');
  }
  let low = 0, high = ptsSeconds.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (ptsSeconds[middle]! <= positionSeconds) low = middle; else high = middle - 1;
  }
  const frame = low;
  const start = ptsSeconds[frame]!;
  const end = frame + 1 < ptsSeconds.length ? ptsSeconds[frame + 1]! : start + (start - (ptsSeconds[frame - 1] ?? start));
  const phase = end > start ? clampNumber((positionSeconds - start) / (end - start), 0, 1) : 0;
  return done({frame, nextFrame: frame + 1 < ptsSeconds.length ? frame + 1 : null, phase});
}

// ---------------------------------------------------------------------------
// Current clip contract seam. The current project format has no timing fields,
// so a saved clip reads as its identity 1x map; a compiled map projects back
// onto the existing integer fields. No project format field is added here.
// ---------------------------------------------------------------------------

export interface CurrentTimelineClipLike {
  readonly id: string;
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly sourceInFrame: number;
  readonly [key: string]: unknown;
}
export interface CurrentTimelineLike { readonly fps: number; readonly [key: string]: unknown }
export interface ClipFrameProjection {
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly sourceInFrame: number;
  readonly sourceSpanFrames: number;
}
/** Reads the current clip record as an identity (1x, forward, full) map. */
export function timeMapBasisFromCurrentClip(clip: CurrentTimelineClipLike, timeline: CurrentTimelineLike): TimeMapResult<TimeMapBasis> {
  if (!Number.isSafeInteger(clip.startFrame) || !Number.isSafeInteger(clip.durationFrames) || !Number.isSafeInteger(clip.sourceInFrame)
    || clip.startFrame < 0 || clip.durationFrames < 1 || clip.sourceInFrame < 0) {
    return fail('INVALID_REQUEST', 'current clip fields must be non-negative safe integers');
  }
  if (!Number.isSafeInteger(timeline.fps) || timeline.fps < 1 || timeline.fps > 1000) return fail('INVALID_TIMEBASE', 'timeline fps must be a positive integer');
  const timebaseValue: TimeMapTimebase = {fpsNumerator: timeline.fps, fpsDenominator: 1};
  return done({profile: TIMELINE_TIME_MAP_BASIS_PROFILE, sourceFps: timebaseValue, outputFps: timebaseValue,
    sourceRange: {start: ratToBoundary(ratInt(clip.sourceInFrame)), end: ratToBoundary(ratInt(clip.sourceInFrame + clip.durationFrames))},
    speed: {kind: 'constant', rate: {numerator: 1, denominator: 1}}});
}
/** Projects the compiled source envelope onto the current clip fields. */
export function projectTimeMapToCurrentClipFields(clip: CurrentTimelineClipLike, plan: CompiledTimeMap): TimeMapResult<ClipFrameProjection> {
  const state = rootState(plan.root);
  const output = {startFrame: clip.startFrame, durationFrames: plan.durationFrames};
  if (state.freezeFrame !== null) return done({...output, sourceInFrame: state.freezeFrame, sourceSpanFrames: 1});
  const interval = planClockInterval(state, planState(plan));
  const start = resolvePositionInteger(state, interval.lo, 'floor');
  if (!start.ok) return start;
  const end = resolvePositionInteger(state, interval.hi, 'ceil');
  if (!end.ok) return end;
  const sourceInFrame = Math.max(state.frameRange.start, start.value);
  const sourceSpanFrames = Math.min(state.frameRange.end + 1, end.value) - sourceInFrame;
  if (sourceSpanFrames < 1) return fail('INVALID_WINDOW', 'visible source envelope is empty');
  return done({...output, sourceInFrame, sourceSpanFrames});
}
/** Verifies that the current integer fields equal the compiled projection. */
export function verifyCurrentClipTiming(clip: CurrentTimelineClipLike, plan: CompiledTimeMap): TimeMapResult<{readonly projection: ClipFrameProjection; readonly matches: boolean}> {
  const projection = projectTimeMapToCurrentClipFields(clip, plan);
  if (!projection.ok) return projection;
  return done({projection: projection.value, matches: clip.durationFrames === projection.value.durationFrames && clip.sourceInFrame === projection.value.sourceInFrame});
}

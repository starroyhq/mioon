import {z} from 'zod';
import {exportSamplePeakArtifactSchema, isExportSamplePeakFrameCountCompatible} from './export-sample-peak.ts';

/** Fixed 48 kHz stereo file observation. This profile grants no edit authority. */
export const EXPORT_LOUDNESS_PROFILE = 'bs1770-5-48k-stereo-fir4x-v1';
export const EXPORT_LOUDNESS_LIMITS = Object.freeze({inputBytes: 512 * 1024 * 1024,
  totalHashedBytes: 1024 * 1024 * 1024, timeoutMs: 120_000, clientTimeoutMs: 125_000,
  durationSeconds: 600, pcmBytes: 230_400_000, sampleFrames: 28_800_000,
  responseBytes: 8 * 1024, durationToleranceSeconds: 0.1, gatingBlocks: 5997});
/** App-selected advisory reserve, not a codec safety bound or standard target. */
export const EXPORT_LOUDNESS_ADVISORY_MARGIN_DB = 0.5;

const id = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const count = (max: number): z.ZodNumber => z.number().int().min(0).max(max);
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
export const exportLoudnessTargetSchema = z.object({
  integratedLufs: z.number().finite().min(-60).max(-5),
  truePeakCeilingDbtp: z.number().finite().min(-20).max(0),
}).strict();
export type ExportLoudnessTarget = z.infer<typeof exportLoudnessTargetSchema>;
export const exportLoudnessInputSchema = z.object({projectId: id, exportId: id,
  expectedArtifactSha256: hash, measurementProfile: z.literal(EXPORT_LOUDNESS_PROFILE),
  target: exportLoudnessTargetSchema.optional(),
}).strict().superRefine((v, c) => {
  if (Object.hasOwn(v, 'target') && v.target === undefined)
    c.addIssue({code: z.ZodIssueCode.custom, path: ['target'], message: 'Omit an unselected target.'});
});
export type ExportLoudnessInput = z.infer<typeof exportLoudnessInputSchema>;
export const exportLoudnessSchemas = Object.freeze({'timeline.export.loudness': exportLoudnessInputSchema});

const peak = z.number().finite().min(0).max(1e42);
const db = z.number().finite().nullable();
export const exportLoudnessMeasurementSchema = z.object({
  sampleRate: z.literal(48000), channels: z.literal(2),
  sampleFrames: z.number().int().min(1).max(EXPORT_LOUDNESS_LIMITS.sampleFrames),
  decodedDurationSeconds: z.number().finite().positive().max(600),
  state: z.enum(['valid', 'digital_silence', 'too_short', 'below_gate']),
  integratedLufs: db,
  samplePeakLinear: peak.max(3.4028234663852886e38), samplePeakDbfs: db,
  truePeakLinear: peak, truePeakDbtp: db,
  gatingBlockCount: count(EXPORT_LOUDNESS_LIMITS.gatingBlocks),
  absoluteGatedBlockCount: count(EXPORT_LOUDNESS_LIMITS.gatingBlocks),
  relativeGatedBlockCount: count(EXPORT_LOUDNESS_LIMITS.gatingBlocks),
  relativeGateLufs: db,
}).strict().superRefine((v, c) => {
  const fail = (path: string, message: string): void => c.addIssue({code: z.ZodIssueCode.custom, path: [path], message});
  if (!near(v.decodedDurationSeconds, v.sampleFrames / 48000)) fail('decodedDurationSeconds', 'Duration must match every decoded frame.');
  for (const [linear, logarithmic] of [[v.samplePeakLinear, v.samplePeakDbfs], [v.truePeakLinear, v.truePeakDbtp]] as const) {
    if (linear === 0 ? logarithmic !== null : logarithmic === null || !near(logarithmic, 20 * Math.log10(linear)))
      fail('samplePeakDbfs', 'Peak amplitude and logarithmic units must agree.');
  }
  if (v.truePeakLinear < v.samplePeakLinear) fail('truePeakLinear', 'The conservative estimate includes original samples.');
  if (v.truePeakLinear > v.samplePeakLinear * 2.0228271484375 * (1 + 1e-12))
    fail('truePeakLinear', 'The fixed FIR profile cannot exceed its absolute coefficient bound.');
  const blocks = v.sampleFrames < 19200 ? 0 : 1 + Math.floor((v.sampleFrames - 19200) / 4800);
  if (v.gatingBlockCount !== blocks) fail('gatingBlockCount', 'Only complete 400ms blocks at 100ms hops count.');
  if (v.relativeGatedBlockCount > v.absoluteGatedBlockCount || v.absoluteGatedBlockCount > blocks)
    fail('absoluteGatedBlockCount', 'Gate membership counts are nested.');
  if (v.absoluteGatedBlockCount === 0 ? v.relativeGateLufs !== null : v.relativeGateLufs === null || v.relativeGateLufs <= -80)
    fail('relativeGateLufs', 'Relative threshold requires qualified absolute-gated energy.');
  if (v.relativeGateLufs !== null && v.relativeGateLufs <= -70 && v.relativeGatedBlockCount !== v.absoluteGatedBlockCount)
    fail('relativeGatedBlockCount', 'A weaker relative gate cannot exclude absolute-gated blocks.');
  const state = v.samplePeakLinear === 0 ? 'digital_silence' : blocks === 0 ? 'too_short' :
    v.absoluteGatedBlockCount === 0 ? 'below_gate' : 'valid';
  if (v.state !== state) fail('state', 'Silence, length and gate validity are distinct.');
  if (state === 'digital_silence' && (v.truePeakLinear !== 0 || v.absoluteGatedBlockCount !== 0 || v.relativeGateLufs !== null))
    fail('state', 'Exact digital silence has zero peaks and no qualified gate members.');
  if (state === 'valid') {
    if (v.integratedLufs === null || v.integratedLufs <= -70 || !v.relativeGatedBlockCount ||
        v.relativeGateLufs === null || v.integratedLufs <= v.relativeGateLufs)
      fail('integratedLufs', 'A valid integrated value requires both qualified gates.');
    if (v.integratedLufs !== null && v.relativeGateLufs !== null &&
        (v.integratedLufs < v.relativeGateLufs + 10 - 1e-9 ||
        v.relativeGatedBlockCount === v.absoluteGatedBlockCount && !near(v.integratedLufs, v.relativeGateLufs + 10)))
      fail('integratedLufs', 'Relative gating cannot decrease the absolute-gated mean.');
    if (v.integratedLufs !== null && v.relativeGateLufs !== null && v.relativeGatedBlockCount > 0 &&
        v.integratedLufs > v.relativeGateLufs + 10 + 10 * Math.log10(v.absoluteGatedBlockCount / v.relativeGatedBlockCount) + 1e-9)
      fail('integratedLufs', 'Selected gate energy cannot exceed total absolute-gated energy.');
  } else if (v.integratedLufs !== null || v.relativeGatedBlockCount !== 0)
    fail('integratedLufs', 'Unqualified measurements cannot carry a finite loudness result.');
});
export type ExportLoudnessMeasurement = z.infer<typeof exportLoudnessMeasurementSchema>;

const reasonMessages = Object.freeze({
  NO_AUDIO: '此导出文件没有音轨，不能当作数字静音。',
  UNSUPPORTED_FORMAT: '此检查仅支持完整托管 MP4 的唯一 AAC、48 kHz 双声道音轨。',
  INPUT_TOO_LARGE: '此文件超过 512 MiB 检查上限。',
  DURATION_LIMIT: '此文件超过 600 秒检查上限。',
  BUSY: '另一个导出音频检查仍在运行或清理，本次未排队。',
  TIMEOUT: '检查超时，未获得完整测量。',
  RESOURCE_LIMIT: '检查达到资源上限，未获得完整测量。',
  DECODER_UNAVAILABLE: '本地解码器不可用，未获得完整测量。',
  INVALID_PCM: '音频不完整、含无效样本或时长不符，未获得完整测量。',
  DECODE_FAILED: '文件未能完整解码，未获得完整测量。',
  CANCELLED: '本次检查已停止，未获得完整测量。',
  SHUTDOWN: '后端正在关闭，本次检查未完成。',
  ARTIFACT_CHANGED: '所选导出文件的身份、内容或归属变化，结果已丢弃。',
});
export type ExportLoudnessReasonCode = keyof typeof reasonMessages;
export function exportLoudnessReason<Code extends ExportLoudnessReasonCode>(code: Code): Readonly<{code: Code; message: string}> {
  if (!Object.hasOwn(reasonMessages, code)) throw new Error('Invalid loudness reason code.');
  return {code, message: reasonMessages[code]};
}
const reason = z.object({code: z.enum(Object.keys(reasonMessages) as [ExportLoudnessReasonCode, ...ExportLoudnessReasonCode[]]),
  message: z.string().min(1).max(240)}).strict().refine(v => v.message === reasonMessages[v.code]);
export const exportLoudnessArtifactSchema = exportSamplePeakArtifactSchema.innerType().extend({snapshotSha256: hash}).strict();
export type ExportLoudnessArtifact = z.infer<typeof exportLoudnessArtifactSchema>;
export const exportLoudnessSuggestionSchema = z.object({
  purpose: z.literal('arithmetic-only'), requiredGainDb: z.number().finite(), gainMultiplier: z.number().finite().positive(),
  truePeakRoomDb: z.number().finite(), projectedTruePeakDbtp: z.number().finite(), conflictsWithCeiling: z.boolean(),
  marginDb: z.literal(EXPORT_LOUDNESS_ADVISORY_MARGIN_DB),
  currentTimelineValidated: z.literal(false), applyAllowed: z.literal(false),
}).strict();
export type ExportLoudnessSuggestion = z.infer<typeof exportLoudnessSuggestionSchema>;
/** Approximate arithmetic on this measured file only. No lower target is silently substituted. */
export function exportLoudnessSuggestion(measurement: ExportLoudnessMeasurement, target?: ExportLoudnessTarget): ExportLoudnessSuggestion | null {
  if (!target || measurement.state !== 'valid' || measurement.integratedLufs === null || measurement.truePeakDbtp === null) return null;
  const requiredGainDb = target.integratedLufs - measurement.integratedLufs;
  const truePeakRoomDb = target.truePeakCeilingDbtp - measurement.truePeakDbtp - EXPORT_LOUDNESS_ADVISORY_MARGIN_DB;
  return {purpose: 'arithmetic-only', requiredGainDb, gainMultiplier: 10 ** (requiredGainDb / 20), truePeakRoomDb,
    projectedTruePeakDbtp: measurement.truePeakDbtp + requiredGainDb, conflictsWithCeiling: requiredGainDb > truePeakRoomDb,
    marginDb: EXPORT_LOUDNESS_ADVISORY_MARGIN_DB, currentTimelineValidated: false, applyAllowed: false};
}
const common = {...exportLoudnessInputSchema.innerType().shape, checkedAt: z.string().max(30).datetime(),
  stage: z.literal('decoded-export-file')};
const unmeasured = {...common, artifact: z.null(), measurement: z.null(), suggestion: z.null(),
  checks: z.object({bytesHashed: count(EXPORT_LOUDNESS_LIMITS.totalHashedBytes), audioFullyDecoded: z.literal(false)}).strict()};
export const exportLoudnessResponseSchema = z.discriminatedUnion('status', [
  z.object({...common, status: z.literal('ready'), artifact: exportLoudnessArtifactSchema,
    measurement: exportLoudnessMeasurementSchema, suggestion: exportLoudnessSuggestionSchema.nullable(), reason: z.null(),
    checks: z.object({bytesHashed: count(EXPORT_LOUDNESS_LIMITS.totalHashedBytes), audioFullyDecoded: z.literal(true)}).strict()}).strict(),
  z.object({...unmeasured, status: z.literal('unsupported'), reason}).strict(),
  z.object({...unmeasured, status: z.literal('incomplete'), reason}).strict(),
  z.object({...unmeasured, status: z.literal('stale'), reason}).strict(),
]).superRefine((v, c) => {
  const fail = (message: string): void => c.addIssue({code: z.ZodIssueCode.custom, message});
  if (Object.hasOwn(v, 'target') && v.target === undefined) fail('An absent target must remain absent.');
  if (v.status === 'ready') {
    if (v.artifact.sha256 !== v.expectedArtifactSha256 || v.checks.bytesHashed !== 2 * v.artifact.sizeBytes)
      fail('A ready result requires the selected artifact and two complete hash passes.');
    if (JSON.stringify(v.suggestion) !== JSON.stringify(exportLoudnessSuggestion(v.measurement, v.target)))
      fail('Suggestion must exactly bind the measured signal and explicit target.');
    if (v.artifact.exportRange && !isExportSamplePeakFrameCountCompatible(v.measurement.sampleFrames,
        v.artifact.exportRange.endFrame - v.artifact.exportRange.startFrame)) fail('Measurement must match the delivered range.');
    for (const key of ['deliveryName', 'exportRange'] as const)
      if (Object.hasOwn(v.artifact, key) && v.artifact[key] === undefined) fail('Frozen optional fields must remain absent or valid.');
  } else {
    const allowed = v.status === 'unsupported' ? ['NO_AUDIO','UNSUPPORTED_FORMAT','INPUT_TOO_LARGE','DURATION_LIMIT'] :
      v.status === 'stale' ? ['ARTIFACT_CHANGED'] : ['BUSY','TIMEOUT','RESOURCE_LIMIT','DECODER_UNAVAILABLE','INVALID_PCM','DECODE_FAILED','CANCELLED','SHUTDOWN'];
    if (!allowed.includes(v.reason.code)) fail('Reason must match the result state.');
  }
});
export type ExportLoudnessResponse = z.infer<typeof exportLoudnessResponseSchema>;

/** Bounded plain data only; never invoke accessors or toJSON on a direct-call response. */
function bounded(value: unknown): boolean {
  const seen = new Set<object>(); let nodes = 200;
  function visit(v: unknown, depth: number): boolean {
    if (--nodes < 0 || depth > 8) return false;
    if (v === null || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'string') return v.length <= EXPORT_LOUDNESS_LIMITS.responseBytes;
    if (typeof v !== 'object' || seen.has(v) || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
    seen.add(v); const fields = Object.getOwnPropertyDescriptors(v); const keys = Reflect.ownKeys(fields);
    if (keys.length > 40) return false;
    for (const key of keys) {
      if (typeof key !== 'string') return false;
      const d = fields[key];
      if (!d || !d.enumerable || !Object.hasOwn(d, 'value') || !visit(d.value, depth + 1)) return false;
    }
    seen.delete(v); return true;
  }
  return visit(value, 0) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= EXPORT_LOUDNESS_LIMITS.responseBytes;
}
export function isExportLoudnessResponse(value: unknown, input?: unknown): value is ExportLoudnessResponse {
  try {
    if (!bounded(value)) return false;
    const parsed = exportLoudnessResponseSchema.safeParse(value);
    if (!parsed.success) return false;
    if (input === undefined) return true;
    const requested = exportLoudnessInputSchema.safeParse(input);
    return requested.success && parsed.data.projectId === requested.data.projectId && parsed.data.exportId === requested.data.exportId &&
      parsed.data.expectedArtifactSha256 === requested.data.expectedArtifactSha256 && parsed.data.measurementProfile === requested.data.measurementProfile &&
      JSON.stringify(parsed.data.target) === JSON.stringify(requested.data.target);
  } catch {return false;}
}

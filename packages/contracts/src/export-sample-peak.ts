import {z} from 'zod';
import {timelineDeliveryNameSchema} from './timeline-delivery.ts';
import {timelineExportRangeSchema} from './timeline-export-range.ts';

/** An ephemeral observation of the delivered file, never an export receipt. */
export const EXPORT_SAMPLE_PEAK_ALGORITHM = 'export-sample-peak-f32le-48k-stereo-v1';
export const EXPORT_SAMPLE_PEAK_LIMITS = Object.freeze({
  inputBytes: 512 * 1024 * 1024,
  totalHashedBytes: 1024 * 1024 * 1024,
  timeoutMs: 120_000,
  clientTimeoutMs: 125_000,
  durationSeconds: 600,
  pcmBytes: 230_400_000,
  sampleFrames: 28_800_000,
  responseBytes: 8 * 1024,
  durationToleranceSeconds: 0.1,
});

const reasonMessages = Object.freeze({
  OVER_FULL_SCALE: '已导出文件解码样本峰值超过 0 dBFS；这不表示削波次数，也不保证其他播放或制作阶段的结果。',
  UNSUPPORTED_FORMAT: '此导出文件的音频格式暂不支持已导出文件解码样本峰值检查。',
  INPUT_TOO_LARGE: '此导出文件超过已导出文件解码样本峰值检查的文件大小上限。',
  DURATION_LIMIT: '此导出文件超过已导出文件解码样本峰值检查的时长上限。',
  BUSY: '已有已导出文件解码样本峰值检查正在运行；本次未排队。',
  TIMEOUT: '已导出文件解码样本峰值检查超时，未获得完整测量。',
  RESOURCE_LIMIT: '已导出文件解码样本峰值检查达到资源上限，未获得完整测量。',
  DECODER_UNAVAILABLE: '本地解码器不可用，未获得已导出文件解码样本峰值。',
  INVALID_PCM: '解码音频不完整或含无效样本，未获得已导出文件解码样本峰值。',
  DECODE_FAILED: '导出文件未能完整解码，未获得已导出文件解码样本峰值。',
  CANCELLED: '已导出文件解码样本峰值检查已停止，未获得完整测量。',
  SHUTDOWN: '后端正在关闭，已导出文件解码样本峰值检查未完成。',
  ARTIFACT_CHANGED: '导出文件或其归属在检查期间发生变化，已导出文件解码样本峰值结果已丢弃。',
});
export type ExportSamplePeakReasonCode = keyof typeof reasonMessages;
export type ExportSamplePeakReason = Readonly<{code: ExportSamplePeakReasonCode; message: string}>;
export function exportSamplePeakReason<Code extends ExportSamplePeakReasonCode>(code: Code): Readonly<{code: Code; message: string}> {
  if (!Object.hasOwn(reasonMessages, code)) throw new Error('Invalid 已导出文件解码样本峰值 reason code.');
  return {code, message: reasonMessages[code]};
}

const id = z.string().uuid();
const count = (maximum: number): z.ZodNumber => z.number().int().min(0).max(maximum);
const positiveCount = (maximum: number): z.ZodNumber => z.number().int().min(1).max(maximum);
const finitePeak = z.number().finite().nonnegative().max(3.4028234663852886e38);
const dbfs = z.number().finite().nullable();
const encoder = new TextEncoder();
const consistentNumber = (actual: number, expected: number): boolean => Math.abs(actual - expected) <= 1e-9;

/** Compare the exact saved 30fps delivery interval in integer PCM-frame space.
 * No floating-point duration subtraction or widened arithmetic tolerance. */
export function isExportSamplePeakFrameCountCompatible(sampleFrames: number, outputFrames: number): boolean {
  if (!Number.isSafeInteger(sampleFrames) || sampleFrames < 1 || sampleFrames > EXPORT_SAMPLE_PEAK_LIMITS.sampleFrames ||
      !Number.isSafeInteger(outputFrames) || outputFrames < 1 || outputFrames > 18000) return false;
  return Math.abs(sampleFrames - outputFrames * 1600) <= 4800;
}

export const exportSamplePeakInputSchema = z.object({projectId: id, exportId: id}).strict();
export type ExportSamplePeakInput = z.infer<typeof exportSamplePeakInputSchema>;
export const exportSamplePeakSchemas = Object.freeze({'timeline.export.samplePeak': exportSamplePeakInputSchema});

export const exportSamplePeakArtifactSchema = z.object({
  assetId: id,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sizeBytes: positiveCount(EXPORT_SAMPLE_PEAK_LIMITS.inputBytes),
  timelineRevision: positiveCount(Number.MAX_SAFE_INTEGER),
  deliveryName: timelineDeliveryNameSchema.optional(),
  exportRange: timelineExportRangeSchema.optional(),
}).strict().superRefine((value, context) => {
  for (const key of ['deliveryName', 'exportRange'] as const)
    if (Object.hasOwn(value, key) && value[key] === undefined)
      context.addIssue({code: z.ZodIssueCode.custom, path: [key], message: 'Optional frozen fields must be absent or explicitly valid.'});
});
export type ExportSamplePeakArtifact = z.infer<typeof exportSamplePeakArtifactSchema>;

const channelFields = {peakLinear: finitePeak, peakDbfs: dbfs, silent: z.boolean()};
export const exportSamplePeakMeasurementSchema = z.object({
  sampleRate: z.literal(48000),
  channels: z.literal(2),
  sampleFrames: positiveCount(EXPORT_SAMPLE_PEAK_LIMITS.sampleFrames),
  decodedDurationSeconds: z.number().finite().positive().max(EXPORT_SAMPLE_PEAK_LIMITS.durationSeconds),
  peakLinear: finitePeak,
  peakDbfs: dbfs,
  silent: z.boolean(),
  overFullScale: z.boolean(),
  channelPeaks: z.tuple([
    z.object({channel: z.literal(0), label: z.literal('left'), ...channelFields}).strict(),
    z.object({channel: z.literal(1), label: z.literal('right'), ...channelFields}).strict(),
  ]),
}).strict().superRefine((value, context) => {
  const fail = (path: (string | number)[], message: string): void =>
    context.addIssue({code: z.ZodIssueCode.custom, path, message});
  const validatePeak = (peak: {peakLinear: number; peakDbfs: number | null; silent: boolean}, path: (string | number)[]): void => {
    if (peak.silent !== (peak.peakLinear === 0)) fail([...path, 'silent'], 'Silence must match the exact zero amplitude.');
    if (peak.peakLinear === 0 ? peak.peakDbfs !== null : peak.peakDbfs === null ||
        !consistentNumber(peak.peakDbfs, 20 * Math.log10(peak.peakLinear)))
      fail([...path, 'peakDbfs'], 'dBFS must be derived from amplitude; only silence uses null.');
  };
  validatePeak(value, []);
  value.channelPeaks.forEach((peak, index) => validatePeak(peak, ['channelPeaks', index]));
  if (value.peakLinear !== Math.max(value.channelPeaks[0].peakLinear, value.channelPeaks[1].peakLinear))
    fail(['peakLinear'], 'Overall peak must equal the maximum channel peak.');
  if (value.overFullScale !== (value.peakLinear > 1)) fail(['overFullScale'], 'Over-full-scale must match an amplitude strictly greater than one.');
  if (!consistentNumber(value.decodedDurationSeconds, value.sampleFrames / value.sampleRate))
    fail(['decodedDurationSeconds'], 'Duration must match the actual decoded sample-frame count.');
});
export type ExportSamplePeakMeasurement = z.infer<typeof exportSamplePeakMeasurementSchema>;

function reasonSchema<Codes extends [ExportSamplePeakReasonCode, ...ExportSamplePeakReasonCode[]]>(codes: Codes) {
  return z.object({code: z.enum(codes), message: z.string().min(1).max(240)}).strict()
    .refine(value => value.code !== undefined && value.message === reasonMessages[value.code], {message: 'Only the closed safe reason message is permitted.', path: ['message']});
}
const identityFields = {
  projectId: id, exportId: id, algorithm: z.literal(EXPORT_SAMPLE_PEAK_ALGORITHM),
  checkedAt: z.string().max(30).datetime(),
};
const unmeasuredFields = {
  ...identityFields,
  artifact: z.null(), measurement: z.null(),
  checks: z.object({bytesHashed: count(EXPORT_SAMPLE_PEAK_LIMITS.totalHashedBytes), audioFullyDecoded: z.literal(false)}).strict(),
};
export const exportSamplePeakResponseSchema = z.discriminatedUnion('status', [
  z.object({...identityFields, status: z.literal('ready'), artifact: exportSamplePeakArtifactSchema,
    measurement: exportSamplePeakMeasurementSchema, reason: reasonSchema(['OVER_FULL_SCALE']).nullable(),
    checks: z.object({bytesHashed: count(EXPORT_SAMPLE_PEAK_LIMITS.totalHashedBytes), audioFullyDecoded: z.literal(true)}).strict(),
  }).strict(),
  z.object({...unmeasuredFields, status: z.literal('unsupported'),
    reason: reasonSchema(['UNSUPPORTED_FORMAT', 'INPUT_TOO_LARGE', 'DURATION_LIMIT']),
  }).strict(),
  z.object({...unmeasuredFields, status: z.literal('incomplete'),
    reason: reasonSchema(['BUSY', 'TIMEOUT', 'RESOURCE_LIMIT', 'DECODER_UNAVAILABLE', 'INVALID_PCM', 'DECODE_FAILED', 'CANCELLED', 'SHUTDOWN']),
  }).strict(),
  z.object({...unmeasuredFields, status: z.literal('stale'), reason: reasonSchema(['ARTIFACT_CHANGED'])}).strict(),
]).superRefine((value, context) => {
  const fail = (path: (string | number)[], message: string): void =>
    context.addIssue({code: z.ZodIssueCode.custom, path, message});
  if (value.status === 'ready') {
    if (value.checks.bytesHashed !== 2 * value.artifact.sizeBytes)
      fail(['checks', 'bytesHashed'], 'Ready reports require two complete hash passes over the same artifact.');
    if (value.measurement.overFullScale !== (value.reason?.code === 'OVER_FULL_SCALE'))
      fail(['reason'], 'Only an over-full-scale ready measurement carries its advisory.');
    if (value.artifact.exportRange && !isExportSamplePeakFrameCountCompatible(value.measurement.sampleFrames,
        value.artifact.exportRange.endFrame - value.artifact.exportRange.startFrame))
      fail(['measurement', 'decodedDurationSeconds'], 'Decoded duration must match the frozen delivered range.');
  }
  if (encoder.encode(JSON.stringify(value)).byteLength > EXPORT_SAMPLE_PEAK_LIMITS.responseBytes)
    fail([], 'The observation exceeds its response size limit.');
});
export type ExportSamplePeakResponse = z.infer<typeof exportSamplePeakResponseSchema>;

// Only plain JSON data is accepted at the direct-call boundary. Do not invoke
// getters or toJSON while measuring an untrusted response's bounded size.
function boundedResponseData(value: unknown): boolean {
  const ancestors = new Set<object>();
  let nodes = 200;
  function visit(item: unknown, depth: number): boolean {
    if (--nodes < 0 || depth > 8) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') return item.length <= EXPORT_SAMPLE_PEAK_LIMITS.responseBytes;
    if (typeof item !== 'object' || ancestors.has(item)) return false;
    if (Array.isArray(item) && (Object.getPrototypeOf(item) !== Array.prototype || item.length > 2)) return false;
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return false;
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 40) return false;
    if (Array.isArray(item) && keys.length !== item.length + 1) return false;
    for (const key of keys) {
      if (Array.isArray(item) && key === 'length') continue;
      if (typeof key !== 'string') return false;
      if (Array.isArray(item) && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= item.length)) return false;
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || !visit(descriptor.value, depth + 1)) return false;
    }
    ancestors.delete(item);
    return true;
  }
  return visit(value, 0) && encoder.encode(JSON.stringify(value)).byteLength <= EXPORT_SAMPLE_PEAK_LIMITS.responseBytes;
}

export function isExportSamplePeakResponse(value: unknown, input?: unknown): value is ExportSamplePeakResponse {
  try {
    if (!boundedResponseData(value)) return false;
    const parsed = exportSamplePeakResponseSchema.safeParse(value);
    if (!parsed.success) return false;
    if (input === undefined) return true;
    const requested = exportSamplePeakInputSchema.safeParse(input);
    return requested.success && parsed.data.projectId === requested.data.projectId && parsed.data.exportId === requested.data.exportId;
  } catch { return false; }
}

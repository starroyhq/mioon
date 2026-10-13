// A checked consumer of the actual runtime TypeScript module and public subpath.
import {exportSamplePeakInputSchema, exportSamplePeakResponseSchema, isExportSamplePeakResponse,
  exportSamplePeakReason, isExportSamplePeakFrameCountCompatible, EXPORT_SAMPLE_PEAK_ALGORITHM} from '@mioon/contracts/export-sample-peak';
import type {ExportSamplePeakInput, ExportSamplePeakResponse, ExportSamplePeakArtifact,
  ExportSamplePeakMeasurement, ExportSamplePeakReasonCode} from '@mioon/contracts/export-sample-peak';
type IsAny<T> = 0 extends (1 & T) ? true : false;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false : false;
type Expect<T extends true> = T;
type InputIsExact = Expect<Equal<keyof ExportSamplePeakInput, 'projectId' | 'exportId'>>;
type InputParseIsReal = Expect<Equal<ReturnType<typeof exportSamplePeakInputSchema.parse>, ExportSamplePeakInput>>;
type ResponseParseIsReal = Expect<Equal<ReturnType<typeof exportSamplePeakResponseSchema.parse>, ExportSamplePeakResponse>>;
type GuardUnknown = Expect<Equal<Parameters<typeof isExportSamplePeakResponse>[0], unknown>>;
type AlgorithmExact = Expect<Equal<typeof EXPORT_SAMPLE_PEAK_ALGORITHM, 'export-sample-peak-f32le-48k-stereo-v1'>>;
type ResponseNotAny = Expect<Equal<IsAny<ExportSamplePeakResponse>, false>>;
type ArtifactNotAny = Expect<Equal<IsAny<ExportSamplePeakArtifact>, false>>;
type MeasurementNotAny = Expect<Equal<IsAny<ExportSamplePeakMeasurement>, false>>;
type StatesExact = Expect<Equal<ExportSamplePeakResponse['status'], 'ready' | 'unsupported' | 'incomplete' | 'stale'>>;
type StereoExact = Expect<Equal<ExportSamplePeakMeasurement['channels'], 2>>;
type FrameRateExact = Expect<Equal<ExportSamplePeakMeasurement['sampleRate'], 48000>>;
type ChannelOrderExact = Expect<Equal<ExportSamplePeakMeasurement['channelPeaks'][0]['channel'], 0>>;
type ArtifactExact = Expect<Equal<keyof ExportSamplePeakArtifact, 'assetId' | 'sha256' | 'sizeBytes' | 'timelineRevision' | 'deliveryName' | 'exportRange'>>;
type FrameCompatibilityInput = Expect<Equal<Parameters<typeof isExportSamplePeakFrameCountCompatible>, [sampleFrames: number, outputFrames: number]>>;
export function consume(candidate: unknown, input: ExportSamplePeakInput): void {
  // @ts-expect-error Public sample-peak input cannot accept mutation request IDs.
  const invalidInput: ExportSamplePeakInput = {...input, requestId: 'not-a-mutation'};
  // @ts-expect-error There is no caller-provided artifact path.
  input.path;
  const reason = exportSamplePeakReason('OVER_FULL_SCALE');
  const reasonCode: 'OVER_FULL_SCALE' = reason.code;
  // @ts-expect-error Closed reason codes cannot carry arbitrary process output.
  const invalidCode: ExportSamplePeakReasonCode = 'SECRET_PATH';
  if (isExportSamplePeakResponse(candidate, input)) {
    const response: ExportSamplePeakResponse = candidate;
    if (response.status === 'ready') {
      const artifact: ExportSamplePeakArtifact = response.artifact;
      const measurement: ExportSamplePeakMeasurement = response.measurement;
      const complete: true = response.checks.audioFullyDecoded;
      const advisory: 'OVER_FULL_SCALE' | undefined = response.reason?.code;
      // @ts-expect-error A complete measurement never contains arbitrary channels.
      const mono: 1 = measurement.channels;
      // @ts-expect-error Artifact DTO never exposes paths or probe output.
      artifact.path;
      void [artifact, measurement, complete, advisory, mono];
    } else {
      const noMeasurement: null = response.measurement;
      const noArtifact: null = response.artifact;
      const incomplete: false = response.checks.audioFullyDecoded;
      void [noMeasurement, noArtifact, incomplete];
    }
  }
  void [invalidInput, reasonCode, invalidCode];
}

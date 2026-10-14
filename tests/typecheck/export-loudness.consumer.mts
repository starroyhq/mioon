import {EXPORT_LOUDNESS_PROFILE, exportLoudnessInputSchema, isExportLoudnessResponse} from '@mioon/contracts/export-loudness';
import type {ExportLoudnessInput, ExportLoudnessResponse, ExportLoudnessMeasurement} from '@mioon/contracts/export-loudness';
type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2) ? true:false;
type Expect<T extends true> = T;
type NotAny<T> = 0 extends (1 & T) ? false:true;
type InputExact = Expect<Equal<keyof ExportLoudnessInput,'projectId'|'exportId'|'expectedArtifactSha256'|'measurementProfile'|'target'>>;
type InputReal = Expect<Equal<ReturnType<typeof exportLoudnessInputSchema.parse>,ExportLoudnessInput>>;
type OutputChecked = Expect<NotAny<ExportLoudnessResponse>>;
type MeasurementChecked = Expect<NotAny<ExportLoudnessMeasurement>>;
type ProfileExact = Expect<Equal<typeof EXPORT_LOUDNESS_PROFILE,'bs1770-5-48k-stereo-fir4x-v1'>>;
type GateStates = Expect<Equal<ExportLoudnessMeasurement['state'],'valid'|'digital_silence'|'too_short'|'below_gate'>>;
export function consume(input: ExportLoudnessInput, value: unknown): void {
  // @ts-expect-error Reading a file never grants a caller-controlled path.
  input.path;
  // @ts-expect-error No mutation request key or normalization permission.
  const request: ExportLoudnessInput = {...input,requestId:'new-write'};
  // @ts-expect-error Current profile does not support arbitrary sample rates.
  const rate: ExportLoudnessMeasurement['sampleRate'] = 44100;
  if (isExportLoudnessResponse(value,input)) {
    const report: ExportLoudnessResponse = value;
    if (report.status === 'ready') {
      const data: ExportLoudnessMeasurement = report.measurement;
      const hash: string = report.artifact.sha256;
      if (report.suggestion) {
        const cannotApply: false = report.suggestion.applyAllowed;
        // @ts-expect-error A measured file suggestion never authorizes editing.
        const apply: true = report.suggestion.applyAllowed;
        void [cannotApply,apply];
      }
      void [data,hash];
    } else {
      const absent: null = report.measurement;
      void absent;
    }
  }
  void [request,rate];
}

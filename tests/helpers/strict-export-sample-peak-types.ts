import type {readySamplePeak} from './export-sample-peak-fixture.ts';
import {fixture as originalFixture, context as originalContext, row as originalRow, asset as originalAsset, report as originalReport} from './export-sample-peak-ui-fixture.ts';
import type {ExportSamplePeakContext, ExportSamplePeakReadOptions, ExportSamplePeakTarget} from '../../apps/web/src/export-sample-peak-state.ts';
import type {FixtureExport} from './strict-timeline-core-types.ts';

type Ready = ReturnType<typeof readySamplePeak>;
export type SamplePeakReportFixture = Omit<Ready, 'algorithm' | 'artifact' | 'measurement' | 'reason' | 'checks'> & {
  algorithm: string;
  artifact: Ready['artifact'] & {deliveryName?: string; exportRange?: {startFrame: number; endFrame: number}};
  measurement: Omit<Ready['measurement'], 'channelPeaks'> & {channelPeaks: Ready['measurement']['channelPeaks'] & {path?: string}};
  reason: {code: string; message: string} | null;
  checks: Ready['checks'] & {probe?: unknown};
  path?: string; requestId?: string; extra?: string; toJSON?: () => unknown; loop?: unknown;
};
interface OutputAsset {id: string; projectId: string; url: string; mimeType: string; provenance: string; sha256: string; sizeBytes: number}
export const row = originalRow as unknown as (n?: number, fields?: Record<string, unknown>) => FixtureExport;
export const asset = originalAsset as unknown as (item: Pick<FixtureExport, 'assetId' | 'url'>) => OutputAsset;
export const context = originalContext as unknown as (patch?: Record<string, unknown>) => ExportSamplePeakContext & {exports: FixtureExport[]; assets: OutputAsset[]};
export const report = originalReport as unknown as (target: ExportSamplePeakTarget, peak?: number, right?: number) => SamplePeakReportFixture;
type OriginalFixture = ReturnType<typeof originalFixture>;
export type SamplePeakFixture = Omit<OriginalFixture, 'calls' | 'target' | 'ready'> & {
  calls: {input: {projectId: string; exportId: string}; options: ExportSamplePeakReadOptions}[];
  target(index?: number): ExportSamplePeakTarget;
  ready(value?: unknown, index?: number): Promise<ReturnType<OriginalFixture['state']>>;
};
// These views preserve the exact existing fixture functions and runtime values.
export const fixture = originalFixture as unknown as (patch?: Record<string, unknown>) => SamplePeakFixture;

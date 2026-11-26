import {AsyncLocalStorage} from 'node:async_hooks';
import {performance} from 'node:perf_hooks';

export const BUILD_COMMAND_TIMING_STAGES = Object.freeze([
  'typecheck-foundation', 'typecheck-browser', 'typecheck-tests-runtime', 'typecheck-tests-media', 'web-bundle', 'desktop-build',
] as const);
export const DESKTOP_TYPECHECK_TIMING_STAGES = Object.freeze([
  'desktop-typecheck-foundation', 'desktop-typecheck-browser', 'desktop-typecheck-tests-runtime', 'desktop-typecheck-tests-media',
] as const);
export const BUILD_TIMING_STAGES = Object.freeze([
  ...BUILD_COMMAND_TIMING_STAGES, ...DESKTOP_TYPECHECK_TIMING_STAGES,
  'desktop-builder-config', 'desktop-web-validation', 'desktop-staging-reset',
  'desktop-main-bundle', 'desktop-backend-bundle', 'desktop-project-catalog-bundle',
  'desktop-cli-runtime-bundles',
  'desktop-preload-bundle', 'desktop-resource-staging', 'desktop-native-staging', 'desktop-license-staging',
] as const);
export type BuildTimingStage = typeof BUILD_TIMING_STAGES[number];
export interface BuildHeapEvidence {
  readonly peakOldSpaceBytes: number;
  readonly maxOldSpaceBytes: number;
  readonly peakHeapUsedBytes?: number;
  readonly peakRssBytes?: number;
  /** Peak old space as a one-decimal percentage of the configured limit. */
  readonly percent: number;
  readonly warning: boolean;
}
export interface BuildTimingRecord {
  readonly schema: 1;
  readonly stage: BuildTimingStage;
  readonly durationMs: number;
  readonly result: 'success' | 'failed';
  readonly exitCode?: number;
  readonly heap?: BuildHeapEvidence;
}
interface TimingOptions<T> {
  readonly exitCode?: (value: T) => number;
  readonly now?: () => number;
  readonly report?: (record: BuildTimingRecord) => void;
  /** Called after the run finishes; must return undefined rather than throw. */
  readonly heap?: () => BuildHeapEvidence | undefined;
}
const desktopTypecheckTiming = new AsyncLocalStorage<boolean>();

/** This scope changes observation only. Standalone typecheck retains its exact
 * commands and output, and no inherited environment value can enable a scope. */
export function withDesktopTypecheckTiming<T>(run: () => Promise<T>): Promise<T> {
  return desktopTypecheckTiming.run(true, run);
}
export function hasDesktopTypecheckTiming(): boolean {return desktopTypecheckTiming.getStore() === true;}

/** Emit only fixed stage identifiers and numeric outcomes. Child argv, paths,
 * environment and exception details never enter the machine-readable record. */
export async function measureBuildStage<T>(stage: BuildTimingStage, run: () => Promise<T>, options: TimingOptions<T> = {}): Promise<T> {
  if (!(BUILD_TIMING_STAGES as readonly string[]).includes(stage)) throw new Error('Unknown build timing stage.');
  const now = options.now ?? (() => performance.now());
  const report = options.report ?? (record => process.stdout.write(`BUILD_TIMING ${JSON.stringify(record)}\n`));
  const started = now();
  let result: BuildTimingRecord['result'] = 'failed', exitCode: number | undefined;
  try {
    const value = await run();
    exitCode = options.exitCode?.(value);
    result = exitCode === undefined || exitCode === 0 ? 'success' : 'failed';
    return value;
  } finally {
    const heap = (() => {try {return options.heap?.();} catch {return undefined;}})();
    report({schema: 1, stage, durationMs: Math.max(0, Math.round(now() - started)), result,
      ...(exitCode === undefined ? {} : {exitCode}), ...(heap ? {heap} : {})});
  }
}

/** Validate a probe measurement and derive the visible margin. Values are
 * bounded integers so a corrupt evidence file cannot fake a healthy build. */
export function heapEvidence(measurement: {peakOldSpaceBytes: number; maxOldSpaceBytes: number; peakHeapUsedBytes?: number; peakRssBytes?: number}): BuildHeapEvidence {
  const {peakOldSpaceBytes, maxOldSpaceBytes} = measurement;
  if (!Number.isSafeInteger(peakOldSpaceBytes) || peakOldSpaceBytes < 0 || !Number.isSafeInteger(maxOldSpaceBytes) || maxOldSpaceBytes <= 0) throw new Error('Invalid build heap evidence.');
  const optional = (value: number | undefined): number | undefined => Number.isSafeInteger(value) && value! >= 0 ? value : undefined;
  const percent = Math.round((peakOldSpaceBytes / maxOldSpaceBytes) * 1000) / 10;
  return {peakOldSpaceBytes, maxOldSpaceBytes, percent, warning: percent > 80,
    ...(optional(measurement.peakHeapUsedBytes) === undefined ? {} : {peakHeapUsedBytes: optional(measurement.peakHeapUsedBytes)!}),
    ...(optional(measurement.peakRssBytes) === undefined ? {} : {peakRssBytes: optional(measurement.peakRssBytes)!})};
}

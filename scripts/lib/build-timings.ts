import {AsyncLocalStorage} from 'node:async_hooks';
import {performance} from 'node:perf_hooks';

export const BUILD_COMMAND_TIMING_STAGES = Object.freeze([
  'typecheck-foundation', 'typecheck-browser', 'typecheck-tests', 'web-bundle', 'desktop-build',
] as const);
export const DESKTOP_TYPECHECK_TIMING_STAGES = Object.freeze([
  'desktop-typecheck-foundation', 'desktop-typecheck-browser', 'desktop-typecheck-tests',
] as const);
export const BUILD_TIMING_STAGES = Object.freeze([
  ...BUILD_COMMAND_TIMING_STAGES, ...DESKTOP_TYPECHECK_TIMING_STAGES,
  'desktop-builder-config', 'desktop-web-validation', 'desktop-staging-reset',
  'desktop-main-bundle', 'desktop-backend-bundle', 'desktop-project-catalog-bundle',
  'desktop-preload-bundle', 'desktop-resource-staging', 'desktop-native-staging', 'desktop-license-staging',
] as const);
export type BuildTimingStage = typeof BUILD_TIMING_STAGES[number];
export interface BuildTimingRecord {
  readonly schema: 1;
  readonly stage: BuildTimingStage;
  readonly durationMs: number;
  readonly result: 'success' | 'failed';
  readonly exitCode?: number;
}
interface TimingOptions<T> {
  readonly exitCode?: (value: T) => number;
  readonly now?: () => number;
  readonly report?: (record: BuildTimingRecord) => void;
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
    report({schema: 1, stage, durationMs: Math.max(0, Math.round(now() - started)), result,
      ...(exitCode === undefined ? {} : {exitCode})});
  }
}

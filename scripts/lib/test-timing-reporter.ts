/**
 * Node test reporter that records how long each test file took, for balancing CI shards. It runs beside the
 * TAP or spec reporter (see `--timings` in docs/PORTABLE-TOOLING.md) and writes only file paths and seconds.
 *
 * With process isolation Node reports every file as a top-level test named by its path; that test's duration
 * covers module loading and all of the file's tests.
 */
import path from 'node:path';

interface ReporterEvent { type: string; data?: { name?: unknown; nesting?: unknown; file?: unknown; details?: { duration_ms?: unknown } } }

export function fileDuration(event: ReporterEvent, cwd: string = process.cwd()): [string, number] | null {
  const data = event.data;
  if (event.type !== 'test:complete' || !data || data.nesting !== 0 || typeof data.name !== 'string' || typeof data.file !== 'string') return null;
  if (path.resolve(cwd, data.name) !== path.resolve(data.file)) return null;
  const milliseconds = data.details?.duration_ms;
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) return null;
  return [path.relative(cwd, data.file).split(path.sep).join('/'), Math.round(milliseconds / 10) / 100];
}

export default async function* testTimingReporter(source: AsyncIterable<ReporterEvent>): AsyncGenerator<string> {
  const files = new Map<string, number>();
  for await (const event of source) {
    const entry = fileDuration(event);
    if (entry) files.set(entry[0], entry[1]);
  }
  const sorted = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  yield `${JSON.stringify({schema: 1, unit: 'seconds', files: Object.fromEntries(sorted)}, null, 1)}\n`;
}

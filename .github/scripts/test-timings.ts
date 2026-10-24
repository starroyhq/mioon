// Refreshes .github/test-timings.json, which balances the Linux full-test shards, from the per-file timings a
// CI run uploads with each shard's proof:
//   gh run download <run-id> --pattern 'checks-linux-*-coverage' --dir <directory>
//   node .github/scripts/test-timings.ts <directory>
import {readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {discoverTests} from '../../scripts/lib/local-tooling.ts';
import {TIMINGS_FILE, parseTestTimings} from './test-shard.ts';

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return Math.round((sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2) * 100) / 100;
};
/**
 * A file's time is the median of its recorded time and every new measurement, so one noisy run (files share
 * CPUs) cannot swing the partition. Files no run measured keep theirs; deleted tests drop out.
 */
export function mergeTestTimings(previous: string, reports: readonly string[], catalog: readonly string[]): string {
  const samples = new Map([...parseTestTimings(previous)].map(([file, seconds]) => [file, [seconds]]));
  for (const report of reports) for (const [file, seconds] of parseTestTimings(report)) samples.set(file, [...samples.get(file) ?? [], seconds]);
  const known = new Set(catalog);
  const kept = [...samples].filter(([file]) => known.has(file)).map(([file, values]) => [file, median(values)] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (kept.length === 0) throw new Error('NO_TEST_TIMINGS');
  return `${JSON.stringify({schema: 1, unit: 'seconds', files: Object.fromEntries(kept)}, null, 1)}\n`;
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (args.length !== 1 || !args[0]) {console.error('Usage: node .github/scripts/test-timings.ts <downloaded-artifacts-directory>'); return 1;}
  const root = fileURLToPath(new URL('../../', import.meta.url)), directory = path.resolve(args[0]);
  const found = (await readdir(directory, {recursive: true})).filter(entry => /^timings(?:-alone)?\.json$/.test(path.basename(entry)));
  if (found.length === 0) {console.error('No timings.json files found.'); return 1;}
  const reports = await Promise.all(found.map(entry => readFile(path.join(directory, entry), 'utf8')));
  const target = path.join(root, TIMINGS_FILE), catalog = await discoverTests(root, {suite: 'full', platform: 'linux'});
  const merged = mergeTestTimings(await readFile(target, 'utf8'), reports, catalog);
  await writeFile(target, merged);
  console.log(`Updated ${TIMINGS_FILE} from ${found.length} timing files.`);
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => {process.exitCode = code;}).catch(error => {console.error(String(error instanceof Error ? error.message : error)); process.exitCode = 1;});
}

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/** Reviewed live sources: files the frozen-source harnesses (agent gain
 * preservation, restore integrity) depend on but that keep changing on main.
 * Each is pinned to its exact current bytes in
 * tests/fixtures/reviewed-live-sources.json. Changing one is allowed but must be
 * explicit: review the change, then run
 *   node tests/helpers/reviewed-live-sources.ts --update
 * and commit the new pin together with the change.
 * Frozen historical modules are not listed here; their harnesses keep pinning
 * them to their historical bytes. Do not add per-change inverse patches. */
interface Pin {bytes: number; sha256: string}
interface PinFile {formatVersion: 1; note: string; files: Record<string, Pin>}
const fixture = new URL('../fixtures/reviewed-live-sources.json', import.meta.url);
const root = new URL('../../', import.meta.url);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const reviewedLiveSources: PinFile = JSON.parse(readFileSync(fixture, 'utf8'));

export const isReviewedLiveSource = (file: string): boolean => Object.hasOwn(reviewedLiveSources.files, file);

export function assertReviewedLiveSource(file: string, bytes: Uint8Array, label = `Reviewed live source changed: ${file}`): void {
  const pin = reviewedLiveSources.files[file];
  assert.ok(pin, `${file}: not a reviewed live source`);
  const hint = `${label}. Review the change, then run \`node tests/helpers/reviewed-live-sources.ts --update\` and commit the new pin.`;
  assert.equal(bytes.byteLength, pin.bytes, hint);
  assert.equal(sha256(bytes), pin.sha256, hint);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--update')) {
  const files = Object.fromEntries(Object.keys(reviewedLiveSources.files).sort().map(file => {
    const bytes = readFileSync(new URL(file, root));
    return [file, {bytes: bytes.byteLength, sha256: sha256(bytes)}];
  }));
  writeFileSync(fixture, JSON.stringify({...reviewedLiveSources, files}, null, 2) + '\n');
}

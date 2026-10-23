import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertReviewedLiveSource, isReviewedLiveSource, reviewedLiveSources} from './helpers/reviewed-live-sources.ts';

const root = new URL('../', import.meta.url);
const read = (file: string): Buffer => readFileSync(new URL(file, root));
const json = (file: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`fixtures/${file}`, import.meta.url), 'utf8'));
const files = Object.keys(reviewedLiveSources.files);

test('every reviewed live source matches its pin, and the pin file stays sorted', () => {
  assert.equal(reviewedLiveSources.formatVersion, 1);
  assert.ok(files.length > 0);
  assert.deepEqual(files, [...files].sort());
  for (const file of files) {
    const pin = reviewedLiveSources.files[file]!;
    assert.match(pin.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(pin.bytes) && pin.bytes > 0);
    assertReviewedLiveSource(file, read(file));
  }
});

test('a pin refuses added, changed and removed bytes and unlisted files', () => {
  const file = 'packages/contracts/src/index.ts', bytes = read(file);
  assert.ok(isReviewedLiveSource(file));
  assert.equal(isReviewedLiveSource('packages/contracts/src/not-a-live-source.ts'), false);
  const changed = Buffer.from(bytes); changed[0] = changed[0]! ^ 1;
  for (const drift of [Buffer.concat([bytes, Buffer.from('\n')]), bytes.subarray(1), changed])
    assert.throws(() => assertReviewedLiveSource(file, drift), /node tests\/helpers\/reviewed-live-sources\.ts --update/);
  assert.throws(() => assertReviewedLiveSource('packages/contracts/src/not-a-live-source.ts', bytes), /not a reviewed live source/);
});

test('every reviewed live source is a dependency of a frozen-source harness', () => {
  // Pins exist only for sources the opacity, agent-gain and restore-integrity
  // harnesses read; anything else is not frozen evidence and needs no pin.
  const opacity = json('opacity-current-ts-runtime-map.json').mapping as Record<string, {currentPath: string}>;
  const opacityManifest = json('opacity-envelope-frozen-baseline.json').sha256 as Record<string, string>;
  const gain = json('agent-gain-ts-migration-map.json').mapping as Record<string, {currentPath: string}>;
  const guard = json('workspace-restore-integrity/frozen-sources.json') as {fixedDependencyClosure: Record<string, unknown>; constructorSources: Record<string, unknown>};
  const guardMap = json('workspace-restore-integrity/ts-migration-map.json').entries as Record<string, {currentPath: string}>;
  const used = new Set([
    ...Object.keys(opacityManifest).map(file => opacity[file]?.currentPath ?? file),
    ...Object.values(gain).map(entry => entry.currentPath),
    ...[...Object.keys(guard.fixedDependencyClosure), ...Object.keys(guard.constructorSources)].map(file => guardMap[file]?.currentPath ?? file),
  ]);
  for (const file of files) assert.ok(used.has(file), `${file}: pinned but no frozen-source harness reads it`);
});

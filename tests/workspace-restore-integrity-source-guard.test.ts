import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {assertReviewedLiveSource, isReviewedLiveSource} from './helpers/reviewed-live-sources.ts';

// These expected bytes were extracted once with git show from the accepted
// commit. This test neither invokes git nor regenerates fixtures or hashes.
const baseline = 'dc7a057d582c0ef2a6c5316939f6b42be8735987';
const root = new URL('../', import.meta.url);
const manifestBytes = readFileSync(new URL('fixtures/workspace-restore-integrity/frozen-sources.json', import.meta.url));
interface FrozenEntry {bytes: number; sha256: string}
interface FrozenManifest {formatVersion: number; sourceCommit: string; constructorFiles: string[]; constructorSources: Record<string, FrozenEntry>; fixedDependencyClosure: Record<string, FrozenEntry>; goldenFixtures: Record<string, FrozenEntry>; excludedRelativeImports: Record<string, string>; relativeImportEdges: Record<string, string[]>}
const manifest = JSON.parse(manifestBytes.toString('utf8')) as FrozenManifest;
const sha256 = (bytes: Buffer|string) => createHash('sha256').update(bytes).digest('hex');
interface MigrationEntry {legacyPath: string; currentPath: string; mode: 'raw'|'type-erased'; currentBytes: number; currentSha256: string; legacyBytes: number; legacySha256: string}
interface MigrationMap {formatVersion: number; sourceCommit: string; constructorFiles: string[]; entries: Record<string, MigrationEntry>}
const migration = JSON.parse(readFileSync(new URL('fixtures/workspace-restore-integrity/ts-migration-map.json', import.meta.url), 'utf8')) as MigrationMap;
const migratedPath = (file: string): string => migration.entries[file]?.currentPath ?? (file.endsWith('.mjs') && (() => { try { readFileSync(new URL(file.replace(/\.mjs$/, '.ts'), root)); return true; } catch { return false; } })() ? file.replace(/\.mjs$/, '.ts') : file);
const migratedSignature = (file: string, override?: Buffer): {bytes: Buffer; sha256: string; byteLength: number} => {
  const entry = migration.entries[file];
  if (!entry) { const bytes = readFileSync(new URL(file, root)); return {bytes, byteLength: bytes.byteLength, sha256: sha256(bytes)}; }
  const raw = override ?? readFileSync(new URL(entry.currentPath, root));
  const bytes = entry.mode === 'type-erased' ? Buffer.from(transformSync(raw.toString('utf8'), {loader: 'ts', format: 'esm', target: 'es2022'}).code) : raw;
  return {bytes, byteLength: bytes.byteLength, sha256: sha256(bytes)};
};
const constructors = [
  'packages/business/src/workspace-restore-schema.ts',
  ...[27, 29, 31, 33, 35, 37, 39].map(version => `packages/business/src/workspace-restore-schema-v${version}.ts`),
];

test('historical source manifest is pinned to the accepted baseline, not candidate output', () => {
  assert.equal(sha256(manifestBytes), '15f27f6fb3de6b04a1b6c313950d30b06f1c8172fd73349423c368288bc072cf');
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.sourceCommit, baseline);
  assert.deepEqual(migration.constructorFiles, constructors);
  assert.deepEqual(manifest.constructorFiles.map(migratedPath), migration.constructorFiles);
  assert.deepEqual(Object.keys(manifest.constructorSources).map(migratedPath), constructors);
  assert.equal(Object.keys(manifest.fixedDependencyClosure).length, 45);
  assert.equal(Object.keys(manifest.goldenFixtures).length, 21);
  assert.deepEqual(Object.keys(manifest.excludedRelativeImports).map(migratedPath), ['packages/business/src/db.ts']);
});

function assertFrozenSource(file: string, expected: FrozenEntry, override?: Buffer): void {
  assert.match(file, /^(?:packages|tests)\//);
  assert.ok(!file.split('/').includes('..'));
  const entry = migration.entries[file];
  if (entry) {
    // Historical manifest values stay authoritative and unchanged; the map
    // documents the renamed current source and its deterministic signature.
    assert.equal(entry.legacyPath, file);
    assert.equal(entry.legacyBytes, expected.bytes);
    assert.equal(entry.legacySha256, expected.sha256);
    assert.match(entry.currentPath, /^(?:packages|tests)\//);
    // Dependencies that keep changing on main are pinned to their reviewed current bytes.
    if (isReviewedLiveSource(entry.currentPath)) { assertReviewedLiveSource(entry.currentPath, override ?? readFileSync(new URL(entry.currentPath, root)), `${file}: reviewed live dependency`); return; }
    const current = migratedSignature(file, override);
    assert.equal(current.byteLength, entry.currentBytes, `${file}: current migrated byte count`);
    assert.equal(current.sha256, entry.currentSha256, `${file}: current migrated signature`);
    return;
  }
  if (isReviewedLiveSource(file)) { assertReviewedLiveSource(file, override ?? readFileSync(new URL(file, root)), `${file}: reviewed live dependency`); return; }
  const actual = override ?? readFileSync(new URL(file, root));
  assert.equal(actual.byteLength, expected.bytes, `${file}: baseline byte count`);
  assert.equal(sha256(actual), expected.sha256, `${file}: frozen ${baseline} SHA256`);
}

for (const [group, entries] of Object.entries({
  constructor: manifest.constructorSources,
  'fixed initializer, constant and validation dependency': manifest.fixedDependencyClosure,
  'independent historical golden fixture': manifest.goldenFixtures,
})) {
  for (const [file, expected] of Object.entries(entries as Record<string, FrozenEntry>)) {
    test(`${group} remains byte-exact: ${file}`, () => {
      assertFrozenSource(file, expected);
    });
  }
}

test('reviewed live dependencies match their pins and refuse deformed, deleted, duplicate and unknown bytes', () => {
  const live = Object.entries(manifest.fixedDependencyClosure).filter(([file]) => isReviewedLiveSource(migratedPath(file)));
  assert.ok(live.length > 0, 'the closure includes reviewed live dependencies');
  for (const [file, expected] of live) {
    const source = readFileSync(new URL(migratedPath(file), root), 'utf8');
    assertFrozenSource(file, expected);
    for (const changed of [source.slice(1), source + source, source + '\n// unknown raw bytes must not disappear through type erasure\n', source + '\nimport "./not-a-frozen-dependency.ts";\n'])
      assert.throws(() => assertFrozenSource(file, expected, Buffer.from(changed)), `${file}: only the reviewed bytes are accepted`);
  }
});

test('the fixed-source snapshot covers every recorded relative import except verified-store runtime wiring', () => {
  const pinned = new Set([...Object.keys(manifest.constructorSources), ...Object.keys(manifest.fixedDependencyClosure)].map(migratedPath));
  assert.deepEqual([...pinned].sort(), Object.keys(manifest.relativeImportEdges).map(migratedPath).sort());
  for (const [file, dependencies] of Object.entries(manifest.relativeImportEdges)) {
    for (const dependency of dependencies) {
      assert.ok(pinned.has(migratedPath(dependency)) || Object.hasOwn(manifest.excludedRelativeImports, dependency), `${file} -> ${dependency}`);
    }
  }
});

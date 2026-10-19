import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';

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
const migratedSignature = (file: string): {bytes: Buffer; sha256: string; byteLength: number} => {
  const entry = migration.entries[file];
  if (!entry) { const bytes = readFileSync(new URL(file, root)); return {bytes, byteLength: bytes.byteLength, sha256: sha256(bytes)}; }
  const raw = readFileSync(new URL(entry.currentPath, root));
  const bytes = entry.mode === 'type-erased' ? Buffer.from(transformSync(raw.toString('utf8'), {loader: 'ts', format: 'esm', target: 'es2022'}).code) : raw;
  return {bytes, byteLength: bytes.byteLength, sha256: sha256(bytes)};
};
function historicalBytes(file: string, bytes: Buffer): Buffer {
  // Only the two new restored profiles gain LUT reads; old profiles, import
  // refusal and every other dependency byte remain pinned to the old manifest.
  const changes = file === 'packages/contracts/src/lut-resources.ts' ? [
    ['schemaVersion===39||schemaVersion===41||schemaVersion===45||schemaVersion===49', 'schemaVersion===39||schemaVersion===41'],
  ] : file === 'packages/contracts/src/agent-timeline-gain.ts' ? [
    ["import {timelineOutputPreset} from './timeline-output-geometry.ts';\n\n", ''],
    ['  // Share the closed native/legacy output set with private timeline targets.\n  // Neither projection may invent a geometry or normalize saved dimensions.\n', '  // This public selected projection admits only the three existing 30fps output\n  // pairs. Private targets additionally pass the canonical timeline validator.\n'],
    ['value.fps === 30 && timelineOutputPreset(value) !== null &&', 'value.fps === 30 && (value.width === 720 && (value.height === 720 || value.height === 1280) || value.width === 1280 && value.height === 720) &&'],
  ] : [];
  let source = bytes.toString('utf8');
  for (const [after, before] of changes) {
    assert.equal(source.split(after).length - 1, 1, `${file}: one exact reviewed integration delta`);
    source = source.replace(after, before);
  }
  return changes.length ? Buffer.from(source) : bytes;
}
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

for (const [group, entries] of Object.entries({
  constructor: manifest.constructorSources,
  'fixed initializer, constant and validation dependency': manifest.fixedDependencyClosure,
  'independent historical golden fixture': manifest.goldenFixtures,
})) {
  for (const [file, expected] of Object.entries(entries as Record<string, FrozenEntry>)) {
    test(`${group} remains byte-exact: ${file}`, () => {
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
        const current = migratedSignature(file);
        assert.equal(current.byteLength, entry.currentBytes, `${file}: current migrated byte count`);
        assert.equal(current.sha256, entry.currentSha256, `${file}: current migrated signature`);
        return;
      }
      const actual = historicalBytes(file, readFileSync(new URL(file, root)));
      assert.equal(actual.byteLength, expected.bytes, `${file}: baseline byte count`);
      assert.equal(sha256(actual), expected.sha256, `${file}: frozen ${baseline} SHA256`);
    });
  }
}

test('the fixed-source snapshot covers every recorded relative import except verified-store runtime wiring', () => {
  const pinned = new Set([...Object.keys(manifest.constructorSources), ...Object.keys(manifest.fixedDependencyClosure)].map(migratedPath));
  assert.deepEqual([...pinned].sort(), Object.keys(manifest.relativeImportEdges).map(migratedPath).sort());
  for (const [file, dependencies] of Object.entries(manifest.relativeImportEdges)) {
    for (const dependency of dependencies) {
      assert.ok(pinned.has(migratedPath(dependency)) || Object.hasOwn(manifest.excludedRelativeImports, dependency), `${file} -> ${dependency}`);
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

// These expected bytes were extracted once with git show from the accepted
// commit. This test neither invokes git nor regenerates fixtures or hashes.
const baseline = 'dc7a057d582c0ef2a6c5316939f6b42be8735987';
const root = new URL('../', import.meta.url);
const manifestBytes = readFileSync(new URL('fixtures/workspace-restore-integrity/frozen-sources.json', import.meta.url));
const manifest = JSON.parse(manifestBytes);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function historicalBytes(file, bytes) {
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
  assert.deepEqual(manifest.constructorFiles, constructors);
  assert.deepEqual(Object.keys(manifest.constructorSources), constructors);
  assert.equal(Object.keys(manifest.fixedDependencyClosure).length, 45);
  assert.equal(Object.keys(manifest.goldenFixtures).length, 21);
  assert.deepEqual(Object.keys(manifest.excludedRelativeImports), ['packages/business/src/db.ts']);
});

for (const [group, entries] of Object.entries({
  constructor: manifest.constructorSources,
  'fixed initializer, constant and validation dependency': manifest.fixedDependencyClosure,
  'independent historical golden fixture': manifest.goldenFixtures,
})) {
  for (const [file, expected] of Object.entries(entries)) {
    test(`${group} remains byte-exact: ${file}`, () => {
      assert.match(file, /^(?:packages|tests)\//);
      assert.ok(!file.split('/').includes('..'));
      const actual = historicalBytes(file, readFileSync(new URL(file, root)));
      assert.equal(actual.byteLength, expected.bytes, `${file}: baseline byte count`);
      assert.equal(sha256(actual), expected.sha256, `${file}: frozen ${baseline} SHA256`);
    });
  }
}

test('the fixed-source snapshot covers every recorded relative import except verified-store runtime wiring', () => {
  const pinned = new Set([...Object.keys(manifest.constructorSources), ...Object.keys(manifest.fixedDependencyClosure)]);
  assert.deepEqual([...pinned].sort(), Object.keys(manifest.relativeImportEdges).sort());
  for (const [file, dependencies] of Object.entries(manifest.relativeImportEdges)) {
    for (const dependency of dependencies) {
      assert.ok(pinned.has(dependency) || Object.hasOwn(manifest.excludedRelativeImports, dependency), `${file} -> ${dependency}`);
    }
  }
});

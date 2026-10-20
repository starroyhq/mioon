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
// b3ce8bf adds ephemeral LRA/target observations and explicitly keeps their new
// fields out of old backup evidence. Undo only those finite, unique source
// blocks before applying every unchanged historical/migration pin below.
interface Inverse {before: string; after: string}
const loudnessRangeInverses: Readonly<Record<string, readonly Inverse[]>> = Object.freeze({
  'packages/business/src/workspace-volume-envelope-validation.ts': [
    {before: '', after: `// Historical workspace profiles admit the original observation shape only.
// New ephemeral LRA/target candidates do not extend old backup evidence.
const historicalClipLoudness=(value:Record<string,unknown>):boolean=>
 !['loudnessRange','target','candidate'].some(key=>own(value,key))&&isTimelineClipLoudnessResponse(value);
`},
    {before: 'if(!isTimelineClipLoudnessResponse(value)&&!isTimelineMixLoudnessResponse(value))invalid(true);', after: 'if(!historicalClipLoudness(value)&&!isTimelineMixLoudnessResponse(value))invalid(true);'},
  ],
  'packages/contracts/src/timeline-clip-loudness.ts': [
    {before: `import {EXPORT_LOUDNESS_PROFILE, EXPORT_LOUDNESS_LIMITS, exportLoudnessMeasurementSchema} from './export-loudness.ts';
`, after: `import {EXPORT_LOUDNESS_PROFILE, EXPORT_LOUDNESS_LIMITS, exportLoudnessMeasurementSchema, exportLoudnessTargetSchema, EXPORT_LOUDNESS_ADVISORY_MARGIN_DB} from './export-loudness.ts';
import {loudnessRangeMeasurementSchema} from './loudness-range.ts';
`},
    {before: `export const timelineClipLoudnessInputSchema = z.object({projectId: id, timelineId: id,
  expectedRevision: count(Number.MAX_SAFE_INTEGER, 1), clipId: id, expectedAssetSha256: hash,
  measurementProfile: z.literal(EXPORT_LOUDNESS_PROFILE)}).strict();
export type TimelineClipLoudnessInput = z.infer<typeof timelineClipLoudnessInputSchema>;
export const timelineClipLoudnessSchemas = Object.freeze({[TIMELINE_CLIP_LOUDNESS_OPERATION]: timelineClipLoudnessInputSchema});
export const timelineClipLoudnessResponseSchema = z.object({...timelineClipLoudnessInputSchema.shape,
`, after: `const inputShape = {projectId: id, timelineId: id,
  expectedRevision: count(Number.MAX_SAFE_INTEGER, 1), clipId: id, expectedAssetSha256: hash,
  measurementProfile: z.literal(EXPORT_LOUDNESS_PROFILE), target: exportLoudnessTargetSchema.optional()};
export const timelineClipLoudnessInputSchema = z.object(inputShape).strict().superRefine((value, context) => {
  if (Object.hasOwn(value, 'target') && value.target === undefined)
    context.addIssue({code: z.ZodIssueCode.custom, path: ['target'], message: 'Omit an unselected target.'});
});
export type TimelineClipLoudnessInput = z.infer<typeof timelineClipLoudnessInputSchema>;
export const timelineClipLoudnessSchemas = Object.freeze({[TIMELINE_CLIP_LOUDNESS_OPERATION]: timelineClipLoudnessInputSchema});
export const TIMELINE_CLIP_LOUDNESS_TARGET_TOLERANCE_LU = 0.1;
const candidateCommon = {beforeGain: z.number().finite().positive().max(2),
  marginDb: z.literal(EXPORT_LOUDNESS_ADVISORY_MARGIN_DB), applyAllowed: z.literal(false)};
export const timelineClipLoudnessCandidateSchema = z.discriminatedUnion('status', [
  z.object({...candidateCommon, status: z.literal('unavailable'), reason: z.enum(['NO_VALID_LOUDNESS', 'GAIN_OUT_OF_RANGE']),
    requiredGainDb: z.number().finite().nullable(), gainMultiplier: z.number().finite().positive().nullable(),
    afterGain: z.null(), measurement: z.null(), measuredPcmBytes: z.literal(0), meetsTarget: z.literal(false), meetsTruePeak: z.literal(false)}).strict(),
  z.object({...candidateCommon, status: z.literal('measured'), reason: z.null(), requiredGainDb: z.number().finite(),
    gainMultiplier: z.number().finite().positive(), afterGain: z.number().finite().positive().max(2),
    measurement: exportLoudnessMeasurementSchema, measuredPcmBytes: count(TIMELINE_CLIP_LOUDNESS_LIMITS.pcmBytes, 12800),
    meetsTarget: z.boolean(), meetsTruePeak: z.boolean()}).strict(),
]);
export type TimelineClipLoudnessCandidate = z.infer<typeof timelineClipLoudnessCandidateSchema>;
export const timelineClipLoudnessResponseSchema = z.object({...inputShape,
  loudnessRange: loudnessRangeMeasurementSchema.optional(), candidate: timelineClipLoudnessCandidateSchema.optional(),
`},
    {before: '', after: `  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(b));
  // Small valid gains require relative comparison; an absolute floor would
  // allow orders-of-magnitude changes to a quiet candidate's saved gain.
  const nearPositive = (a: number, b: number) => a === b || Math.abs(a - b) <= 1e-10 * Math.max(Math.abs(a), Math.abs(b));
  if (Object.hasOwn(v, 'target') && v.target === undefined || Object.hasOwn(v, 'candidate') && v.candidate === undefined ||
      Boolean(v.target) !== Boolean(v.candidate)) fail('An explicit target and its measured candidate must occur together.');
  if (Object.hasOwn(v, 'loudnessRange') && (!v.loudnessRange || v.loudnessRange.sampleFrames !== v.measurement.sampleFrames || v.loudnessRange.samplePeakLinear !== v.measurement.samplePeakLinear))
    fail('Loudness range must describe the complete same decoded clip.');
  if (v.target && v.candidate) {
    const candidate = v.candidate, original = v.measurement;
    if (candidate.beforeGain !== i.gain) fail('Candidate must bind the saved gain.');
    const valid = original.state === 'valid' && original.integratedLufs !== null;
    if (!valid) {
      if (candidate.status !== 'unavailable' || candidate.reason !== 'NO_VALID_LOUDNESS' || candidate.requiredGainDb !== null || candidate.gainMultiplier !== null)
        fail('Unqualified audio cannot produce a gain candidate.');
    } else {
      const required = v.target.integratedLufs - original.integratedLufs!, multiplier = 10 ** (required / 20), afterGain = i.gain * multiplier;
      if (candidate.requiredGainDb === null || candidate.gainMultiplier === null || !near(candidate.requiredGainDb, required) || !nearPositive(candidate.gainMultiplier, multiplier))
        fail('Candidate arithmetic must bind the explicit target.');
      if (candidate.status === 'unavailable') {
        if (candidate.reason !== 'GAIN_OUT_OF_RANGE' || Number.isFinite(afterGain) && afterGain > 0 && afterGain <= 2)
          fail('Only an unsupported saved gain can reject a valid signal before measurement.');
      } else {
        const measured = candidate.measurement;
        if (!nearPositive(candidate.afterGain, afterGain) || measured.sampleFrames !== original.sampleFrames || candidate.measuredPcmBytes !== v.checks.pcmBytes ||
            measured.samplePeakLinear !== Math.fround(original.samplePeakLinear * multiplier))
          fail('Candidate must measure every scaled clip sample with the exact supported gain.');
        if (candidate.meetsTarget !== (measured.state === 'valid' && measured.integratedLufs !== null &&
            Math.abs(measured.integratedLufs - v.target.integratedLufs) <= TIMELINE_CLIP_LOUDNESS_TARGET_TOLERANCE_LU) ||
            candidate.meetsTruePeak !== (measured.truePeakDbtp !== null && measured.truePeakDbtp <= v.target.truePeakCeilingDbtp - EXPORT_LOUDNESS_ADVISORY_MARGIN_DB))
          fail('Candidate target and true-peak qualification must match the actual second measurement.');
      }
    }
  }

`},
    {before: `    return request.success && Object.entries(request.data).every(([key, val]) => parsed.data[key as keyof TimelineClipLoudnessInput] === val);
`, after: `    return request.success && Object.entries(request.data).every(([key, val]) => key === 'target' ? Boolean(parsed.data.target && val && typeof val === 'object' && parsed.data.target.integratedLufs === (val as {integratedLufs: number}).integratedLufs && parsed.data.target.truePeakCeilingDbtp === (val as {truePeakCeilingDbtp: number}).truePeakCeilingDbtp) : parsed.data[key as keyof TimelineClipLoudnessInput] === val) && Boolean(parsed.data.target) === Boolean(request.data.target);
`},
  ],
});
const reviewedRawMapBytes = readFileSync(new URL('fixtures/opacity-current-ts-runtime-map.json', import.meta.url));
interface RawMigrationEntry {historicalSourceSha256: string; currentRawSha256: string; typeErasedSha256: string}
const reviewedRawMap = JSON.parse(reviewedRawMapBytes.toString('utf8')) as {mapping: Record<string, RawMigrationEntry>};
function reverseReviewedLoudnessRange(file: string, bytes: Buffer): Buffer {
  const inverses = loudnessRangeInverses[file];
  if (!inverses) return bytes;
  let source = bytes.toString('utf8');
  for (const inverse of inverses) {
    assert.equal(source.split(inverse.after).length - 1, 1, `${file}: reviewed LRA inverse must match exactly once`);
    source = source.replace(inverse.after, inverse.before);
  }
  const restored = Buffer.from(source);
  if (file === 'packages/business/src/workspace-volume-envelope-validation.ts') {
    // Reuse the independently frozen pre-LRA raw pin as well as this guard's
    // erased migration pin; an added comment must not disappear through esbuild.
    assert.equal(sha256(reviewedRawMapBytes), '6b846bfa47f9aab5be39fbdc9d37e6055680dd9efcb20c69742ebe03e42553c5');
    const rawPin = reviewedRawMap.mapping[file];
    assert.equal(rawPin.historicalSourceSha256, manifest.fixedDependencyClosure[file].sha256);
    assert.equal(rawPin.typeErasedSha256, migration.entries[file].currentSha256);
    assert.equal(restored.byteLength, 16620, `${file}: unchanged accepted typed source byte count`);
    assert.equal(sha256(restored), rawPin.currentRawSha256, `${file}: unchanged accepted typed source raw SHA256`);
  }
  return restored;
}
const migratedPath = (file: string): string => migration.entries[file]?.currentPath ?? (file.endsWith('.mjs') && (() => { try { readFileSync(new URL(file.replace(/\.mjs$/, '.ts'), root)); return true; } catch { return false; } })() ? file.replace(/\.mjs$/, '.ts') : file);
const migratedSignature = (file: string, override?: Buffer): {bytes: Buffer; sha256: string; byteLength: number} => {
  const entry = migration.entries[file];
  if (!entry) { const bytes = readFileSync(new URL(file, root)); return {bytes, byteLength: bytes.byteLength, sha256: sha256(bytes)}; }
  const raw = reverseReviewedLoudnessRange(file, override ?? readFileSync(new URL(entry.currentPath, root)));
  const bytes = entry.mode === 'type-erased' ? Buffer.from(transformSync(raw.toString('utf8'), {loader: 'ts', format: 'esm', target: 'es2022'}).code) : raw;
  return {bytes, byteLength: bytes.byteLength, sha256: sha256(bytes)};
};
function historicalBytes(file: string, bytes: Buffer): Buffer {
  bytes = reverseReviewedLoudnessRange(file, bytes);
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
    const current = migratedSignature(file, override);
    assert.equal(current.byteLength, entry.currentBytes, `${file}: current migrated byte count`);
    assert.equal(current.sha256, entry.currentSha256, `${file}: current migrated signature`);
    return;
  }
  const actual = historicalBytes(file, override ?? readFileSync(new URL(file, root)));
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

test('finite LRA inverses preserve old signatures and refuse deformed, deleted, duplicate and unknown bytes', () => {
  assert.deepEqual(Object.keys(loudnessRangeInverses).sort(), ['packages/business/src/workspace-volume-envelope-validation.ts', 'packages/contracts/src/timeline-clip-loudness.ts'].sort());
  for (const [file, inverses] of Object.entries(loudnessRangeInverses)) {
    const expected = manifest.fixedDependencyClosure[file];
    const source = readFileSync(new URL(migration.entries[file]?.currentPath ?? file, root), 'utf8');
    assertFrozenSource(file, expected);
    for (const inverse of inverses) {
      for (const changed of [
        source.replace(inverse.after, inverse.after.slice(0, -1) + 'X'),
        source.replace(inverse.after, ''),
        source.replace(inverse.after, inverse.after + inverse.after),
        source + '\n// unknown raw bytes must not disappear through type erasure\n',
        source + '\nimport "./not-a-frozen-dependency.ts";\n',
      ]) assert.throws(() => assertFrozenSource(file, expected, Buffer.from(changed)), `${file}: only the exact reviewed source change is accepted`);
    }
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

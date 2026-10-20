import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {transformSync} from 'esbuild';
import {
  OPACITY_ORDINARY_SCHEMA_CANDIDATE, OPACITY_RESTORED_SCHEMA_CANDIDATE, OPACITY_RESTORED_PROFILE_CANDIDATE,
  OPACITY_ORDINARY_CANDIDATE_MARKERS, OPACITY_RESTORED_CANDIDATE_MARKERS,
  captureWorkspaceOpacityCandidateProfile as capture, isWorkspaceOpacityCandidateMarkerEvidence as markerEvidence,
} from '../packages/contracts/src/workspace-opacity-candidate.ts';
import {workspaceBackupSourceSchemaVersion, workspaceRestorationPairSchema} from '../packages/contracts/src/workspace-schema-profiles.ts';
import {readCurrentWorkspaceRole} from '../packages/business/src/workspace-schema-dispatch.ts';

const ordinary = {schemaVersion: 42, profile: 'ordinary'};
const restored = {schemaVersion: 43, sourceSchema: 42, profile: 'restored-local-v10'};
const root = new URL('../', import.meta.url);

test('only explicit dormant42/43 descriptors are accepted, with no numeric inheritance', () => {
  assert.deepEqual([OPACITY_ORDINARY_SCHEMA_CANDIDATE, OPACITY_RESTORED_SCHEMA_CANDIDATE, OPACITY_RESTORED_PROFILE_CANDIDATE], [42, 43, 'restored-local-v10']);
  for (const value of [ordinary, restored]) {
    const before = JSON.stringify(value), result = capture(value);
    assert.deepEqual(result, value); assert.notEqual(result, value); assert.equal(Object.isFrozen(result), true); assert.equal(JSON.stringify(value), before);
  }
  for (const version of [25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,44,100])
    for (const value of [{...ordinary, schemaVersion: version}, {...restored, schemaVersion: version}]) assert.throws(() => capture(value));
  for (const value of [{...ordinary, sourceSchema: 40}, {...ordinary, writable: true}, {...restored, sourceSchema: 40}, {...restored, profile: 'restored-local-v9'},
    {...restored, executionAllowed: true}, {...restored, schemaVersion: '43'}, {}, [], null]) assert.throws(() => capture(value));
});

test('marker evidence has exact chains, excludes historical restored markers, and grants no authority', () => {
  for (const [profile, expected] of [[ordinary, OPACITY_ORDINARY_CANDIDATE_MARKERS], [restored, OPACITY_RESTORED_CANDIDATE_MARKERS]]) {
    assert.equal(markerEvidence(profile, [...expected]), true);
    assert.equal(Object.isFrozen(expected), true);
    for (const values of [expected.slice(1), [...expected, 999], [...expected].reverse(), [...expected, 41], new Array(expected.length),
      Object.assign([...expected], {writable: true}), expected.map((value, i) => i === 0 ? '1' : value)]) assert.equal(markerEvidence(profile, values), false);
  }
  assert.equal(markerEvidence(ordinary, OPACITY_RESTORED_CANDIDATE_MARKERS), false);
  assert.equal(markerEvidence(restored, OPACITY_ORDINARY_CANDIDATE_MARKERS), false);
  assert.equal(workspaceBackupSourceSchemaVersion.safeParse(42).success, false);
  assert.equal(workspaceRestorationPairSchema.safeParse({profile: 'restored-local-v10', sourceSchema: 42, databaseSchemaVersion: 43}).success, false);
  assert.equal(workspaceBackupSourceSchemaVersion.safeParse(40).success, true);
  assert.equal(workspaceRestorationPairSchema.safeParse({profile: 'restored-local-v9', sourceSchema: 40, databaseSchemaVersion: 41}).success, true);
});

test('hostile candidate descriptors and marker arrays execute no getter or proxy trap', () => {
  let calls = 0;
  const trap = () => {calls++; throw Error('must not execute');};
  const handler = {get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap};
  const getter = {...ordinary}; Object.defineProperty(getter, 'schemaVersion', {enumerable: true, get: trap});
  for (const value of [getter, new Proxy(ordinary, handler), Object.assign(Object.create({}), ordinary)]) assert.throws(() => capture(value));
  const markers = [...OPACITY_ORDINARY_CANDIDATE_MARKERS]; Object.defineProperty(markers, '0', {enumerable: true, get: trap});
  assert.equal(markerEvidence(ordinary, markers), false);
  assert.equal(markerEvidence(ordinary, new Proxy([...OPACITY_ORDINARY_CANDIDATE_MARKERS], handler)), false);
  assert.equal(calls, 0);
});

test('production dispatcher continues refusing42/43 marker evidence without writing', t => {
  for (const markers of [OPACITY_ORDINARY_CANDIDATE_MARKERS, OPACITY_RESTORED_CANDIDATE_MARKERS]) {
    const db = new DatabaseSync(':memory:'); t.after(() => db.close());
    db.exec('CREATE TABLE schema_version(version INTEGER PRIMARY KEY)');
    const statement = db.prepare('INSERT INTO schema_version VALUES(?)');
    for (const version of markers) statement.run(version);
    const before = db.prepare('SELECT * FROM schema_version ORDER BY version').all(), catalog = db.prepare('SELECT * FROM sqlite_schema').all();
    assert.throws(() => readCurrentWorkspaceRole(db), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
    assert.deepEqual(db.prepare('SELECT * FROM schema_version ORDER BY version').all(), before);
    assert.deepEqual(db.prepare('SELECT * FROM sqlite_schema').all(), catalog);
    assert.equal(db.isTransaction, false);
  }
});

test('historical25–41 pins survive only finite reviewed integration deltas and the approved renderer seam', t => {
  const manifestBytes = readFileSync(new URL('./fixtures/opacity-envelope-frozen-baseline.json', import.meta.url));
  const manifest = JSON.parse(manifestBytes);
  const exception = JSON.parse(readFileSync(new URL('./fixtures/opacity-render-seam-exception.json', import.meta.url), 'utf8'));
  const deltaBytes = readFileSync(new URL('./fixtures/mioon-redesign-reviewed-source-deltas.json', import.meta.url));
  const deltas = JSON.parse(deltaBytes);
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  const currentMapBytes=readFileSync(new URL('./fixtures/opacity-current-ts-runtime-map.json',import.meta.url));
  const currentMap=JSON.parse(currentMapBytes);
  assert.equal(sha256(currentMapBytes),'6b846bfa47f9aab5be39fbdc9d37e6055680dd9efcb20c69742ebe03e42553c5');
  assert.equal(currentMap.historicalSourceCommit,'49a548f0f2974d209696c7264760dbd9eff4ba56');
  assert.equal(currentMap.baselineCommit,'b8d6f4e7897d0d32aeb07749a6605637787de4f6');
  assert.equal(currentMap.baselineManifestSha256,sha256(manifestBytes));assert.equal(Object.keys(currentMap.mapping).length,27);
  const gitSource=(commit,file)=>execFileSync('git',['show',`${commit}:${file}`],{cwd:root,maxBuffer:1024*1024,timeout:5000});
  assert.equal(sha256(deltaBytes), '4b7aaad5681fdd50b3b1841a868aa85d2cfff4a5f83175f2bcbfa842158e033a', 'the independently reviewable finite delta ledger is pinned');
  assert.equal(deltas.formatVersion, 1);
  assert.equal(deltas.baseline, manifest.baseline);
  assert.equal(deltas.baselineManifestSha256, sha256(manifestBytes));
  const reviewedPaths = [
    'packages/business/src/local-drafts.ts', 'packages/business/src/timeline-inputs.mjs',
    'packages/business/src/timeline-media.mjs', 'packages/business/src/workspace-backup-schema-versions.ts',
    'packages/business/src/workspace-restore-invocation.mjs', 'packages/business/src/workspace-restore-policy.mjs',
    'packages/business/src/workspace-schema-dispatch.ts', 'packages/contracts/src/index.mjs',
    'packages/contracts/src/timeline-acknowledgement.mjs', 'packages/contracts/src/workspace-schema-profiles.ts',
  ];
  assert.deepEqual(deltas.files.map(item => item.path).sort(), reviewedPaths.sort());
  function reverseReviewed(file, bytes, expected) {
    const delta = deltas.files.find(item => item.path === file);
    if (!delta) return bytes;
    assert.equal(delta.beforeSha256, expected, `${file}: existing historical pin is authoritative`);
    assert.equal(bytes.byteLength, delta.afterBytes, `${file}: reviewed current byte count`);
    assert.equal(sha256(bytes), delta.afterSha256, `${file}: exact reviewed integration source`);
    assert.ok(delta.review.length > 40 && delta.inverse.length > 0);
    let source = bytes.toString('utf8');
    for (const inverse of [...delta.inverse].reverse()) {
      assert.equal(inverse.occurrences, 1);
      assert.ok(inverse.after.length > 0);
      assert.equal(source.split(inverse.after).length - 1, inverse.occurrences, `${file}: exact unique inverse snippet`);
      source = source.replace(inverse.after, inverse.before);
    }
    const restoredBytes = Buffer.from(source);
    assert.equal(restoredBytes.byteLength, delta.beforeBytes, `${file}: restored historical byte count`);
    assert.equal(sha256(restoredBytes), expected, `${file}: finite inverse must recover the unchanged historical hash`);
    return restoredBytes;
  }
  assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), '7381ed3486563b84cf4f4912dfde81ae07b0369cde4e479ad2b1bcfd88633f0d', 'original64-file baseline manifest stays byte-identical');
  assert.equal(manifest.baseline, '812d18a9d493f01f94235bd4f424b4e17e742ad8');
  assert.equal(exception.baseline, manifest.baseline);
  assert.equal(exception.baselineManifestSha256, '7381ed3486563b84cf4f4912dfde81ae07b0369cde4e479ad2b1bcfd88633f0d');
  assert.equal(exception.path, 'packages/business/src/timeline-media.mjs');
  assert.equal(exception.beforeSha256, 'b89728d7508ea1ca0d2011c3fad710722411993bd8a0989553167733bf343dde');
  assert.equal(manifest.sha256[exception.path], exception.beforeSha256);
  assert.match(exception.afterSha256, /^[a-f0-9]{64}$/u, 'approved renderer result has a recorded final hash');
  assert.notEqual(exception.afterSha256, exception.beforeSha256);
  const directory = 'packages/business/src/';
  for (const name of readdirSync(new URL(directory, root))) {
    if (/^workspace-(?:restore-)?schema-v(?:2[6-9]|3[0-9]|4[01])\.ts$/.test(name)) assert.ok(manifest.sha256[directory + name], `missing frozen module ${name}`);
  }
  let unchanged = 0, rawUnchanged = 0;
  for (const [path, expected] of Object.entries(manifest.sha256)) {
    const pinned = path === exception.path ? exception.afterSha256 : expected;
    // Execute the unchanged finite inverses on the accepted pre-migration
    // bytes; current typed sources have their own reviewed drift checks below.
    const bytes = gitSource(currentMap.historicalSourceCommit,path);
    assert.equal(sha256(reverseReviewed(path, bytes, pinned)), pinned, path);
    const mapping=currentMap.mapping[path],currentPath=mapping?.currentPath??path,currentBytes=readFileSync(new URL(currentPath,root));
    const assertCurrent=value=>{
      assert.equal(sha256(value),mapping?.currentRawSha256??sha256(bytes),`${path}: current raw source`);
      if(mapping?.typeErasedSha256!==null&&mapping?.typeErasedSha256!==undefined)assert.equal(sha256(transformSync(value.toString('utf8'),{loader:'ts',format:'esm',target:'es2022'}).code),mapping.typeErasedSha256,`${path}: current executable source`);
    };
    if(mapping){assert.equal(mapping.historicalSourceSha256,sha256(bytes));assert.equal(mapping.baselineRawSha256,sha256(gitSource(currentMap.baselineCommit,currentPath)));assert.ok(mapping.authorization.length>40);}
    assertCurrent(currentBytes);
    assert.throws(()=>assertCurrent(Buffer.concat([currentBytes,Buffer.from('\n')])),'any unreviewed current byte drift must fail');
    if (sha256(bytes) === expected) rawUnchanged++;
    if (path !== exception.path) unchanged++;
  }
  assert.equal(Object.keys(manifest.sha256).length, 64);
  assert.equal(unchanged, 63); assert.equal(exception.unchangedBaselineFiles, unchanged);
  assert.equal(rawUnchanged, 54);
  t.diagnostic('Fixed49a548f source:54 original files retain raw SHA-256 bytes; ten finite inverse deltas recover all63 dependency pins and the approved renderer seam. Original64-file manifest unchanged; current typed/runtime sources independently pinned with byte-drift negative cases');
});

test('candidate modules remain absent from production exports, startup, operations and permissions', () => {
  for (const path of ['packages/contracts/package.json', 'packages/contracts/src/index.ts', 'packages/business/src/db.ts',
    'packages/business/src/workspace-schema-dispatch.ts', 'packages/business/src/workspace-restore-policy.ts',
    'packages/business/src/timeline-inputs.ts']) {
    const raw = readFileSync(new URL(path, root), 'utf8');
    const source=path.endsWith('.ts')?transformSync(raw,{loader:'ts',format:'esm',target:'es2022'}).code:raw;
    assert.equal(/(?:timeline-opacity|workspace-opacity|local-drafts-opacity|opacityEnvelope)/u.test(source), false, path);
  }
  const renderer = readFileSync(new URL('packages/business/src/timeline-media.ts', root), 'utf8');
  assert.match(renderer, /import\s*\{getTimelineOpacityRenderBinding\}\s*from\s*'\.\/timeline-opacity-render-binding\.ts'/u, 'the renderer exception uses only a fixed internal binding getter');
  assert.equal(/workspace-opacity|local-drafts-opacity/u.test(renderer), false, 'renderer does not select workspace/draft capabilities');
});

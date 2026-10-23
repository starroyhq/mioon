import {reverseReviewedWanVideo} from './helpers/current-wan-video-delta.ts';
import {reverseReviewedSchema56,reviewedSchema56SourceDeltas} from './helpers/current-schema56-delta.ts';
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
import {reviewedSchema54SourceDeltas,reviewedSchema54IntegrationSourceDeltas,reverseReviewedSchema54} from './helpers/current-schema54-delta.ts';

const ordinary = {schemaVersion: 42, profile: 'ordinary'};
const restored = {schemaVersion: 43, sourceSchema: 42, profile: 'restored-local-v10'};
const root = new URL('../', import.meta.url);
const cliDeltaBytes = readFileSync(new URL('./fixtures/agent-cli-reviewed-source-deltas.json', import.meta.url));
const cliDeltas = JSON.parse(cliDeltaBytes);
// This guard only closes the legacy Windows draft path. Reverse that exact
// addition; dormant opacity profiles and every previous source pin stay fixed.
function reverseReviewedCliDraft(file, bytes) {
  if (file !== 'packages/business/src/local-drafts.ts') return bytes;
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  assert.equal(sha256(cliDeltaBytes), '46376e8cbbb647cd28790fdfbebfc795cb462cbe180d918ff12df160af491398');
  const entries = cliDeltas.files.filter(item => item.path === file); assert.equal(entries.length, 1);
  const delta = entries[0]; assert.equal(delta.inverse.length, 1);
  assert.equal(bytes.byteLength, delta.afterBytes); assert.equal(sha256(bytes), delta.afterSha256, `${file}: exact reviewed Windows draft guard`);
  let source = bytes.toString('utf8');
  for (const inverse of delta.inverse) {
    assert.equal(inverse.before, ''); assert.equal(inverse.occurrences, 1); assert.ok(inverse.after.length > 0);
    assert.equal(source.split(inverse.after).length - 1, 1, `${file}: unique Windows guard inverse`);
    source = source.replace(inverse.after, inverse.before);
  }
  const previous = Buffer.from(source);
  assert.equal(previous.byteLength, delta.beforeBytes); assert.equal(sha256(previous), delta.beforeSha256);
  return previous;
}
// The reviewed origin/main integration adds the video catalog and harness v2
// (ordinary52/restored53). Pin every byte of these eight changed current files,
// then compare their fixed PR12 predecessors against all unchanged old pins.
// This is a finite source exception, never a new historical schema admission.
const integrationPredecessor = '927aafdc5546d03db62e69c43ae12cd10f5229a5';
const integrationSources = Object.freeze({
  'packages/business/src/db.mjs': {currentPath: 'packages/business/src/db.ts', currentSha256: '828ad0f57179b5090fd0a650780bf31765974f957c27bd41d8532b14be85d2cb', previousSha256: '451859250034f5815d79bf163c361c9bce19790ef0f711e6531c3a0a2cf746e9'},
  'packages/business/src/timeline-media.mjs': {currentPath: 'packages/business/src/timeline-media.ts', currentSha256: 'f4150ce725c187ef0c207a8dd613434e766acf96fbd343942862bf1f01a88aad', previousSha256: '375cb4bafbaf0bc7a7bfd1c24a8d886b7d9324434d3baec57d5bc4ff07bcd077'},
  'packages/business/src/workspace-backup-schema-versions.ts': {currentPath: 'packages/business/src/workspace-backup-schema-versions.ts', currentSha256: '021c38a7cdf49cef1124d5d5da8b13c5fd9893b2517abda66a15bfa4890b70d3', previousSha256: 'cac9cdd13b04626f0777983a8c534f8498477fca49cd7da8f92e41fae6b3a4eb'},
  'packages/business/src/workspace-restore-policy.mjs': {currentPath: 'packages/business/src/workspace-restore-policy.ts', currentSha256: '12574f7afd166d7425dafefa6b5dfed948aefe93cba4bce5b4e2295c0428737e', previousSha256: '8683ddb6dc93eca25089e3d4bac5c82af03e5d9c0adf6bf59c04207fbdfdd5d6'},
  'packages/business/src/workspace-schema-dispatch.ts': {currentPath: 'packages/business/src/workspace-schema-dispatch.ts', currentSha256: '28fe444cf9a6eabeb2b451547c34e80c222069322728348c8d0d095a4e86a62e', previousSha256: '18dd2a80aaa411663bd113c709cf2d9eeb853c4b1a91f47d27099172f50fb9f8'},
  'packages/contracts/package.json': {currentPath: 'packages/contracts/package.json', currentSha256: '834f278da97be115249aa5b8e86236f680b2fa782d331c63fca78a3f5c756bed', previousSha256: '12cb351d4bad13e927cb2bd405da725fad8453932b6f24a7232eebd30edee4ae'},
  'packages/contracts/src/index.mjs': {currentPath: 'packages/contracts/src/index.ts', currentSha256: '5296d7009a373567cfde38dd390416b1e8e126a713e6b6020a019af6b76797d6', previousSha256: '4394194a7d1cde7b91a67b14860a2dd9a9101ff3da08e4ca744dd980caba5978'},
  'packages/contracts/src/workspace-schema-profiles.ts': {currentPath: 'packages/contracts/src/workspace-schema-profiles.ts', currentSha256: '43805de996bd3754e775707ed0b2d6431540c5048eeee21e43218b28e5e03b32', previousSha256: '38fe74b67b20359d3241fb33c21c3fb280171ae4ebd82d6e3b64612428d16df0'},
});
function reverseReviewedIntegration(file, bytes) {
  const reviewed = integrationSources[file];
  if (!reviewed) return bytes;
  bytes = reverseReviewedSchema54(reviewed.currentPath, bytes);
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  assert.equal(sha256(bytes), reviewed.currentSha256, `${file}: exact reviewed main integration source`);
  const previous = execFileSync('git', ['show', `${integrationPredecessor}:${reviewed.currentPath}`], {cwd: root, maxBuffer: 1024 * 1024, timeout: 5000});
  assert.equal(sha256(previous), reviewed.previousSha256, `${file}: unchanged fixed predecessor source`);
  return previous;
}
// b3ce8bf added clip LRA exports and narrowed historical loudness admission.
// Reverse only these exact unique additions when comparing the unchanged
// current-runtime pins; historical bytes and classifier tests remain intact.
const loudnessRangeInverses = Object.freeze({
  'packages/business/src/workspace-volume-envelope-validation.ts': Object.freeze([
    {before: '', after: '// Historical workspace profiles admit the original observation shape only.\n// New ephemeral LRA/target candidates do not extend old backup evidence.\nconst historicalClipLoudness=(value:Record<string,unknown>):boolean=>\n ![\'loudnessRange\',\'target\',\'candidate\'].some(key=>own(value,key))&&isTimelineClipLoudnessResponse(value);\n'},
    {before: 'if(!isTimelineClipLoudnessResponse(value)&&!isTimelineMixLoudnessResponse(value))invalid(true);', after: 'if(!historicalClipLoudness(value)&&!isTimelineMixLoudnessResponse(value))invalid(true);'},
  ]),
  'packages/contracts/package.json': Object.freeze([
    {before: '', after: '    "./loudness-range": "./src/loudness-range.ts",\n'},
  ]),
  'packages/contracts/src/index.mjs': Object.freeze([
    {before: '', after: "export * from './loudness-range.ts';\n"},
  ]),
});
function reverseReviewedLoudnessRange(file, bytes) {
  const inverses = loudnessRangeInverses[file];
  if (!inverses) return bytes;
  let source = bytes.toString('utf8');
  for (const inverse of inverses) {
    assert.equal(source.split(inverse.after).length - 1, 1, `${file}: reviewed loudness-range inverse must match exactly once`);
    source = source.replace(inverse.after, inverse.before);
  }
  return Buffer.from(source);
}

// The compatible video service (OpenAI video format) adds one provider ID to
// generation.submit and to its connection-only rule. Reverse exactly these two
// unique additions; every other current byte of the contract stays pinned.
const compatibleVideoInverses = Object.freeze({
  'packages/contracts/src/index.mjs': Object.freeze([
    {before: "providerId:z.enum(['mock','runway','ark','veo','minimax','vidu','kling','wan']),", after: "providerId:z.enum(['mock','runway','ark','veo','minimax','vidu','kling','wan','compatible']),"},
    {before: "!has&&['kling','wan'].includes(value.providerId)", after: "!has&&['kling','wan','compatible'].includes(value.providerId)"},
  ]),
});
function reverseReviewedCompatibleVideo(file, bytes) {
  // Undo newer Wan bytes first; keep this older inverse and all its pins intact.
  bytes = reverseReviewedWanVideo(file === 'packages/contracts/src/index.mjs' ? 'packages/contracts/src/index.ts' : file, bytes);
  const inverses = compatibleVideoInverses[file];
  if (!inverses) return bytes;
  let source = bytes.toString('utf8');
  for (const inverse of inverses) {
    assert.equal(source.split(inverse.after).length - 1, 1, `${file}: reviewed compatible-video inverse must match exactly once`);
    source = source.replace(inverse.after, inverse.before);
  }
  return Buffer.from(source);
}

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
      const reviewed=reverseReviewedLoudnessRange(path,reverseReviewedIntegration(path,reverseReviewedCompatibleVideo(path,reverseReviewedCliDraft(path,value))));
      assert.equal(sha256(reviewed),mapping?.currentRawSha256??sha256(bytes),`${path}: current raw source`);
      if(mapping?.typeErasedSha256!==null&&mapping?.typeErasedSha256!==undefined)assert.equal(sha256(transformSync(reviewed.toString('utf8'),{loader:'ts',format:'esm',target:'es2022'}).code),mapping.typeErasedSha256,`${path}: current executable source`);
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

test('finite LRA inverses preserve all prior raw/runtime pins and reject changed, duplicated or unknown additions', () => {
  const map = JSON.parse(readFileSync(new URL('./fixtures/opacity-current-ts-runtime-map.json', import.meta.url))).mapping;
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  for (const [file, inverses] of Object.entries(loudnessRangeInverses)) {
    const mapping = map[file], bytes = readFileSync(new URL(mapping.currentPath, root)), source = bytes.toString('utf8');
    const assertPinned = value => {
      const reviewed = reverseReviewedLoudnessRange(file, reverseReviewedIntegration(file, reverseReviewedCompatibleVideo(file, Buffer.from(value))));
      assert.equal(sha256(reviewed), mapping.currentRawSha256, `${file}: unchanged current raw pin`);
      if (mapping.typeErasedSha256 !== null) assert.equal(sha256(transformSync(reviewed.toString('utf8'), {loader: 'ts', format: 'esm', target: 'es2022'}).code), mapping.typeErasedSha256, `${file}: unchanged executable pin`);
    };
    assertPinned(source);
    for (const inverse of inverses) {
      for (const changed of [source.replace(inverse.after, inverse.after + ' '), source.replace(inverse.after, inverse.after + inverse.after), source.replace(inverse.after, ''), source + '\n// synthetic unreviewed source addition\n']) assert.throws(() => assertPinned(changed));
    }
  }
});

test('finite Windows draft guard inverse retains the original opacity raw/runtime pins and rejects unreviewed bytes', () => {
  const file = 'packages/business/src/local-drafts.ts', sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(cliDeltas.predecessorCommit, '3e5ed71c01ff8d06403e1c4b2cb082cd81e26907');
  assert.equal(cliDeltas.acceptedCommit, '6904a53249a2cdec1ee6a84c8bfb01f8e0056353');
  const before = execFileSync('git', ['show', `${cliDeltas.predecessorCommit}:${file}`], {cwd: root, maxBuffer: 1024 * 1024, timeout: 5000});
  const accepted = execFileSync('git', ['show', `${cliDeltas.acceptedCommit}:${file}`], {cwd: root, maxBuffer: 1024 * 1024, timeout: 5000});
  const mapping = JSON.parse(readFileSync(new URL('./fixtures/opacity-current-ts-runtime-map.json', import.meta.url))).mapping[file];
  assert.equal(sha256(before), mapping.currentRawSha256); assert.deepEqual(reverseReviewedCliDraft(file, accepted), before);
  const source = readFileSync(new URL(file, root), 'utf8'), inverse = cliDeltas.files.find(item => item.path === file).inverse[0];
  const assertPinned = value => {
    const previous = reverseReviewedCliDraft(file, Buffer.from(value));
    assert.equal(sha256(previous), mapping.currentRawSha256);
    assert.equal(sha256(transformSync(previous.toString('utf8'), {loader: 'ts', format: 'esm', target: 'es2022'}).code), mapping.typeErasedSha256);
  };
  assertPinned(source);
  for (const changed of [source.replace(inverse.after, inverse.after + ' '), source.replace(inverse.after, inverse.after + inverse.after), source.replace(inverse.after, ''), source + '\nexport const hiddenOpacityAuthority = true;\n']) assert.throws(() => assertPinned(changed));
});

test('reviewed main integration keeps original current pins and rejects any unknown current source byte', () => {
  assert.deepEqual(Object.keys(integrationSources).sort(), [
    'packages/business/src/db.mjs', 'packages/business/src/timeline-media.mjs',
    'packages/business/src/workspace-backup-schema-versions.ts', 'packages/business/src/workspace-restore-policy.mjs',
    'packages/business/src/workspace-schema-dispatch.ts', 'packages/contracts/package.json',
    'packages/contracts/src/index.mjs', 'packages/contracts/src/workspace-schema-profiles.ts',
  ].sort());
  const map = JSON.parse(readFileSync(new URL('./fixtures/opacity-current-ts-runtime-map.json', import.meta.url))).mapping;
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  for (const [file, reviewed] of Object.entries(integrationSources)) {
    const mapping = map[file], source = readFileSync(new URL(reviewed.currentPath, root), 'utf8');
    assert.equal(reviewed.currentPath, mapping.currentPath);
    const assertPinned = value => {
      const previous = reverseReviewedLoudnessRange(file, reverseReviewedIntegration(file, reverseReviewedCompatibleVideo(file, Buffer.from(value))));
      assert.equal(sha256(previous), mapping.currentRawSha256, `${file}: original current raw pin`);
      if (mapping.typeErasedSha256 !== null) assert.equal(sha256(transformSync(previous.toString('utf8'), {loader: 'ts', format: 'esm', target: 'es2022'}).code), mapping.typeErasedSha256, `${file}: original current executable pin`);
    };
    assertPinned(source);
    for (const changed of ['', source.slice(1), source + source, source + '\n', source + '\n// unknown current bytes\n', source + '\nexport const hiddenOpacityAuthority = true;\n'])
      assert.throws(() => assertPinned(changed), `${file}: deleted, duplicated or unknown bytes must fail before predecessor comparison`);
  }
});

test('finite compatible-video inverse keeps the integration pin and rejects changed, duplicated or unknown additions', () => {
  const map = JSON.parse(readFileSync(new URL('./fixtures/opacity-current-ts-runtime-map.json', import.meta.url))).mapping;
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  for (const [file, inverses] of Object.entries(compatibleVideoInverses)) {
    const mapping = map[file], source = readFileSync(new URL(mapping.currentPath, root), 'utf8');
    const assertPinned = value => {
      const previous = reverseReviewedLoudnessRange(file, reverseReviewedIntegration(file, reverseReviewedCompatibleVideo(file, Buffer.from(value))));
      assert.equal(sha256(previous), mapping.currentRawSha256, `${file}: original current raw pin`);
    };
    assertPinned(source);
    for (const inverse of inverses) {
      assert.equal(source.split(inverse.before).length - 1, 0, `${file}: the reviewed predecessor snippet is no longer present`);
      for (const changed of [source.replace(inverse.after, inverse.after + ' '), source.replace(inverse.after, inverse.after + inverse.after), source.replace(inverse.after, ''), source.replace(inverse.after, inverse.before), source + '\n// synthetic unreviewed source addition\n']) assert.throws(() => assertPinned(changed));
    }
  }
});

test('finite54 profile and dispatch inverses recover the unchanged52 integration source and reject source drift', () => {
  const applicable = [...reviewedSchema54IntegrationSourceDeltas,
    ...reviewedSchema54SourceDeltas.filter(delta => delta.path === 'packages/business/src/workspace-restore-policy.ts')];
  assert.deepEqual(applicable.map(delta => delta.path), [
    'packages/business/src/workspace-backup-schema-versions.ts', 'packages/business/src/workspace-schema-dispatch.ts',
    'packages/contracts/src/workspace-schema-profiles.ts', 'packages/business/src/workspace-restore-policy.ts',
  ]);
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  for (const delta of applicable) {
    const entry = Object.entries(integrationSources).find(([, value]) => value.currentPath === delta.path);
    assert.ok(entry, 'every inverse is an already pinned integration source');
    const [file, reviewed] = entry, source = reverseReviewedSchema56(delta.path,readFileSync(new URL(delta.path, root))).toString('utf8');
    const previous = execFileSync('git', ['show', `4355c0746821dad76622b9fdaaed72400bdc5a92:${delta.path}`], {cwd: root, maxBuffer: 1024 * 1024, timeout: 5000});
    assert.equal(sha256(previous), reviewed.currentSha256, `${file}: existing52 hash remains authoritative`);
    const assertPinned = value => assert.deepEqual(reverseReviewedSchema54(delta.path, Buffer.from(value)), previous);
    assertPinned(source);
    for (const inverse of delta.inverse) {
      for (const changed of [source.replace(inverse.after, inverse.after + ' '), source.replace(inverse.after, inverse.after + inverse.after),
        source.replace(inverse.after, ''), source + '\n// synthetic unreviewed source addition\n'])
        assert.throws(() => assertPinned(changed), `${file}: unknown bytes do not disappear in the54 inverse`);
    }
  }
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

// Reviewed56 admission must reverse byte-exactly before the frozen52 checks.
test('finite56 interaction admission inverses preserve exact54 source pins and reject unknown edits',()=>{
 for(const delta of reviewedSchema56SourceDeltas){
  const source=readFileSync(new URL(delta.path,root),'utf8');
  const previous=execFileSync('git',['show',`8da3340ddd8627fc6be46a33eca52cabda6b4ffb:${delta.path}`],{cwd:root,maxBuffer:1024*1024,timeout:5000});
  assert.deepEqual(reverseReviewedSchema56(delta.path,Buffer.from(source)),previous);
  for(const inverse of delta.inverse){
   for(const changed of [source.replace(inverse.after,inverse.after+' '),source.replace(inverse.after,''),source+'\n// unknown56 addition\n'])
    assert.throws(()=>reverseReviewedSchema56(delta.path,Buffer.from(changed)),`${delta.path}: finite56 inverse rejects drift`);
  }
 }
});

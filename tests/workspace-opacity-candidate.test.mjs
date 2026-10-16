import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
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

test('historical25–41 source, validators, dispatch and raw fixture hashes remain exact', t => {
  const manifest = JSON.parse(readFileSync(new URL('./fixtures/opacity-envelope-frozen-baseline.json', import.meta.url), 'utf8'));
  assert.equal(manifest.baseline, '812d18a9d493f01f94235bd4f424b4e17e742ad8');
  const directory = 'packages/business/src/';
  for (const name of readdirSync(new URL(directory, root))) {
    if (/^workspace-(?:restore-)?schema-v(?:2[6-9]|3[0-9]|4[01])\.ts$/.test(name)) assert.ok(manifest.sha256[directory + name], `missing frozen module ${name}`);
  }
  for (const [path, expected] of Object.entries(manifest.sha256))
    assert.equal(createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex'), expected, path);
  t.diagnostic(`${Object.keys(manifest.sha256).length} committed baseline files retain exact SHA-256 bytes`);
});

test('candidate modules remain absent from production exports, startup, operations and permissions', () => {
  for (const path of ['packages/contracts/package.json', 'packages/contracts/src/index.mjs', 'packages/business/src/db.mjs',
    'packages/business/src/workspace-schema-dispatch.ts', 'packages/business/src/workspace-restore-policy.mjs',
    'packages/business/src/timeline-inputs.mjs', 'packages/business/src/timeline-media.mjs', 'apps/web/src/TimelineInspector.jsx']) {
    const source = readFileSync(new URL(path, root), 'utf8');
    assert.equal(/(?:timeline-opacity|workspace-opacity|local-drafts-opacity|opacityEnvelope)/u.test(source), false, path);
  }
});

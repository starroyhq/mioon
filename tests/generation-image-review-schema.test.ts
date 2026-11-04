import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash, randomUUID} from 'node:crypto';
import {TASK_SCHEMA} from '../packages/business/src/project-file/schema/domains/tasks.ts';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2} from '../packages/contracts/src/generation-image-settings.ts';
import {IMAGE_FIXED_OPTIONS, canonicalImageInput as canonical} from '../packages/contracts/src/images.ts';
import {IMAGE_REVIEW_POLICY, imageReviewIntentSchema} from '../packages/contracts/src/image-reviews.ts';

function fixture(t: import('node:test').TestContext) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const table = (name: string) => {const sql = TASK_SCHEMA.find(value => new RegExp(`^CREATE TABLE "?${name}"?\\(`).test(value)); assert.ok(sql); return sql;};
  db.exec(table('image_tasks')); db.exec(table('image_reviews'));
  const id = randomUUID(), projectId = randomUUID(), connectionId = 'abcdefab-1234-4123-8123-123456789abc';
  const input = {projectId, requestId: randomUUID(), name: 'Native review', providerId: 'openai-compatible',
    model: 'native-model', prompt: 'A synthetic native constraint fixture', options: {...IMAGE_FIXED_OPTIONS}};
  const configuration = {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2, enabled: true, baseUrl: 'https://images.example.com/Proxy/v1', model: input.model,
    options: {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2.options}};
  const intent = {schemaVersion: 6, reviewId: id, input, settingsRevision: 1, connectionId, configurationRevision: 1,
    configuration, destination: configuration.baseUrl + '/images/generations', policy: {...IMAGE_REVIEW_POLICY}};
  function insert(raw = canonical(intent)) {
    const original = canonical(input), sha = (value: string) => createHash('sha256').update(value).digest('hex');
    db.prepare(`INSERT INTO image_reviews(id,projectId,requestId,inputHash,canonicalInput,intentHash,canonicalIntent,state,revision,taskId,postAttempts,createdAt,updatedAt,approvedAt,rejectedAt,dispatchedAt)
      VALUES(?,?,?,?,?,?,?,'pending',1,NULL,0,?,?,NULL,NULL,NULL)`).run(id, projectId, input.requestId, sha(original), original, sha(raw), raw, '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z');
  }
  return {db, input, intent, insert};
}

test('native v6 accepts the exact UUID/revision/configuration/policy and retains original bytes', t => {
  const f = fixture(t); assert.equal(imageReviewIntentSchema.safeParse(f.intent).success, true); f.insert();
  const row = f.db.prepare('SELECT * FROM image_reviews').get()!;
  assert.equal(row.canonicalInput, canonical(f.input)); assert.equal(row.canonicalIntent, canonical(f.intent));
  assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

const mutations: [string, (value: ReturnType<typeof fixture>) => void][] = [
  ['uppercase service UUID', f => {f.intent.connectionId = f.intent.connectionId.toUpperCase();}],
  ['legacy custom identity', f => {f.intent.connectionId = 'custom';}],
  ['configuration revision mismatch', f => {f.intent.configurationRevision++;}],
  ['disabled configuration', f => {f.intent.configuration.enabled = false;}],
  ['different model', f => {f.intent.configuration.model = 'other-model';}],
  ['different options', f => {Object.assign(f.intent.configuration.options, {n: 2});}],
  ['wrong destination', f => {f.intent.destination = 'https://another.example.com/images/generations';}],
  ['unknown root field', f => {Object.assign(f.intent, {credentialRef: randomUUID()});}],
  ['unknown configuration field', f => {Object.assign(f.intent.configuration, {connectionId: 'custom'});}],
  ['unknown policy field', f => {Object.assign(f.intent.policy, {allowRetry: true});}],
  ['unknown input field', f => {Object.assign(f.input, {connectionId: f.intent.connectionId});}],
  ['custom edit input', f => {Object.assign(f.input, {purpose: 'edit', inputImage: {assetId: randomUUID(), sha256: 'a'.repeat(64)}});}],
  ['future version', f => {f.intent.schemaVersion = 7;}],
];
for (const [name, mutate] of mutations) test(`native v6 rejects ${name} without retaining a row`, t => {
  const f = fixture(t); mutate(f); assert.throws(() => f.insert(), /CHECK constraint failed/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM image_reviews').get()!.n, 0);
});

for (const baseUrl of ['https://127.0.0.1/v1', 'https://Images.example.com/v1', 'https://images.example.com:443/v1',
  'https://user@images.example.com/v1', 'https://images.example.com/v1/', 'https://images.example.com/a/../v1',
  'https://images.example.com/a//v1', 'https://images.example.com/v1?q=1', 'https://images.example.com/v1#fragment',
  'https://images.example.com/%61', 'https://images..example.com/v1', `https://${'a'.repeat(64)}.example.com/v1`])
  test(`native v6 rejects a noncanonical destination ${baseUrl}`, t => {
    const f = fixture(t); f.intent.configuration.baseUrl = baseUrl; f.intent.destination = baseUrl + '/images/generations';
    assert.throws(() => f.insert(), /CHECK constraint failed/); assert.equal(f.db.prepare('SELECT count(*) AS n FROM image_reviews').get()!.n, 0);
  });

test('native v6 rejects duplicate semantic keys and noncanonical numeric revision types', t => {
  const f = fixture(t), original = canonical(f.intent);
  for (const raw of [original.replace('"connectionId":', `"connectionId":"${f.intent.connectionId}","connectionId":`),
    original.replace('"schemaVersion":6', '"schemaVersion":6.0'), original.replace('"configurationRevision":1', '"configurationRevision":1.0')])
    assert.throws(() => f.insert(raw), /CHECK constraint failed/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM image_reviews').get()!.n, 0);
});

test('the original v2 custom branch still accepts only its retained literal connection identity', t => {
  const f = fixture(t), {connectionId, configurationRevision, ...old} = f.intent; void connectionId; void configurationRevision;
  const retained = {...old, schemaVersion: 2, configuration: {...f.intent.configuration, connectionId: 'custom'}};
  f.insert(canonical(retained)); assert.equal(f.db.prepare('SELECT count(*) AS n FROM image_reviews').get()!.n, 1);
});

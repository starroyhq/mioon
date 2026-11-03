import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {TASK_SCHEMA} from '../packages/business/src/project-file/schema/domains/tasks.ts';
import {canonicalImageInput, IMAGE_FIXED_OPTIONS, IMAGE_MODELS} from '../packages/contracts/src/images.ts';
import {IMAGE_EDIT_REVIEW_DESTINATION, IMAGE_REVIEW_POLICY} from '../packages/contracts/src/image-reviews.ts';

test('current image review SQL accepts complete previs origin and rejects incomplete or contradictory render facts', () => {
  const db = new DatabaseSync(':memory:');
  try {
    // Pending reviews have no task. Keep their real nullable FK enabled while
    // isolating this table's JSON constraints from the remaining domain DDL.
    db.exec('CREATE TABLE image_tasks(id TEXT PRIMARY KEY)');
    const sql = TASK_SCHEMA.find(value => value.startsWith('CREATE TABLE "image_reviews"(')); assert.ok(sql); db.exec(sql);
    const projectId = randomUUID(), sha256 = 'a'.repeat(64);
    const sourceImage = {assetId: randomUUID(), sha256, mimeType: 'image/png', byteLength: 100, width: 64, height: 96, name: 'K1.png',
      origin: {kind: 'previs-output', publicationId: randomUUID(), previsOutput: {projectId, nodeId: randomUUID(), keyframeId: 'k1', sceneRevision: 2,
        requestId: randomUUID(), name: 'K1.png', sha256, width: 64, height: 96}}};
    const insert = (source: unknown): void => {
      const reviewId = randomUUID(), requestId = randomUUID();
      const input = {projectId, requestId, name: 'Edit previs', prompt: 'Preserve framing', providerId: 'openai', model: IMAGE_MODELS.openai,
        options: IMAGE_FIXED_OPTIONS, purpose: 'edit', inputImage: {assetId: sourceImage.assetId, sha256}};
      const intent = {schemaVersion: 5, reviewId, input, settingsRevision: 1, destination: IMAGE_EDIT_REVIEW_DESTINATION, policy: IMAGE_REVIEW_POLICY, sourceImage: source};
      db.prepare(`INSERT INTO image_reviews(id,projectId,requestId,inputHash,canonicalInput,intentHash,canonicalIntent,state,revision,taskId,postAttempts,createdAt,updatedAt,approvedAt,rejectedAt,dispatchedAt)
        VALUES(?,?,?,?,?,?,?,'pending',1,NULL,0,?,?,NULL,NULL,NULL)`).run(reviewId, projectId, requestId, 'b'.repeat(64), canonicalImageInput(input), 'c'.repeat(64), canonicalImageInput(intent), '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z');
    };
    insert(sourceImage);
    assert.equal(db.prepare('SELECT count(*) AS n FROM image_reviews').get()!.n, 1);
    const origin = sourceImage.origin, identity = origin.previsOutput;
    const invalidOrigins = [
      {kind: 'previs-output'}, {...origin, publicationId: 'not-a-uuid'}, {...origin, path: '/private/render.png'},
      {...origin, previsOutput: {...identity, projectId: randomUUID()}}, {...origin, previsOutput: {...identity, nodeId: 'x'.repeat(36)}},
      {...origin, previsOutput: {...identity, keyframeId: 'k0'}}, {...origin, previsOutput: {...identity, keyframeId: 'k10000'}},
      {...origin, previsOutput: {...identity, sceneRevision: 0}}, {...origin, previsOutput: {...identity, requestId: 'short'}},
      {...origin, previsOutput: {...identity, width: 65}}, {...origin, previsOutput: {...identity, height: 97}},
      {...origin, previsOutput: {...identity, sha256: 'd'.repeat(64)}}, {...origin, previsOutput: {...identity, name: 'different.png'}},
      {...origin, previsOutput: {...identity, targetKind: 'exports'}},
    ];
    for (const invalidOrigin of invalidOrigins)
      assert.throws(() => insert({...sourceImage, origin: invalidOrigin}), /CHECK constraint failed: image_review_intent_s2/u, JSON.stringify(invalidOrigin));
    assert.equal(db.prepare('SELECT count(*) AS n FROM image_reviews').get()!.n, 1);
  } finally {db.close();}
});

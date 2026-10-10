import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {IMAGE_FIXED_OPTIONS, IMAGE_MODELS, imageSchemas} from '../packages/contracts/src/images.mjs';
import {IMAGE_REVIEW_POLICY, IMAGE_REVIEW_DESTINATION, imageReviewSchemas, imageReviewApprovalSchema,
  imageReviewResponseSchema, isImageReviewPreparationResponse, isImageReviewListResponse} from '../packages/contracts/src/image-reviews.mjs';

const generation = () => ({projectId: randomUUID(), requestId: randomUUID(), name: 'A reviewed image',
  providerId: 'openai', model: IMAGE_MODELS.openai, prompt: 'Synthetic fixture only.', options: {...IMAGE_FIXED_OPTIONS}});
function dto(input) {
  const timestamp = '2026-10-10T00:00:00.000Z';
  return {id: randomUUID(), projectId: input.projectId, requestId: input.requestId, input, inputHash: 'a'.repeat(64),
    settingsRevision: 1, destination: IMAGE_REVIEW_DESTINATION, policy: {...IMAGE_REVIEW_POLICY}, state: 'pending', revision: 1,
    taskId: null, postAttempts: 0, createdAt: timestamp, updatedAt: timestamp, approvedAt: null, rejectedAt: null, dispatchedAt: null};
}

test('public review operations only prepare/read, and old image.generate shape is unchanged', () => {
  assert.deepEqual(Object.keys(imageReviewSchemas), ['image.review.prepare', 'image.review.get', 'image.review.list']);
  const input = generation();
  assert.equal(imageSchemas['image.generate'].safeParse(input).success, true);
  for (const patch of [{reviewId: randomUUID()}, {approved: true}, {settingsRevision: 1}, {destination: IMAGE_REVIEW_DESTINATION}])
    assert.equal(imageSchemas['image.generate'].safeParse({...input, ...patch}).success, false);
  assert.equal(imageReviewSchemas['image.review.prepare'].safeParse({input, settingsRevision: 1}).success, true);
  for (const value of [{input, settingsRevision: 0}, {input, settingsRevision: 1, approved: true},
    {input: {...input, providerId: 'mock', model: IMAGE_MODELS.mock}, settingsRevision: 1},
    {input: {...input, prompt: 'x'.repeat(2001)}, settingsRevision: 1}, {input: {...input, options: {...input.options, n: 2}}, settingsRevision: 1}])
    assert.equal(imageReviewSchemas['image.review.prepare'].safeParse(value).success, false);
  assert.equal(imageReviewApprovalSchema.safeParse({projectId: input.projectId, reviewId: randomUUID(), expectedRevision: 1}).success, true);
  assert.equal(imageReviewApprovalSchema.safeParse({projectId: input.projectId, reviewId: randomUUID(), expectedRevision: 1, input}).success, false);
});

test('review DTO binds exact intent, truthful one-POST policy, state and immutable reservation', () => {
  const input = generation(), value = dto(input);
  assert.equal(imageReviewResponseSchema.safeParse(value).success, true);
  assert.equal(isImageReviewPreparationResponse({input, settingsRevision: 1}, value), true);
  for (const patch of [{input: {...input, requestId: randomUUID()}}, {policy: {...value.policy, price: 'free'}},
    {policy: {...value.policy, automaticRetry: true}}, {destination: 'https://example.com/images'},
    {postAttempts: 1}, {state: 'approved'}, {revision: 2}, {apiKey: 'SYNTHETIC_PRIVATE_SENTINEL'}])
    assert.equal(imageReviewResponseSchema.safeParse({...value, ...patch}).success, false);
  assert.equal(isImageReviewPreparationResponse({input: {...input, prompt: 'Changed'}, settingsRevision: 1}, value), false);
  assert.equal(isImageReviewPreparationResponse({input, settingsRevision: 2}, value), false);
  const approved = {...value, state: 'approved', revision: 2, taskId: randomUUID(), approvedAt: value.createdAt};
  assert.equal(imageReviewResponseSchema.safeParse(approved).success, true);
  assert.equal(imageReviewResponseSchema.safeParse({...approved, state: 'dispatched', revision: 3, postAttempts: 1, dispatchedAt: value.createdAt}).success, true);
});

test('review lists have bounded project-scoped strict envelopes and cursors', () => {
  const input = generation(), value = dto(input), query = {projectId: input.projectId, limit: 1};
  assert.equal(isImageReviewListResponse(query, {projectId: input.projectId, items: [value], nextCursor: null}), true);
  for (const patch of [{items: [value, value]}, {projectId: randomUUID()}, {nextCursor: 'x'.repeat(769)}, {secret: 'hidden'}])
    assert.equal(isImageReviewListResponse(query, {projectId: input.projectId, items: [value], nextCursor: null, ...patch}), false);
  for (const limit of [0, 51, 1.5]) assert.equal(imageReviewSchemas['image.review.list'].safeParse({...query, limit}).success, false);
});

import {schemas as publicSchemas} from '../packages/client/src/index.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSET_MEDIA_PAGE_LIMIT, ASSET_UPLOAD_MAX_BASE64_LENGTH, ASSET_UPLOAD_MAX_BYTES, PROJECT_ASSETS_FOLDER,
  assetImportSchema, assetMediaDtoSchema, assetMediaRecordSchema, assetMediaSchemas, assetMediaStateSchema,
  trustedAssetMediaLocationSchemas, toAssetMediaDto,
} from '../packages/contracts/src/asset-media.ts';
import {MEDIA_STATUS_REASONS, mediaStatusViewSchema} from '../packages/contracts/src/media-reference.ts';
import {
  MEDIA_UNAVAILABLE_ERROR_CODES, mediaReferenceError, mediaUnavailableError, mediaUnavailableErrorDetailsSchemas,
} from '../packages/contracts/src/media-reference-errors.ts';
import {parse, schemas} from '../packages/contracts/src/index.ts';
import {projectMediaPath} from '../packages/contracts/src/project-file.ts';
import {mediaStatusDisplay} from '../apps/web/src/project-file/media-status.ts';

const projectId = '00000000-0000-4000-8000-000000000001';
const assetId = '00000000-0000-4000-8000-000000000002';
const otherProject = '00000000-0000-4000-8000-000000000003';
const requestId = 'media-import-request';
const fullHash = 'f'.repeat(64), sampledHash = 'a'.repeat(64);
const fingerprint = {sizeBytes: 8192, mtimeMs: 1234.125, sampledSha256: sampledHash, fullSha256: null};
const reference = {...fingerprint, pathForm: 'relative', path: '素材/声音.wav', volume: null};
const metadata = {id: assetId, projectId, name: '声音.wav', mimeType: 'audio/wav', sizeBytes: 8192, duration: 1};
const dto = {...metadata, referenceRevision: 1, sha256: null, fingerprint, hashState: 'sampled', url: projectMediaPath(projectId, assetId)};

test('path and upload imports are mutually exclusive, and path imports cannot impersonate a confirmed caller', () => {
  const pathInput = {projectId, requestId, sourcePath: '/Volumes/素材盘/声音.wav'};
  assert.deepEqual(assetImportSchema.parse(pathInput), pathInput);
  assert.ok(assetImportSchema.safeParse({...pathInput, name: '声音'}).success);
  assert.ok(assetImportSchema.safeParse({...pathInput, sourcePath: 'D:\\素材\\声音.wav'}).success);
  assert.ok(assetImportSchema.safeParse({...pathInput, sourcePath: '\\\\nas\\share\\声音.wav'}).success);
  for (const sourcePath of ['声音.wav', '../声音.wav', 'D:声音.wav', '/a/../声音.wav', '/a\u0000.wav']) {
    assert.equal(assetImportSchema.safeParse({...pathInput, sourcePath}).success, false, sourcePath);
  }
  const upload = {projectId, name: '声音.wav', mimeType: 'audio/wav', dataBase64: 'UklGRg=='};
  assert.deepEqual(assetImportSchema.parse(upload), upload);
  assert.ok(assetImportSchema.safeParse({...upload, requestId}).success);
  assert.equal(assetImportSchema.safeParse({...pathInput, ...upload}).success, false);
  assert.equal(assetImportSchema.safeParse({projectId, sourcePath: pathInput.sourcePath}).success, false);
  for (const authority of [{confirmed: true}, {source: 'desktop'}, {allowOutside: true}, {provenance: 'generated'}, {destination: '/tmp'}]) {
    assert.equal(assetImportSchema.safeParse({...pathInput, ...authority}).success, false);
    assert.equal(assetImportSchema.safeParse({...upload, ...authority}).success, false);
  }
  assert.equal(ASSET_UPLOAD_MAX_BYTES, 30 * 1024 * 1024);
  assert.equal(ASSET_UPLOAD_MAX_BASE64_LENGTH, Math.ceil(ASSET_UPLOAD_MAX_BYTES / 3) * 4);
  assert.equal(assetImportSchema.safeParse({...upload, dataBase64: 'A'.repeat(ASSET_UPLOAD_MAX_BASE64_LENGTH + 1)}).success, false);
});

test('public asset metadata distinguishes sampled fingerprints from whole hashes and rejects filesystem locations', () => {
  assert.deepEqual(assetMediaDtoSchema.parse(dto), dto);
  const full = {...dto, sha256: fullHash, hashState: 'full', fingerprint: {...fingerprint, fullSha256: fullHash}};
  assert.deepEqual(assetMediaDtoSchema.parse(full), full);
  for (const malformed of [
    {...dto, sha256: sampledHash}, {...dto, hashState: 'full'}, {...full, sha256: sampledHash},
    {...full, hashState: 'sampled'}, {...dto, sizeBytes: 8193}, {...dto, url: projectMediaPath(otherProject, assetId)},
    {...dto, url: 'file:///Volumes/素材盘/声音.wav'}, {...dto, referenceRevision: 0},
    {...dto, fingerprint: {...fingerprint, path: '/Volumes/素材盘/声音.wav'}},
  ]) assert.equal(assetMediaDtoSchema.safeParse(malformed).success, false);
  for (const location of [{path: '/secret'}, {relativePath: '素材/声音.wav'}, {fileLocation: '/secret'}, {reference}, {outside: false}, {status: 'online'}]) {
    assert.equal(assetMediaDtoSchema.safeParse({...dto, ...location}).success, false);
  }
});

test('persisted records have one location source and consistent size/full hash, independent of the public URL', () => {
  const record = {...metadata, reference, referenceRevision: 1, sha256: null};
  assert.deepEqual(assetMediaRecordSchema.parse(record), record);
  const full = {...record, sha256: fullHash, reference: {...reference, fullSha256: fullHash}};
  assert.deepEqual(assetMediaRecordSchema.parse(full), full);
  for (const malformed of [
    {...record, relativePath: reference.path}, {...record, url: '/media/old'}, {...record, sha256: sampledHash},
    {...full, reference: {...reference, fullSha256: sampledHash}}, {...record, reference: {...reference, sizeBytes: 1}},
  ]) assert.equal(assetMediaRecordSchema.safeParse(malformed).success, false);
  assert.equal(PROJECT_ASSETS_FOLDER, '素材');
});

test('public projection reads legacy null dimensions without changing stored metadata or exposing an old URL', () => {
  const legacy = {...metadata, width: null, height: null, duration: null, reference, referenceRevision: 1, sha256: null,
    url: projectMediaPath(otherProject, assetId)};
  const before = structuredClone(legacy);
  const projected = toAssetMediaDto(legacy);
  assert.deepEqual(projected, {...dto, duration: null});
  assert.equal(Object.hasOwn(projected, 'width'), false); assert.equal(Object.hasOwn(projected, 'height'), false);
  assert.equal(Object.hasOwn(projected, 'provenance'), false);
  assert.equal(projected.url, projectMediaPath(projectId, assetId));
  assert.deepEqual(projected.fingerprint, fingerprint); assert.equal(projected.sha256, null);
  for (const key of ['reference', 'path', 'relativePath', 'volume', 'displayPath']) assert.equal(Object.hasOwn(projected, key), false);
  assert.equal(JSON.stringify(projected).includes(reference.path), false);
  assert.deepEqual(legacy, before); assert.equal(legacy.reference, reference);
  for (const dimensions of [{width: null, height: 0}, {width: 100000, height: null}, {width: 0, height: 100000}]) {
    const value = toAssetMediaDto({...legacy, ...dimensions});
    for (const key of ['width', 'height'] as const) {
      if (dimensions[key] === null) assert.equal(Object.hasOwn(value, key), false);
      else assert.equal(value[key], dimensions[key]);
    }
  }
});

test('null-dimension compatibility does not broaden schemas or coerce invalid metadata', () => {
  const record = {...metadata, reference, referenceRevision: 1, sha256: null};
  for (const dimension of ['width', 'height'] as const) {
    assert.equal(assetMediaDtoSchema.safeParse({...dto, [dimension]: null}).success, false);
    assert.equal(assetMediaRecordSchema.safeParse({...record, [dimension]: null}).success, false);
    for (const invalid of ['720', -1, 0.5, NaN, Infinity, 100001]) {
      const malformed = {...record, [dimension]: invalid};
      const before = structuredClone(malformed);
      assert.throws(() => toAssetMediaDto(malformed), {name: 'ZodError'});
      assert.deepEqual(malformed, before);
    }
  }
  for (const invalid of [{hasAudio: null}, {provenance: null}, {createdAt: null}, {referenceRevision: 0}]) {
    assert.throws(() => toAssetMediaDto({...record, ...invalid}), {name: 'ZodError'});
  }
});

test('shared status types preserve both unconfirmed UI states rather than making an outside reference usable', () => {
  const found = {status: 'online', reason: 'same-stats', outside: true, readable: false};
  const unverified = {status: 'changed', reason: 'unverified', outside: true, readable: false};
  assert.deepEqual(mediaStatusDisplay(mediaStatusViewSchema.parse(found)), {kind: 'unconfirmed-found'});
  assert.deepEqual(mediaStatusDisplay(mediaStatusViewSchema.parse(unverified)), {kind: 'unconfirmed-maybe-changed'});
  const state = {...found, assetId, referenceRevision: 1, fingerprintToken: sampledHash};
  assert.deepEqual(assetMediaStateSchema.parse(state), state);
  assert.equal(MEDIA_STATUS_REASONS.length, 11);
  assert.equal(mediaStatusViewSchema.safeParse({...found, reason: 'looks-good'}).success, false);
  assert.equal(assetMediaStateSchema.safeParse({...state, file: '/secret'}).success, false);
  assert.equal(assetMediaStateSchema.safeParse({...state, fingerprintToken: 'not-a-hash'}).success, false);
});

test('public media errors retain L1 codes/statuses and expose only an asset ID and an existing reason', () => {
  const examples = [
    ['MEDIA_MISSING', 'not-found', 404], ['MEDIA_CHANGED', 'content', 409], ['MEDIA_NOT_MEDIA', 'protected', 415],
    ['MEDIA_OUTSIDE_NOT_CONFIRMED', null, 403], ['MEDIA_CHANGED_DURING_READ', null, 409],
  ] as const;
  assert.deepEqual(examples.map(([code]) => code), [...MEDIA_UNAVAILABLE_ERROR_CODES]);
  for (const [code, reason, status] of examples) {
    const error = mediaUnavailableError(code, assetId, reason);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.deepEqual(error.details, {assetId, reason});
    assert.equal(mediaUnavailableErrorDetailsSchemas[code].safeParse({assetId, reason, path: '/secret'}).success, false);
  }
  assert.equal(mediaUnavailableErrorDetailsSchemas.MEDIA_MISSING.safeParse({assetId, reason: '/secret'}).success, false);
  assert.equal(mediaUnavailableErrorDetailsSchemas.MEDIA_CHANGED.safeParse({assetId, reason: 'unconfirmed'}).success, false);
  assert.deepEqual(mediaReferenceError('MEDIA_LIST_PATH_INVALID', {reason: 'outside'}).details, {reason: 'outside'});
});

test('bounded media preparation cannot duplicate assets, nominate stale revisions or smuggle confirmation authority', () => {
  const prepare = {projectId, assets: [{assetId, referenceRevision: 1}], purpose: 'export'};
  const schema = assetMediaSchemas['asset.media.prepare'];
  assert.deepEqual(schema.parse(prepare), prepare);
  assert.equal(schema.safeParse({...prepare, assets: [...prepare.assets, ...prepare.assets]}).success, false);
  assert.equal(schema.safeParse({...prepare, assets: [{assetId, referenceRevision: 0}]}).success, false);
  assert.equal(schema.safeParse({...prepare, approved: true}).success, false);
  assert.equal(assetMediaSchemas['asset.media.status.list'].safeParse({projectId, limit: ASSET_MEDIA_PAGE_LIMIT + 1}).success, false);
  assert.equal(assetMediaSchemas['asset.media.status.list'].safeParse({projectId, assetIds: [assetId, assetId]}).success, false);
  const confirm = {projectId, requestId, locationToken: assetId};
  assert.deepEqual(trustedAssetMediaLocationSchemas['asset.media.outside.confirm'].parse(confirm), confirm);
  assert.equal(trustedAssetMediaLocationSchemas['asset.media.outside.confirm'].safeParse({...confirm, directory: '/secret'}).success, false);
  assert.equal(Object.hasOwn(assetMediaSchemas, 'asset.media.outside.confirm'), false);
});

test('full S1 activates strict path imports while keeping media extensions out of the Mio registry', () => {
  assert.deepEqual(publicSchemas['asset.import'].parse({projectId,requestId,sourcePath:'/asset.wav'}),{projectId,requestId,sourcePath:'/asset.wav'});
  assert.throws(()=>parse('asset.import',{projectId,requestId,sourcePath:'/asset.wav'}),{code:'VALIDATION_ERROR'});
  assert.equal(Object.hasOwn(schemas, 'asset.media.prepare'), false);
  assert.deepEqual(parse('asset.import', {projectId, name: '声音.wav', mimeType: 'audio/wav', dataBase64: 'UklGRg=='}),
    {projectId, name: '声音.wav', mimeType: 'audio/wav', dataBase64: 'UklGRg=='});
});

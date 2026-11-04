import test from 'node:test';
import assert from 'node:assert/strict';
import {isMioProjectMediaRelativePath, mioProjectMediaListInputSchema, mioProjectMediaListingSchema} from '../packages/contracts/src/mio-project-media.ts';

test('project media input preserves literal spelling and rejects path or authority escapes', () => {
  for (const directory of ['', '素材', 'clips/片段 1', 'e\u0301', 'é', '%2e%2e', 'file%2fdir']) {
    assert.deepEqual(mioProjectMediaListInputSchema.parse({directory}), {directory});
  }
  for (const directory of ['/', '/tmp', 'C:/video', 'C:video', '\\server', 'a\\b', 'a//b', '.', '..', 'a/../b', './a', '.hidden', 'a/.hidden',
    'NUL', 'con.txt', 'LPT¹.mp4', 'a/nul .mp4', 'trailing.', 'trailing ', 'x:ads', 'a\u0000', 'a\u007f', 'bad\ud800', 'bad\udfff', '😀'.repeat(1025)]) {
    assert.equal(mioProjectMediaListInputSchema.safeParse({directory}).success, false, JSON.stringify(directory));
  }
  assert.equal(isMioProjectMediaRelativePath(''), false);
  assert.equal(isMioProjectMediaRelativePath('', true), true);
  assert.equal(mioProjectMediaListInputSchema.safeParse({directory: 'a'.repeat(4096)}).success, true);
  assert.equal(mioProjectMediaListInputSchema.safeParse({directory: 'a'.repeat(4097)}).success, false);
  for (const input of [{limit: 0}, {limit: 101}, {limit: 1.5}, {cursor: ''}, {cursor: 'x'.repeat(2049)}, {cursor: 'a='}, {projectId: 'owner'}, {signal: {}}, {path: 'clip.mp4'}]) {
    assert.equal(mioProjectMediaListInputSchema.safeParse(input).success, false);
  }
});

test('listing DTO has closed media kinds, no host paths and an exact UTF-8 byte bound', () => {
  const folder = {name: '素材', kind: 'folder', mimeType: null, sizeBytes: null, durationSeconds: null};
  const movie = {name: '片段.mp4', kind: 'video', mimeType: 'video/mp4', sizeBytes: 3, durationSeconds: 1.25};
  const page = {directory: '', entries: [folder, movie], nextCursor: null, truncated: false};
  assert.deepEqual(mioProjectMediaListingSchema.parse(page), page);
  for (const entry of [{...folder, sizeBytes: 0}, {...movie, mimeType: 'audio/mp4'}, {...movie, sizeBytes: Number.MAX_SAFE_INTEGER + 1},
    {...movie, durationSeconds: Infinity}, {...movie, durationSeconds: -1}, {...movie, name: '../clip.mp4'}, {...movie, mimeType: 'video/quicktime'}, {...movie, path: '/private/video'}]) {
    assert.equal(mioProjectMediaListingSchema.safeParse({...page, entries: [entry]}).success, false);
  }
  for (const change of [{absolutePath: '/private'}, {entries: [movie, movie]}, {nextCursor: 'position'}, {entries: [], nextCursor: 'position', truncated: true}]) {
    assert.equal(mioProjectMediaListingSchema.safeParse({...page, ...change}).success, false);
  }
  // One component is limited to 4096 bytes, so fill the outer directory first.
  const entry = {...movie, name: 'a'.repeat(4000)};
  const entries = [entry, {...entry, name: 'b'.repeat(4000)}, {...entry, name: 'c'.repeat(4000)}];
  const base = {...page, entries};
  const bytes = Buffer.byteLength(JSON.stringify(base));
  const boundary = {...base, directory: 'd'.repeat(16384 - bytes)};
  assert.equal(Buffer.byteLength(JSON.stringify(boundary)), 16384);
  assert.equal(mioProjectMediaListingSchema.safeParse(boundary).success, true);
  assert.equal(mioProjectMediaListingSchema.safeParse({...boundary, directory: boundary.directory + 'd'}).success, false);
});

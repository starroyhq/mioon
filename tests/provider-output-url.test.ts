import test from 'node:test';
import assert from 'node:assert/strict';
import { outputUrl } from '../packages/business/src/providers/live-common.ts';

const hosts = new Set(['approved.example']);
const prefix = 'Output host requires server-side verification before download. ';
const privateSuffix = '/PRIVATE-PATH.mp4?signature=PRIVATE-SIGNATURE#PRIVATE-FRAGMENT';

for (const [name, url, diagnostic] of [
  ['unapproved hostname', `https://unapproved.example${privateSuffix}`, { protocol: 'https:', hostname: 'unapproved.example', port: '', hasUserinfo: false }],
  ['HTTP', `http://approved.example${privateSuffix}`, { protocol: 'http:', hostname: 'approved.example', port: '', hasUserinfo: false }],
  ['userinfo', `https://PRIVATE-USER:PRIVATE-PASSWORD@approved.example${privateSuffix}`, { protocol: 'https:', hostname: 'approved.example', port: '', hasUserinfo: true }],
  ['nondefault port', `https://approved.example:8443${privateSuffix}`, { protocol: 'https:', hostname: 'approved.example', port: '8443', hasUserinfo: false }],
] as const) test(`output URL rejects ${name} with only safe destination diagnostics`, () => {
  assert.throws(() => outputUrl(url, hosts), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code?: string }).code, 'UNAPPROVED_OUTPUT_HOST');
    assert.equal(error.message, prefix + JSON.stringify(diagnostic));
    assert.doesNotMatch(error.message, /PRIVATE-|signature=|\/\/|@/);
    assert.deepEqual(Object.keys(error).sort(), ['code']);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE-|signature=/);
    return true;
  });
});

test('approved HTTPS URLs retain their complete signed destination without emitting diagnostics', () => {
  const url = `https://approved.example${privateSuffix}`;
  assert.equal(outputUrl(url, hosts).href, url);
  assert.equal(outputUrl(url.replace('approved.example', 'APPROVED.EXAMPLE:443'), hosts).href, url);
  assert.deepEqual([...hosts], ['approved.example']);
  assert.throws(() => outputUrl(`https://sub.approved.example${privateSuffix}`, hosts), { code: 'UNAPPROVED_OUTPUT_HOST' });
  assert.throws(() => outputUrl(`https://approved.example.evil.example${privateSuffix}`, hosts), { code: 'UNAPPROVED_OUTPUT_HOST' });
});

test('invalid output URLs retain a generic error without reflecting their input', () => {
  for (const url of ['PRIVATE-INVALID-URL', '/PRIVATE-PATH?signature=PRIVATE-SIGNATURE', 'https://PRIVATE-USER:PRIVATE-PASSWORD@[invalid]/PRIVATE-PATH']) {
    assert.throws(() => outputUrl(url, hosts), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, 'INVALID_OUTPUT_URL');
      assert.equal(error.message, 'Provider did not return a valid output URL.');
      assert.doesNotMatch(error.message, /PRIVATE-/);
      return true;
    });
  }
});

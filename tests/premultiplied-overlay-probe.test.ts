import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PREMULTIPLIED_OVERLAY_ALPHA_MODE_TAG, PREMULTIPLIED_OVERLAY_EXPECTED,
  probePremultipliedOverlay} from '../packages/business/src/premultiplied-overlay-probe.ts';
import {probePremultipliedOverlayCli} from '../.github/scripts/media-environment.ts';

const reviewed = [...PREMULTIPLIED_OVERLAY_EXPECTED];
const frame = (pixels: readonly number[]): Buffer => Buffer.from(Array.from({length: 4}, () => pixels).flat());

async function root(t: test.TestContext): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-premultiplied-overlay-test-')));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}
const isTagged = (args: readonly string[]): boolean => (args[args.indexOf('-filter_complex') + 1] ?? '').includes(PREMULTIPLIED_OVERLAY_ALPHA_MODE_TAG);
const writePixel = async (args: readonly string[], pixels: readonly number[]): Promise<void> => writeFile(String(args.at(-1)), frame(pixels));

test('a tool without alpha-mode support keeps the reviewed legacy graph', async t => {
  const directory = await root(t), seen: boolean[] = [];
  const result = await probePremultipliedOverlay('synthetic-ffmpeg', {
    temporaryRoot: directory,
    execute: async (_file, args) => {
      seen.push(isTagged(args));
      if (isTagged(args)) throw Object.assign(new Error('Local media tool failed.'), {code: 'MEDIA_EXIT_FAILED'});
      await writePixel(args, reviewed);
    },
  });
  assert.deepEqual(result, {ok: true, variant: 'legacy', filterSupported: false, expected: PREMULTIPLIED_OVERLAY_EXPECTED, observed: reviewed});
  assert.deepEqual(seen, [true, false], 'the alpha-mode graph is tried once before the legacy fallback');
});

test('a tool with alpha-mode support is judged on the tagged graph only', async t => {
  const directory = await root(t), seen: boolean[] = [];
  const result = await probePremultipliedOverlay('synthetic-ffmpeg', {
    temporaryRoot: directory,
    execute: async (_file, args) => { seen.push(isTagged(args)); await writePixel(args, reviewed); },
  });
  assert.deepEqual(result, {ok: true, variant: 'alpha-mode-tag', filterSupported: true, expected: PREMULTIPLIED_OVERLAY_EXPECTED, observed: reviewed});
  assert.deepEqual(seen, [true]);
});

test('the double-premultiplied pixel is reported as unsupported instead of being accepted', async t => {
  const directory = await root(t);
  const result = await probePremultipliedOverlay('synthetic-ffmpeg', {
    temporaryRoot: directory,
    execute: async (_file, args) => {
      if (isTagged(args)) throw Object.assign(new Error('Local media tool failed.'), {code: 'MEDIA_EXIT_FAILED'});
      await writePixel(args, [57, 67, 124]);
    },
  });
  assert.deepEqual(result, {ok: false, variant: 'legacy', filterSupported: false, expected: PREMULTIPLIED_OVERLAY_EXPECTED, observed: [57, 67, 124]});
});

test('a short probe frame fails closed instead of comparing partial pixels', async t => {
  const directory = await root(t);
  await assert.rejects(probePremultipliedOverlay('synthetic-ffmpeg', {
    temporaryRoot: directory,
    execute: async (_file, args) => writeFile(String(args.at(-1)), Buffer.from([89, 83, 172])),
  }), {code: 'PREMULTIPLIED_OVERLAY_PROBE_INVALID'});
});

test('the CI capability probe records the same reviewed pixel as evidence', async t => {
  const directory = await root(t);
  const result = await probePremultipliedOverlayCli('synthetic-ffmpeg', {
    temporaryRoot: directory,
    env: {},
    execute: (async (_file: string, args: readonly string[]) => {
      if (isTagged(args)) throw Object.assign(new Error('Local media tool failed.'), {code: 'MEDIA_EXIT_FAILED'});
      await writePixel(args, reviewed);
      return '';
    }) as never,
  });
  assert.deepEqual(result, {ok: true, variant: 'legacy', filterSupported: false, expected: PREMULTIPLIED_OVERLAY_EXPECTED, observed: reviewed});
});

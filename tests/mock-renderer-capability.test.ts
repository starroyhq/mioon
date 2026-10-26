import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMockProvider } from '../packages/business/src/providers/mock.ts';

const input = { prompt: 'Synthetic capability check', duration: 2, aspectRatio: '9:16', parameters: { scenario: 'success', delayMs: 0 }, referenceAssets: [] };
const listing = (names: string[]) => ' Filters:\n  T.. = Timeline support\n' + names.map((name: string) => ` ${name === 'overlay' ? 'TS' : '..'} ${name.padEnd(16)} V->V       Synthetic.\n`).join('');

// A stand-in ffmpeg that prints `output` for `-filters` and fails every render, like a build whose filter graph is rejected.
async function renderFailure(t: test.TestContext, output: string) {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), 'mioon-mock-capability-')));
  await mkdir(path.join(root, 'media'));
  const script = path.join(root, `ffmpeg-${Math.random().toString(36).slice(2)}`);
  await writeFile(script, `#!/bin/sh\ncase "$*" in *-filters*) cat <<'LISTING'\n${output}LISTING\n;; *) exit 1;; esac\n`);
  await chmod(script, 0o700);
  const previous = process.env.MIOON_FFMPEG_PATH; process.env.MIOON_FFMPEG_PATH = script;
  t.after(() => { if (previous === undefined) delete process.env.MIOON_FFMPEG_PATH; else process.env.MIOON_FFMPEG_PATH = previous; });
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const provider = createMockProvider({ db, root });
  const accepted = await provider.submit(input, { requestId: `capability-${Math.random().toString(36).slice(2)}` });
  const id = accepted.providerJobId ?? (accepted as unknown as {id: string}).id;
  return { provider, id, destination: path.join(root, 'media', 'out.mp4'),
    download: () => provider.download(id, path.join(root, 'media', 'out.mp4'), {}).then(() => assert.fail('render must fail'), error => error) };
}

test('a build without drawtext fails the render with an actionable, non-retryable reason', async t => {
  const { provider, id, download } = await renderFailure(t, listing(['scale', 'overlay', 'drawbox']));
  // The poll already reports it, so the job fails once instead of retrying the download for ever.
  const polled = await provider.poll(id, {});
  assert.equal(polled.status, 'failed'); assert.equal(polled.error.code, 'MOCK_RENDERER_UNSUPPORTED'); assert.equal((polled.error as {retryable?: boolean}).retryable, false);
  const error = await download();
  assert.equal(error.code, 'MOCK_RENDERER_UNSUPPORTED'); assert.equal(error.retryable, false);
  assert.match(error.message, /drawtext/); assert.match(error.message, /ffmpeg-full/);
});

test('a render failure on a build that has drawtext, or whose filter list is unreadable, keeps the generic retryable error', async t => {
  for (const output of [listing(['scale', 'overlay', 'drawtext']), 'not a filter table\n']) {
    const { provider, id, download } = await renderFailure(t, output);
    assert.equal((await provider.poll(id, {})).status, 'succeeded');
    const error = await download();
    assert.equal(error.code, 'MOCK_RENDER_FAILED'); assert.equal(error.retryable, true);
    assert.equal(error.message, 'Simulated video rendering failed.');
  }
});

test('the current FFmpeg legend separator preserves proven missing and present drawtext results', async t => {
  const header = 'Filters:\n  T.. = Timeline support\n  .S. = Slice threading\n  A = Audio input/output\n  V = Video input/output\n  N = Dynamic number and/or type of input/output\n  | = Source or sink filter\n  ------\n';
  for (const supported of [false, true]) {
    const rows = ['scale', 'drawbox', ...(supported ? ['drawtext'] : [])]
      .map(name => ` .. ${name.padEnd(16)} V->V       Synthetic filter.\n`).join('');
    const {provider, id, download} = await renderFailure(t, header + rows);
    const polled = await provider.poll(id, {});
    assert.equal(polled.status, supported ? 'succeeded' : 'failed');
    const error = await download();
    assert.equal(error.code, supported ? 'MOCK_RENDER_FAILED' : 'MOCK_RENDERER_UNSUPPORTED');
    assert.equal(error.retryable, supported);
  }
});

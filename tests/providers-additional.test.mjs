import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createMinimaxProvider } from '../packages/business/src/providers/minimax.mjs';
import { createViduProvider } from '../packages/business/src/providers/vidu.mjs';

const exec = promisify(execFile);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const ID = 'offline-task-123';
const specs = {
  minimax: { factory: createMinimaxProvider, model: 'MiniMax-H3', prefix: 'MINIMAX', origin: 'https://api.minimax.io', cnOrigin: 'https://api.minimax.cn', host: 'video-product.cdn.minimax.io',
    task: (status, url) => ({ task: { id: ID, status, content: { url }, error: { message: 'PRIVATE-RAW-DETAIL' } } }), success: 'succeeded', running: 'running',
  },
  vidu: { factory: createViduProvider, model: 'viduq3-turbo', prefix: 'VIDU', origin: 'https://api.vidu.com', cnOrigin: 'https://api.vidu.cn', host: 'reviewed-vidu-output.example',
    task: (state, url) => ({ id: ID, state, creations: [{ url }], err_code: 'PRIVATE-RAW-DETAIL' }), success: 'success', running: 'processing',
  },
};
function png(width = 360, height = 640) {
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]), n = Buffer.alloc(4), crc = Buffer.alloc(4); n.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([n, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
async function fixture(t, kind, responses = [], options = {}) {
  const spec = specs[kind], root = await mkdtemp(path.join(tmpdir(), 'additional-provider-')); t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = png(), file = path.join(root, 'reference.png'); await writeFile(file, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const env = { [`${spec.prefix}_API_KEY`]: 'PRIVATE-KEY', VIDEO_WORKBENCH_ENABLE_LIVE_PROVIDER: '1', [`${spec.prefix}_APPROVED_ASSET_SHA256`]: sha256, ...(kind === 'vidu' ? { VIDU_OUTPUT_HOSTS: spec.host } : {}), ...options.env };
  const calls = [], queue = [...responses];
  const fetchImpl = async (...args) => { calls.push(args); const next = queue.shift(); if (next instanceof Error) throw next; if (typeof next === 'function') return next(...args); if (!next) throw new Error('Real fetch forbidden in offline test'); return next; };
  const provider = spec.factory({ root, env, fetchImpl, ...(options.now ? { now: options.now } : {}) });
  const input = { model: spec.model, prompt: 'A synthetic shape moves slowly.', duration: 4, aspectRatio: '9:16', referenceAssets: [], parameters: {} };
  const reference = { id: 'local-reference', path: file, mimeType: 'image/png', sha256, width: 360, height: 640 };
  const url = `https://${spec.host}/output.mp4?signature=PRIVATE-SIGNED-URL`;
  return { root, bytes, file, env, calls, queue, provider, input, reference, url, spec };
}

for (const kind of Object.keys(specs)) {
  test(`${kind}: construction, capabilities, reconciliation and local stop use no network`, async t => {
    const { provider, calls, input } = await fixture(t, kind, [], { env: { VIDEO_WORKBENCH_ENABLE_LIVE_PROVIDER: '0' } });
    assert.equal(provider.capabilities.status, 'disabled'); assert.equal(provider.capabilities.liveVerified, false);
    assert.equal(provider.validate(input), true);
    assert.equal(JSON.stringify(provider.capabilities).includes('PRIVATE-KEY'), false);
    await assert.rejects(provider.submit(input), { code: 'PROVIDER_DISABLED' });
    await assert.rejects(provider.poll(ID), { code: 'PROVIDER_DISABLED' });
    assert.equal(await provider.reconcile('unknown'), null);
    assert.equal((await provider.cancel(ID)).remoteCancelled, false);
    assert.equal(calls.length, 0);
  });

  for (const image of [false, true]) test(`${kind}: maps ${image ? 'first-frame' : 'text'} request with no hidden upload`, async t => {
    const { provider, input, reference, calls, spec, bytes } = await fixture(t, kind, [json({ task_id: ID })]);
    assert.deepEqual(await provider.submit({ ...input, referenceAssets: image ? [reference] : [] }), { providerJobId: ID });
    assert.equal(calls.length, 1);
    const [url, init] = calls[0], body = JSON.parse(init.body);
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.equal(init.headers['Idempotency-Key'], undefined);
    assert.equal(body.model, spec.model); assert.equal(body.duration, 4);
    if (kind === 'minimax') {
      assert.equal(url, `${spec.origin}/v2/video_generation`); assert.equal(init.headers.Authorization, 'Bearer PRIVATE-KEY');
      assert.equal(body.resolution, '768P'); assert.equal(body.ratio, image ? 'adaptive' : '9:16'); assert.equal(body.content[0].text, input.prompt);
      assert.equal(body.content.length, image ? 2 : 1);
      if (image) assert.deepEqual(body.content[1], { type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` }, role: 'first_frame' });
    } else {
      assert.equal(url, `${spec.origin}/ent/v2/${image ? 'img2video' : 'text2video'}`); assert.equal(init.headers.Authorization, 'Token PRIVATE-KEY');
      assert.equal(body.resolution, '720p'); assert.equal(body.audio, false); assert.equal(body.off_peak, false); assert.equal(body.prompt, input.prompt);
      if (image) { assert.deepEqual(body.images, [`data:image/png;base64,${bytes.toString('base64')}`]); assert.equal(body.is_rec, false); assert.equal(body.aspect_ratio, undefined); }
      else { assert.equal(body.aspect_ratio, '9:16'); assert.equal(body.images, undefined); assert.equal(body.is_rec, undefined); }
    }
  });

  test(`${kind}: selects only verified global/cn origins with region-compatible server credentials`, async t => {
    const { provider, input, calls, spec } = await fixture(t, kind, [json({ task_id: ID })], { env: { [`${specs[kind].prefix}_REGION`]: 'cn' } });
    await provider.submit(input); assert.equal(new URL(calls[0][0]).origin, spec.cnOrigin); assert.equal(provider.capabilities.region, 'cn');
    const invalid = await fixture(t, kind, [], { env: { [`${specs[kind].prefix}_REGION`]: 'https://evil.test' } });
    assert.equal(invalid.provider.capabilities.enabled, false);
    assert.equal(invalid.provider.capabilities.configured, false);
    await assert.rejects(invalid.provider.submit(invalid.input), { code: 'PROVIDER_CONFIGURATION' }); assert.equal(invalid.calls.length, 0);
  });

  test(`${kind}: immutable job region cannot silently switch accounts after restart`, async t => {
    const { provider, input, calls, root } = await fixture(t, kind);
    const context = { providerRegion: 'cn' };
    await assert.rejects(provider.submit(input, context), { code: 'PROVIDER_REGION_CHANGED' });
    await assert.rejects(provider.poll(ID, context), { code: 'PROVIDER_REGION_CHANGED' });
    await assert.rejects(provider.download(ID, path.join(root, 'out.mp4'), context), { code: 'PROVIDER_REGION_CHANGED' });
    assert.equal(calls.length, 0);
  });

  test(`${kind}: validation works before paths are resolved and rejects unsupported options`, async t => {
    const { provider, input, reference, calls } = await fixture(t, kind);
    const { path: ignored, ...metadata } = reference;
    assert.equal(provider.validate({ ...input, referenceAssets: [metadata] }), true);
    for (const patch of [{ model: 'legacy-model' }, { duration: 6 }, { duration: 4.5 }, { aspectRatio: '1:1' }, { prompt: '' }, { prompt: 'x'.repeat(1001) }, { parameters: { seed: 2 } }, { referenceAssets: [metadata, metadata] }, { referenceAssets: [{ ...metadata, mimeType: 'image/webp' }] }, { referenceAssets: [{ ...metadata, width: 640 }] }]) assert.throws(() => provider.validate({ ...input, ...patch }));
    assert.equal(calls.length, 0);
  });

  for (const [name, response, uncertain] of [
    ['lost response', new Error('PRIVATE-KEY'), true], ['HTTP500', () => json({ message: 'PRIVATE-KEY' }, 500), true],
    ['HTTP408', () => json({}, 408), true], ['HTTP409', () => json({}, 409), true], ['unreadable response', () => new Response('PRIVATE-KEY'), true],
    ['missing ID', () => json({ ok: true }), true], ['HTTP400', () => json({ error: 'PRIVATE-KEY' }, 400), false], ['HTTP402 billing rejection', () => json({}, 402), false],
  ]) test(`${kind}: ${name} is never retried or exposed`, async t => {
    const { provider, input, calls } = await fixture(t, kind, [response]);
    await assert.rejects(provider.submit(input), e => Boolean(e.uncertain) === uncertain && !e.message.includes('PRIVATE-KEY'));
    assert.equal(await provider.reconcile('missing'), null); assert.equal(calls.length, 1);
  });

  test(`${kind}: managed references are approved, checksum-bound, size-bounded and never fetched by URL`, async t => {
    const { provider, input, reference, calls, file, root } = await fixture(t, kind);
    const submit = ref => provider.submit({ ...input, referenceAssets: [ref] });
    await assert.rejects(submit({ ...reference, sha256: '0'.repeat(64) }), { code: 'REFERENCE_NOT_APPROVED' });
    await assert.rejects(submit({ ...reference, path: 'https://evil.test/image.png' }), { code: 'REFERENCE_UNAVAILABLE' });
    const outside = await mkdtemp(path.join(tmpdir(), 'outside-ref-')); t.after(() => rm(outside, { recursive: true, force: true }));
    const external = path.join(outside, 'outside.png'); await writeFile(external, png()); const link = path.join(root, 'outside.png'); await symlink(external, link);
    await assert.rejects(submit({ ...reference, path: link }), { code: 'UNSAFE_REFERENCE_PATH' });
    await writeFile(file, png(400, 400)); await assert.rejects(submit(reference), { code: 'REFERENCE_CHANGED' });
    await writeFile(file, Buffer.alloc(11 * 1024 * 1024)); await assert.rejects(submit(reference), { code: 'REFERENCE_TOO_LARGE' });
    assert.equal(calls.length, 0);
  });

  test(`${kind}: status cache includes failures and never turns polling into submission`, async t => {
    let now = 0; const spec = specs[kind];
    const { provider, calls } = await fixture(t, kind, [new Error('PRIVATE-KEY'), json(spec.task(spec.running)), json(spec.task('failed'))], { now: () => now });
    await assert.rejects(provider.poll('../evil'), { code: 'INVALID_PROVIDER_TASK_ID' });
    await assert.rejects(provider.poll(ID), e => e.retryable); await assert.rejects(provider.poll(ID), e => e.retryable); assert.equal(calls.length, 1);
    now = 10001; const results = await Promise.all([provider.poll(ID), provider.poll(ID)]); assert.ok(results.every(x => x.status === 'running')); assert.equal(calls.length, 2);
    now = 20002; const failed = await provider.poll(ID); assert.equal(failed.status, 'failed'); assert.equal(JSON.stringify(failed).includes('PRIVATE-RAW-DETAIL'), false);
    assert.ok(calls.every(([, init]) => init.method === 'GET'));
  });

  test(`${kind}: downloads actual H264 MP4, drops auth, refreshes expired URL by task GET only`, async t => {
    const { provider, calls, spec, url, queue, root } = await fixture(t, kind);
    const source = path.join(root, 'source.mp4'); await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=12', '-t', '0.5', '-an', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', source]);
    const bytes = await readFile(source);
    queue.push(json(spec.task(spec.success, url)), new Response(null, { status: 403 }), json(spec.task(spec.success, url + 'fresh')), new Response(bytes));
    const destination = path.join(root, 'download.mp4');
    await assert.rejects(provider.download(ID, destination), { code: 'DOWNLOAD_FAILED' });
    const result = await provider.download(ID, destination);
    assert.deepEqual(await readFile(destination), bytes); assert.equal(result.isMock, false); assert.equal(JSON.stringify(result).includes('PRIVATE-SIGNED-URL'), false);
    assert.equal(calls[1][1].headers, undefined); assert.equal(calls[3][1].headers, undefined); assert.equal(calls[3][1].redirect, 'error');
    assert.equal(calls.length, 4); assert.ok(calls.every(([, init]) => init.method === 'GET'));
  });

  test(`${kind}: blocks credentialed/unknown output, redirects, malformed media and output symlink escapes`, async t => {
    const { provider, calls, spec, url, queue, root } = await fixture(t, kind);
    queue.push(json(spec.task(spec.success, 'https://evil.test/out.mp4')));
    await assert.rejects(provider.download(ID, path.join(root, 'out.mp4')), { code: 'UNAPPROVED_OUTPUT_HOST' }); assert.equal(calls.length, 1);
    for (const response of [new Response(null, { status: 302, headers: { location: 'https://evil.test' } }), new Response('not an MP4')]) {
      const next = await fixture(t, kind, [json(spec.task(spec.success, url)), response]);
      await assert.rejects(next.provider.download(ID, path.join(next.root, 'out.mp4')), e => ['UNSAFE_OUTPUT_REDIRECT', 'INVALID_OUTPUT_MEDIA'].includes(e.code));
      assert.equal((await readdir(next.root)).some(name => name.includes('.partial.')), false);
    }
    const next = await fixture(t, kind, [json(spec.task(spec.success, url))]);
    const outside = await mkdtemp(path.join(tmpdir(), 'outside-output-')); t.after(() => rm(outside, { recursive: true, force: true }));
    await symlink(outside, path.join(next.root, 'escape'));
    await assert.rejects(next.provider.download(ID, path.join(next.root, 'escape', 'new-directory', 'out.mp4')), { code: 'UNSAFE_OUTPUT_PATH' });
    assert.deepEqual(await readdir(outside), [], 'must not create directories outside root'); assert.equal(next.calls.length, 1);
  });
}

for (const status of ['queued', 'running', 'succeeded', 'failed', 'cancelled']) test(`MiniMax maps ${status} documented V2 state`, async t => {
  const { provider } = await fixture(t, 'minimax', [json(specs.minimax.task(status))]);
  assert.equal((await provider.poll(ID)).status, ['queued', 'running'].includes(status) ? 'running' : status === 'succeeded' ? 'succeeded' : 'failed');
});
for (const state of ['created', 'queueing', 'processing', 'success', 'failed']) test(`Vidu maps ${state} documented state`, async t => {
  const { provider } = await fixture(t, 'vidu', [json(specs.vidu.task(state))]);
  assert.equal((await provider.poll(ID)).status, ['created', 'queueing', 'processing'].includes(state) ? 'running' : state === 'success' ? 'succeeded' : 'failed');
});

test('Vidu refuses generation until an exact output host is independently reviewed/configured', async t => {
  const { provider, input, calls } = await fixture(t, 'vidu', [], { env: { VIDU_OUTPUT_HOSTS: '' } });
  assert.equal(provider.capabilities.configured, false); assert.equal(provider.capabilities.enabled, false); assert.equal(provider.capabilities.status, 'not_configured');
  assert.ok(provider.capabilities.configuration.missing.includes('VIDU_OUTPUT_HOSTS'));
  await assert.rejects(provider.submit(input), { code: 'PROVIDER_CONFIGURATION' }); assert.equal(calls.length, 0);
});

test('Vidu reports externally cancelled task as cancelled failure without making a cancel POST', async t => {
  const { provider, calls } = await fixture(t, 'vidu', [json({ id: ID, state: 'failed', err_code: 'UserCancelled' })]);
  assert.equal((await provider.poll(ID)).error.code, 'PROVIDER_CANCELLED');
  assert.equal((await provider.cancel(ID)).scope, 'local'); assert.equal(calls.length, 1); assert.equal(calls[0][1].method, 'GET');
});

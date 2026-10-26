import type {RootFailure} from './helpers/strict-root-error-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createArkProvider } from '../packages/business/src/providers/ark.ts';
import { createVeoProvider } from '../packages/business/src/providers/veo.ts';

const exec = promisify(execFile);
const json = (data: { secret?: string; accepted?: boolean; id?: string; status?: string; error?: { message: string; }; done?: boolean; response?: { generateVideoResponse: { generatedSamples: { video: { uri: unknown; }; }[]; }; }|{ generateVideoResponse: { raiMediaFilteredCount: number; raiMediaFilteredReasons: string[]; generatedSamples?: undefined; }|{ generatedSamples: never[]; raiMediaFilteredCount?: undefined; raiMediaFilteredReasons?: undefined; }; }; name?: string; }, status: number|undefined = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const specs = {
  ark: { factory: createArkProvider, model: 'doubao-seedance-2-5-260628', key: 'ARK_API_KEY', prefix: 'ARK', id: 'cgt-offline-123', host: 'ark-content-generation-cn-beijing.tos-cn-beijing.volces.com',
    accepted: () => ({ id: 'cgt-offline-123' }), running: () => ({ id: 'cgt-offline-123', status: 'running' }),
    succeeded: (url: unknown) => ({ id: 'cgt-offline-123', status: 'succeeded', content: { video_url: url } }),
    failed: () => ({ id: 'cgt-offline-123', status: 'failed', error: { message: 'SECRET-DO-NOT-LEAK' } }),
  },
  veo: { factory: createVeoProvider, model: 'veo-3.1-generate-preview', key: 'GEMINI_API_KEY', prefix: 'VEO', id: 'models/veo-3.1-generate-preview/operations/offline-123', host: 'generativelanguage.googleapis.com',
    accepted: () => ({ name: 'models/veo-3.1-generate-preview/operations/offline-123' }), running: () => ({ name: 'models/veo-3.1-generate-preview/operations/offline-123', done: false }),
    succeeded: (uri: unknown) => ({ name: 'models/veo-3.1-generate-preview/operations/offline-123', done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri } }] } } }),
    failed: () => ({ name: 'models/veo-3.1-generate-preview/operations/offline-123', done: true, error: { message: 'SECRET-DO-NOT-LEAK' } }),
  },
};
function png(width: number|undefined = 360, height: number|undefined = 640) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]), header = Buffer.alloc(4), footer = Buffer.alloc(4);
    header.writeUInt32BE(data.length); footer.writeUInt32BE(crc32(body));
    return Buffer.concat([header, body, footer]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
async function sandbox(t: test.TestContext) { const root = await mkdtemp(path.join(tmpdir(), 'v4-provider-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function fixture(t: test.TestContext, kind: keyof typeof specs, responses: unknown[] = [], options: {env?: NodeJS.ProcessEnv; now?: () => number} = {}) {
  const spec = specs[kind], root = await sandbox(t), bytes = png(), file = path.join(root, 'approved.png');
  await writeFile(file, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const env = { [spec.key]: 'SECRET-DO-NOT-LEAK', MIOON_ENABLE_LIVE_PROVIDER: '1', [`${spec.prefix}_APPROVED_ASSET_SHA256`]: sha256, ...options.env };
  const calls: [string, RequestInit & {body: string; headers: Record<string, string>}][] = [], queue = [...responses];
  const fetchImpl: typeof fetch = async (...args) => { calls.push(args as unknown as (typeof calls)[number]); const item = queue.shift(); if (item instanceof Error) throw item; if (typeof item === 'function') return (item as (...values: Parameters<typeof fetch>) => Response)(...args); if (!item) throw new Error('No real fetch is allowed in an offline test'); return item as Response; };
  const provider = spec.factory({ root, env, fetchImpl, ...(options.now ? { now: options.now } : {}) });
  const input = { model: spec.model, prompt: 'A synthetic geometric shape moves slowly.', duration: 4, aspectRatio: '9:16', referenceAssets: [], parameters: {} };
  const reference = { id: 'approved', path: file, mimeType: 'image/png', sha256, width: 360, height: 640 };
  const url = kind === 'ark' ? `https://${spec.host}/output.mp4?signature=PRIVATE-URL` : `https://${spec.host}/v1beta/files/offline123:download?alt=media`;
  return { root, bytes, file, reference, provider, input, calls, queue, env, spec, url };
}

for (const kind of Object.keys(specs) as (keyof typeof specs)[]) {
  test(`${kind}: constructor/capabilities/reconcile/cancel are offline and secrets never appear`, async t => {
    const { provider, calls, input } = await fixture(t, kind, [], { env: { MIOON_ENABLE_LIVE_PROVIDER: '0' } });
    assert.equal(provider.capabilities.status, 'disabled');
    assert.equal(provider.capabilities.configured, true);
    assert.equal(provider.capabilities.enabled, false);
    assert.equal(provider.capabilities.modelCapabilities[0].id, specs[kind].model);
    assert.equal(JSON.stringify(provider.capabilities).includes('SECRET-DO-NOT-LEAK'), false);
    assert.equal(await (provider.reconcile as (id?: string) => ReturnType<typeof provider.reconcile>)('unknown'), null);
    assert.deepEqual((await (provider.cancel as (id?: string) => ReturnType<typeof provider.cancel>)('unknown')).scope, 'local');
    assert.equal(provider.validate(input), true);
    await assert.rejects(provider.submit(input), { code: 'PROVIDER_DISABLED' });
    await assert.rejects(provider.poll(specs[kind].id), { code: 'PROVIDER_DISABLED' });
    assert.equal(calls.length, 0);
    const unconfigured = specs[kind].factory({ env: {}, fetchImpl: () => assert.fail('network') } as unknown as Parameters<typeof createArkProvider>[0]);
    assert.equal(unconfigured.capabilities.status, 'not_configured');
    assert.ok(unconfigured.capabilities.configuration.missing.includes(specs[kind].key));
  });

  test(`${kind}: synchronous validation needs metadata only and rejects unsupported inputs`, async t => {
    const { provider, input, reference, calls } = await fixture(t, kind);
    const { path: ignored, ...metadata } = reference;
    assert.equal(provider.validate({ ...input, referenceAssets: [metadata] }), true);
    for (const patch of [{ model: 'other' }, { duration: 2 }, { duration: 4.5 }, { aspectRatio: '1:1' }, { prompt: '' }, { prompt: 'x'.repeat(1001) }, { parameters: { seed: 1 } }, { parameters: { resolution: '1080p' } }, { referenceAssets: [metadata, metadata] }, { referenceAssets: [{ ...metadata, mimeType: 'image/webp' }] }]) assert.throws(() => provider.validate({ ...input, ...patch }));
    assert.equal(calls.length, 0);
  });

  for (const withImage of [false, true]) test(`${kind}: maps ${withImage ? 'first-frame image' : 'text'} to one fixed-origin POST`, async t => {
    const { provider, spec, input, reference, calls, bytes } = await fixture(t, kind, [json(specs[kind].accepted())]);
    assert.deepEqual(await provider.submit({ ...input, referenceAssets: withImage ? [reference] : [] }, { requestId: 'once' }), { providerJobId: spec.id });
    assert.equal(calls.length, 1);
    const [url, init] = calls[0], body = JSON.parse(init.body);
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.equal(init.headers['Idempotency-Key'], undefined);
    if (kind === 'ark') {
      assert.equal(url, 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
      assert.equal(init.headers.Authorization, 'Bearer SECRET-DO-NOT-LEAK');
      assert.equal(body.model, spec.model); assert.equal(body.duration, 4); assert.equal(body.ratio, withImage ? 'adaptive' : '9:16');
      assert.equal(body.generate_audio, false); assert.equal(body.output_format, 'mp4'); assert.equal(body.resolution, '720p');
      assert.equal(body.content[0].text, input.prompt);
      assert.equal(body.content.length, withImage ? 2 : 1);
      if (withImage) { assert.equal(body.content[1].role, 'first_frame'); assert.equal(body.content[1].image_url.url, `data:image/png;base64,${bytes.toString('base64')}`); }
    } else {
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning');
      assert.equal(init.headers['x-goog-api-key'], 'SECRET-DO-NOT-LEAK'); assert.equal(init.headers.Authorization, undefined);
      assert.deepEqual(body.parameters, { aspectRatio: '9:16', durationSeconds: 4, resolution: '720p', sampleCount: 1 });
      assert.equal(body.instances[0].prompt, input.prompt);
      if (withImage) assert.deepEqual(body.instances[0].image, { bytesBase64Encoded: bytes.toString('base64'), mimeType: 'image/png' });
      else assert.equal(body.instances[0].image, undefined);
    }
  });

  for (const [name, response, uncertain] of [
    ['network loss', () => { throw new Error('SECRET-DO-NOT-LEAK'); }, true],
    ['abort', () => { throw new DOMException('aborted', 'AbortError'); }, true],
    ['server error', () => json({ secret: 'SECRET-DO-NOT-LEAK' }, 500), true],
    ['request timeout', () => json({}, 408), true],
    ['conflict', () => json({}, 409), true],
    ['redirect', () => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }), true],
    ['invalid json', () => new Response('SECRET-DO-NOT-LEAK'), true],
    ['oversized response', () => new Response(JSON.stringify({ padding: 'x'.repeat(1024 * 1024) })), true],
    ['missing task identity', () => json({ accepted: true }), true],
    ['explicit rejection', () => json({ secret: 'SECRET-DO-NOT-LEAK' }, 400), false],
    ['quota rejection', () => json({}, 429), false],
  ]) test(`${kind}: ${name} preserves uncertainty and never duplicates POST`, async t => {
    const { provider, input, calls } = await fixture(t, kind, [response]);
    await assert.rejects(provider.submit(input), e => Boolean((e as RootFailure).uncertain) === uncertain && !JSON.stringify({ code: (e as RootFailure).code, message: (e as RootFailure).message }).includes('SECRET-DO-NOT-LEAK'));
    assert.equal(calls.length, 1);
    assert.equal(await (provider.reconcile as (id?: string) => ReturnType<typeof provider.reconcile>)('missing'), null);
    assert.equal(calls.length, 1);
  });

  test(`${kind}: validates approval/checksum/path/signature/size without transmitting`, async t => {
    const { provider, input, reference, calls, root, file, bytes } = await fixture(t, kind);
    const submit = (ref: { sha256: string; id: string; path: string; mimeType: string; width: number; height: number; }) => provider.submit({ ...input, referenceAssets: [ref] });
    await assert.rejects(submit({ ...reference, sha256: '0'.repeat(64) }), { code: 'REFERENCE_NOT_APPROVED' });
    await assert.rejects(submit({ ...reference, path: 'https://evil.test/image.png' }), { code: 'REFERENCE_UNAVAILABLE' });
    const outside = await sandbox(t), external = path.join(outside, 'external.png'); await writeFile(external, bytes);
    const linked = path.join(root, 'symlink.png'); await symlink(external, linked);
    await assert.rejects(submit({ ...reference, path: linked }), { code: 'UNSAFE_REFERENCE_PATH' });
    const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; await writeFile(file, changed);
    await assert.rejects(submit(reference), { code: 'REFERENCE_CHANGED' });
    await writeFile(file, 'not-an-image'); await assert.rejects(submit(reference), { code: 'INVALID_REFERENCE_TYPE' });
    await writeFile(file, Buffer.alloc(10 * 1024 * 1024 + 1)); await assert.rejects(submit(reference), { code: 'REFERENCE_TOO_LARGE' });
    assert.equal(calls.length, 0);
  });

  test(`${kind}: poll caches transient errors and successes, then resumes same ID`, async t => {
    let now = 0;
    const { provider, spec, calls } = await fixture(t, kind, [new Error('SECRET-DO-NOT-LEAK'), json(specs[kind].running()), json(specs[kind].failed())], { now: () => now });
    await assert.rejects(provider.poll('../../evil'), { code: 'INVALID_PROVIDER_TASK_ID' });
    await assert.rejects(provider.poll(spec.id), e => (e as RootFailure).retryable && !(e as RootFailure).uncertain);
    await assert.rejects(provider.poll(spec.id), e => (e as RootFailure).retryable);
    assert.equal(calls.length, 1);
    now = 10001; const values = await Promise.all([provider.poll(spec.id), provider.poll(spec.id), provider.poll(spec.id)]);
    assert.ok(values.every((x: { status: string; }) => x.status === 'running')); assert.equal(calls.length, 2);
    now = 20002; const result = await provider.poll(spec.id); assert.equal(result.status, 'failed');
    assert.equal(JSON.stringify(result).includes('SECRET-DO-NOT-LEAK'), false);
    assert.ok(calls.every(([, init]) => init.method === 'GET'));
  });

  test(`${kind}: downloads playable synthetic MP4 safely without exposing URLs`, async t => {
    const { provider, spec, calls, queue, url, root } = await fixture(t, kind);
    const source = path.join(root, 'source.mp4');
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=12', '-t', '0.5', '-an', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', source]);
    const bytes = await readFile(source); queue.push(json(spec.succeeded(url)), new Response(bytes));
    const target = path.join(root, 'download.mp4'), result = await provider.download(spec.id, target);
    assert.deepEqual(await readFile(target), bytes); assert.equal(result.isMock, false);
    assert.equal(JSON.stringify(result).includes('PRIVATE-URL'), false);
    assert.equal(calls[1][1].redirect, kind === 'veo' ? 'manual' : 'error');
    if (kind === 'ark') assert.equal(calls[1][1].headers, undefined);
    else { assert.deepEqual(calls[1][1].headers, { 'x-goog-api-key': 'SECRET-DO-NOT-LEAK' }); assert.equal(calls[1][0], 'https://generativelanguage.googleapis.com/v1beta/files/offline123:download?alt=media'); }
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', target]);
    assert.equal(JSON.parse(stdout).streams[0].codec_name, 'h264');
  });

  for (const url of ['http://evil.test/x.mp4', 'https://localhost/x.mp4', 'https://169.254.169.254/x.mp4', 'https://generativelanguage.googleapis.com.evil.test/x.mp4', 'https://user:pass@generativelanguage.googleapis.com/v1beta/files/test:download']) test(`${kind}: rejects unsafe output ${url}`, async t => {
    const { provider, spec, root, calls } = await fixture(t, kind, [json(specs[kind].succeeded(url))]);
    await assert.rejects(provider.download(spec.id, path.join(root, 'bad.mp4')), { code: 'UNAPPROVED_OUTPUT_HOST' });
    assert.equal(calls.length, 1);
  });

  test(`${kind}: expiry and broken stream refresh GET without another POST; partial files removed`, async t => {
    const { provider, spec, root, queue, url, calls } = await fixture(t, kind);
    queue.push(json(spec.succeeded(url)), new Response(null, { status: 403 }), json(spec.succeeded(url)), new Response('not an mp4'), json(spec.succeeded(url)), new Response(Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109])));
    const target = path.join(root, 'fresh.mp4');
    await assert.rejects(provider.download(spec.id, target), { code: 'DOWNLOAD_FAILED' });
    await assert.rejects(provider.download(spec.id, target), { code: 'INVALID_OUTPUT_MEDIA' });
    assert.equal((await readdir(root)).some(name => name.includes('.partial.')), false);
    await provider.download(spec.id, target);
    assert.equal(calls.length, 6); assert.ok(calls.every(([, init]) => init.method === 'GET'));
  });

  test(`${kind}: rejects output redirects, advertised oversize, and unmanaged destinations`, async t => {
    const { provider, spec, root, queue, url, calls } = await fixture(t, kind);
    queue.push(json(spec.succeeded(url)), new Response(null, { status: 302, headers: { location: 'https://evil.test/collect' } }), json(spec.succeeded(url)), new Response('x', { headers: { 'content-length': String(129 * 1024 * 1024) } }));
    const target = path.join(root, 'bad.mp4');
    await assert.rejects(provider.download(spec.id, path.join(root, '..', 'outside.mp4')), { code: 'UNSAFE_OUTPUT_PATH' });
    await assert.rejects(provider.download(spec.id, target), { code: kind === 'veo' ? 'UNAPPROVED_OUTPUT_HOST' : 'UNSAFE_OUTPUT_REDIRECT' });
    await assert.rejects(provider.download(spec.id, target), { code: 'OUTPUT_TOO_LARGE' });
    assert.equal(calls.length, 4);
    assert.equal((await readdir(root)).some(name => name.includes('.mp4')), false);
  });
}

test('Ark validates first-frame metadata AND actual dimensions before submission', async t => {
  const { provider, input, reference, file, calls } = await fixture(t, 'ark');
  for (const patch of [{ width: 200 }, { height: 7000 }, { width: 640 }, { width: undefined }]) assert.throws(() => provider.validate({ ...input, referenceAssets: [{ ...reference, ...patch }] }));
  const square = png(400, 400); await writeFile(file, square);
  const hash = createHash('sha256').update(square).digest('hex');
  const altered = createArkProvider({ root: path.dirname(file), env: { ARK_API_KEY: 'fixture', ARK_APPROVED_ASSET_SHA256: hash, MIOON_ENABLE_LIVE_PROVIDER: '1' }, fetchImpl: () => assert.fail('must reject actual dimensions before any POST') });
  await assert.rejects(altered.submit({ ...input, referenceAssets: [{ ...reference, sha256: hash }] }), { code: 'REFERENCE_ASPECT_RATIO_MISMATCH' });
  assert.equal(calls.length, 0);
});

for (const status of ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired']) test(`Ark maps ${status} status without leaking provider failure details`, async t => {
  const { provider, spec } = await fixture(t, 'ark', [json({ id: specs.ark.id, status, error: { message: 'SECRET-DO-NOT-LEAK' } })]);
  const result = await provider.poll(spec.id);
  assert.equal(result.status, ['queued', 'running'].includes(status) ? 'running' : status === 'succeeded' ? 'succeeded' : 'failed');
  assert.equal(JSON.stringify(result).includes('SECRET-DO-NOT-LEAK'), false);
});

test('Veo content-filtered or empty output is a terminal failure; raw safety text is private', async t => {
  for (const generated of [{ raiMediaFilteredCount: 1, raiMediaFilteredReasons: ['SECRET-DO-NOT-LEAK'] }, { generatedSamples: [] }]) {
    const { provider, spec } = await fixture(t, 'veo', [json({ ...specs.veo.accepted(), done: true, response: { generateVideoResponse: generated } })]);
    const result = await provider.poll(spec.id); assert.equal(result.status, 'failed'); assert.equal(JSON.stringify(result).includes('SECRET-DO-NOT-LEAK'), false);
  }
});

test('Veo rejects authenticated host on any route other than exact files download', async t => {
  const { provider, spec, root, calls } = await fixture(t, 'veo', [json(specs.veo.succeeded('https://generativelanguage.googleapis.com/v1beta/models/other'))]);
  await assert.rejects(provider.download(spec.id, path.join(root, 'bad.mp4')), { code: 'UNAPPROVED_OUTPUT_HOST' });
  assert.equal(calls.length, 1);
});

test('Veo never forwards its key to an explicitly allowlisted output CDN', async t => {
  const { provider, spec, root, calls } = await fixture(t, 'veo', [json(specs.veo.succeeded('https://verified-cdn.example/video.mp4')), new Response(Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109]))], { env: { VEO_OUTPUT_HOSTS: 'verified-cdn.example' } });
  await provider.download(spec.id, path.join(root, 'safe.mp4'));
  assert.equal(calls[1][1].headers, undefined);
});

test('Veo bounded redirects drop authentication even on same-origin first hop', async t => {
  const { provider, spec, root, calls, queue, url } = await fixture(t, 'veo', [], { env: { VEO_OUTPUT_HOSTS: 'verified-cdn.example' } });
  queue.push(json(spec.succeeded(url)), new Response(null, { status: 302, headers: { location: '/v1beta/files/second:download' } }), new Response(null, { status: 302, headers: { location: 'https://verified-cdn.example/output.mp4' } }), new Response(Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109])));
  await provider.download(spec.id, path.join(root, 'redirect.mp4'));
  assert.ok(calls[1][1].headers['x-goog-api-key']);
  assert.equal(calls[2][1].headers, undefined); assert.equal(calls[3][1].headers, undefined);
});

test('Veo redirect loops stop after three hops and never forward a key', async t => {
  const { provider, spec, root, calls, queue, url } = await fixture(t, 'veo', [], { env: { VEO_OUTPUT_HOSTS: 'verified-cdn.example' } });
  queue.push(json(spec.succeeded(url)), ...Array.from({ length: 4 }, () => new Response(null, { status: 302, headers: { location: 'https://verified-cdn.example/loop.mp4' } })));
  await assert.rejects(provider.download(spec.id, path.join(root, 'loop.mp4')), { code: 'UNSAFE_OUTPUT_REDIRECT' });
  assert.equal(calls.length, 5);
  assert.ok(calls.slice(2).every(([, init]) => init.headers === undefined));
});

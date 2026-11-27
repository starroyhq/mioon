import assert from 'node:assert/strict';
import {mkdtemp, open, rename, rm, stat, writeFile} from 'node:fs/promises';
import {createServer, get} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createFileResponses, type FileResponsesOptions} from '../apps/server/src/file-response.ts';
import {sendTimelinePreviewProxyMedia} from '../apps/server/src/timeline-preview-proxy-media.ts';
import {AppError} from '../packages/contracts/src/app-error.ts';

const bytes = Buffer.from('0123456789abcdef');
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
};

async function harness(t: test.TestContext, options: {openFile?: FileResponsesOptions['openFile']; leaseRelease?: () => void} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mioon-preview-proxy-http-'));
  const file = join(root, 'preview.mp4');
  await writeFile(file, bytes);
  const info = await stat(file);
  const files = createFileResponses({openFile: options.openFile, limits: {chunkBytes: 4}});
  const controller = new AbortController();
  const finished: Promise<void>[] = [];
  let revoked = false, releases = 0;
  const server = createServer(async (req, res) => {
    const done = deferred();
    finished.push(done.promise);
    try {
      await sendTimelinePreviewProxyMedia({req, res, files, signal: controller.signal, lease: {
        file, info,
        revalidate() { if (revoked) throw Error(`Revoked source ${file}`); },
        release() { releases++; options.leaseRelease?.(); },
      }});
    } catch (error) {
      if (!res.destroyed && !res.headersSent) {
        res.writeHead(error instanceof AppError ? error.status : 500);
        res.end(error instanceof Error ? error.message : String(error));
      }
    } finally {
      done.resolve();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await files.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, {recursive: true, force: true});
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/media/proxy`;
  return {file, url, controller, request: (init?: RequestInit) => fetch(url, init), settled: () => finished.at(-1),
    revoke() { revoked = true; }, get releases() { return releases; }};
}

test('preview MP4 streams full, partial and HEAD responses with one lease per request', async t => {
  const f = await harness(t);
  const full = await f.request();
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(full.headers.get('cache-control'), 'private, no-store');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('content-length'), String(bytes.length));
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  await f.settled();
  assert.equal(f.releases, 1);
  const range = await f.request({headers: {range: 'bytes=2-5'}});
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 2-5/${bytes.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(2, 6));
  await f.settled();
  assert.equal(f.releases, 2);
  const head = await f.request({method: 'HEAD', headers: {range: 'bytes=-4'}});
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-length'), '4');
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  await f.settled();
  assert.equal(f.releases, 3);
  const outOfBounds = await f.request({headers: {range: 'bytes=100-'}});
  assert.equal(outOfBounds.status, 416);
  assert.equal((await outOfBounds.arrayBuffer()).byteLength, 0);
  await f.settled();
  assert.equal(f.releases, 4);
});

test('preview only accepts GET and HEAD and releases the acquired lease on refusal', async t => {
  const f = await harness(t, {openFile: async () => { assert.fail('refusal must not open a file'); }});
  const response = await f.request({method: 'POST'});
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
  await response.arrayBuffer();
  await f.settled();
  assert.equal(f.releases, 1);
});

test('preview rejects a stale lease and a same-size file replacement before any bytes', async t => {
  const revoked = await harness(t, {openFile: async () => { assert.fail('revocation must fence the open'); }});
  revoked.revoke();
  const denied = await revoked.request({headers: {range: 'bytes=100-'}});
  assert.equal(denied.status, 404);
  assert.equal(await denied.text(), '预览代理不可用。');
  await revoked.settled();
  assert.equal(revoked.releases, 1);

  const replaced = await harness(t);
  await rename(replaced.file, replaced.file + '.original');
  await writeFile(replaced.file, Buffer.alloc(bytes.length, 0x78));
  const wrongFile = await replaced.request();
  assert.equal(wrongFile.status, 404);
  assert.equal(await wrongFile.text(), '预览代理不可用。');
  await replaced.settled();
  assert.equal(replaced.releases, 1);
});

test('preview revocation after the first chunk interrupts the transfer before the next chunk', async t => {
  const allowSecondChunk = deferred();
  let closed = false, releasedAfterClose = false;
  const f = await harness(t, {
    openFile: async (file, flags) => {
      const handle = await open(file, flags);
      return {
        stat: () => handle.stat(),
        close: async () => { await handle.close(); closed = true; },
        createReadStream: options => {
          const stream = handle.createReadStream(options);
          const read = stream._read.bind(stream);
          let started = false;
          t.mock.method(stream, '_read', (size: number) => {
            if (!started) { started = true; read(size); return; }
            void allowSecondChunk.promise.then(() => { if (!stream.destroyed) read(size); });
          });
          return stream;
        },
      };
    },
    leaseRelease: () => { releasedAfterClose = closed; },
  });
  const received: Buffer[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const request = get(f.url, response => {
        response.on('data', (chunk: Buffer) => {
          received.push(chunk);
          f.revoke();
          allowSecondChunk.resolve();
        });
        response.on('error', error => response.complete ? reject(error) : resolve());
        response.on('end', () => reject(Error('Revoked response completed')));
      });
      request.on('error', reject);
    });
  } finally {
    allowSecondChunk.resolve();
  }
  await f.settled();
  assert.deepEqual(Buffer.concat(received), bytes.subarray(0, 4));
  assert.equal(f.releases, 1);
  assert.equal(releasedAfterClose, true);
});

test('preview cancellation during open releases the lease after closing the late descriptor', async t => {
  const opening = deferred(), resumeOpen = deferred();
  let closed = false, attachedStream = false, releasedAfterClose = false;
  const f = await harness(t, {
    openFile: async (file, flags) => {
      opening.resolve();
      await resumeOpen.promise;
      const handle = await open(file, flags);
      return {stat: () => handle.stat(), close: async () => { await handle.close(); closed = true; },
        createReadStream: options => { attachedStream = true; return handle.createReadStream(options); }};
    },
    leaseRelease: () => { releasedAfterClose = closed; },
  });
  const requestDone = f.request().then(() => assert.fail('Cancelled request returned headers'), () => {});
  try {
    await opening.promise;
    f.controller.abort();
    await requestDone;
    assert.equal(f.releases, 0);
  } finally {
    resumeOpen.resolve();
  }
  await f.settled();
  assert.equal(attachedStream, false);
  assert.equal(f.releases, 1);
  assert.equal(releasedAfterClose, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {MEDIA_PULL_CHUNK_BYTES, MEDIA_RUNTIME_LIMITS, checkMediaEffect, runStreaming, runStreamingWithBackpressure} from '../packages/business/src/media-runtime.mjs';
import {mediaConfigurationError, mediaExecutable} from '../packages/business/src/media-environment.mjs';
import {hasUnconfirmedMediaProcesses, interruptedMediaError, mediaInterrupted, onMediaInterruption, onMediaProcess,
  spawnMedia, terminateMediaProcess, terminateMediaProcesses, throwIfMediaAborted} from '../packages/business/src/media-processes.mjs';
import {createStreamingMediaRuntime} from '../packages/business/src/media-streaming-runtime.ts';

test('new async pipe lane pauses at one callback and excludes consumer backpressure from timeout', {timeout: 10000}, async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let calls = 0, bytes = 0;
  const pending = runStreamingWithBackpressure(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(262144,17))'], {
    timeout: 250, maxStdoutBytes: 262144, maxStderrBytes: 65536,
    async onStdout(chunk) {calls++; if (calls === 1) {entered.resolve(); await release.promise;} bytes += chunk.length;},
  });
  await entered.promise; await delay(350);
  assert.equal(calls, 1, 'Only one awaited stdout chunk is admitted');
  release.resolve(); const result = await pending;
  assert.equal(bytes, 262144); assert.equal(result.stdoutBytes, bytes);
});

test('cancelled backpressured callback joins exact child close rather than releasing on kill', {timeout: 10000}, async () => {
  const controller = new AbortController(), entered = Promise.withResolvers(), events = [], off = onMediaProcess(event => events.push(event));
  try {
    const pending = runStreamingWithBackpressure(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(1048576));setInterval(()=>{},1000)'], {
      signal: controller.signal, timeout: 3000, maxStdoutBytes: 1048576, maxStderrBytes: 65536,
      async onStdout() {entered.resolve(); await new Promise(resolve => controller.signal.addEventListener('abort', resolve, {once: true}));},
    });
    const rejected = assert.rejects(pending, error => error.code === 'MEDIA_CANCELLED' && error.terminationUnconfirmed !== true);
    await entered.promise; controller.abort(); await rejected;
    assert.deepEqual(events.map(event => event.type), ['started', 'exited']);
  } finally {off();}
});

test('old synchronous pipe lane still rejects asynchronous callbacks', {timeout: 10000}, async () => {
  await assert.rejects(runStreaming(process.execPath, ['-e', 'process.stdout.write("old")'], {
    maxStdoutBytes: 100, maxStderrBytes: 65536, async onStdout() {},
  }), {code: 'MEDIA_INVALID_CONFIGURATION'});
});

test('cancellation retains callback ownership after exact child close until the consumer joins', {timeout: 10000}, async t => {
  const controller = new AbortController(), entered = Promise.withResolvers(), release = Promise.withResolvers(), exited = Promise.withResolvers();
  const events = [], off = onMediaProcess(event => {events.push(event); if (event.type === 'exited') exited.resolve();});
  t.after(() => {controller.abort(); release.resolve(); off();});
  let settled = false, failures = 0;
  const work = runStreamingWithBackpressure(process.execPath, ['-e', 'process.stdout.write("x");setInterval(()=>{},1000)'], {
    signal: controller.signal, onStdout: async () => {entered.resolve(); await release.promise;},
    onFailure(error) {assert.equal(error.code, 'MEDIA_CANCELLED'); failures++;},
  });
  work.then(() => {settled = true;}, () => {settled = true;});
  const rejection = assert.rejects(work, {code: 'MEDIA_CANCELLED'});
  await entered.promise; controller.abort(); await exited.promise; await delay(20);
  assert.equal(settled, false, 'A closed child cannot release an awaited consumer callback');
  release.resolve(); await rejection;
  assert.equal(failures, 1); assert.deepEqual(events.map(event => event.type), ['started', 'exited']);
  assert.deepEqual(await terminateMediaProcesses(), []);
});

test('active timeout resumes only after the backpressured callback joins and reaps the exact idle child', {timeout: 10000}, async t => {
  const controller = new AbortController(), entered = Promise.withResolvers(), release = Promise.withResolvers(), events = [];
  const off = onMediaProcess(event => events.push(event));
  t.after(() => {controller.abort(); release.resolve(); off();});
  let failures = 0;
  const work = runStreamingWithBackpressure(process.execPath, ['-e', 'process.stdout.write("x");setInterval(()=>{},1000)'], {
    signal: controller.signal, timeout: 250, onStdout: async () => {entered.resolve(); await release.promise;},
    onFailure(error) {failures++; assert.equal(error.code, 'MEDIA_TIMEOUT');},
  });
  const rejection = assert.rejects(work, {code: 'MEDIA_TIMEOUT'});
  await entered.promise; await delay(350); assert.equal(failures, 0);
  release.resolve(); await rejection;
  assert.equal(failures, 1); assert.deepEqual(events.map(event => event.type), ['started', 'exited']);
  assert.throws(() => process.kill(events[0].pid, 0), {code: 'ESRCH'});
});

test('nonzero process close wakes a blocked consumer and still joins its callback', {timeout: 10000}, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), failed = Promise.withResolvers(), controller = new AbortController();
  t.after(() => {controller.abort(); release.resolve();});
  let settled = false, failures = 0;
  const work = runStreamingWithBackpressure(process.execPath, ['-e', 'process.stdout.write("x");setTimeout(()=>process.exit(9),80)'], {
    signal: controller.signal, onStdout: async () => {entered.resolve(); await release.promise;},
    onFailure(error) {failures++; failed.resolve(error);},
  });
  work.then(() => {settled = true;}, () => {settled = true;});
  const rejection = assert.rejects(work, {code: 'MEDIA_EXIT_FAILED'});
  await entered.promise; assert.equal((await failed.promise).code, 'MEDIA_EXIT_FAILED');
  assert.equal(settled, false); release.resolve(); await rejection; assert.equal(failures, 1);
  assert.deepEqual(await terminateMediaProcesses(), []);
});

test('stderr overflow during backpressure wakes once and joins the callback even when the failure observer throws', {timeout: 10000}, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), failed = Promise.withResolvers(), exited = Promise.withResolvers();
  const controller = new AbortController(), events = [], off = onMediaProcess(event => {events.push(event); if (event.type === 'exited') exited.resolve();});
  t.after(() => {controller.abort(); release.resolve(); off();});
  let settled = false, failures = 0;
  const work = runStreamingWithBackpressure(process.execPath, ['-e', 'process.stdout.write("x");setTimeout(()=>process.stderr.write("private"),80);setInterval(()=>{},1000)'], {
    signal: controller.signal, maxStderrBytes: 0, onStdout: async () => {entered.resolve(); await release.promise;},
    onFailure(error) {failures++; failed.resolve(error); throw Error('Observer cannot defeat cleanup');},
  });
  work.then(() => {settled = true;}, () => {settled = true;});
  const rejection = assert.rejects(work, {code: 'MEDIA_OUTPUT_LIMIT'});
  await entered.promise; assert.equal((await failed.promise).code, 'MEDIA_OUTPUT_LIMIT'); await exited.promise;
  assert.equal(settled, false); release.resolve(); await rejection; assert.equal(failures, 1);
  assert.deepEqual(events.map(event => event.type), ['started', 'exited']);
});

test('consumer exceptions preserve their identity and reap the exact process', {timeout: 10000}, async () => {
  for (const failure of [Error('Trusted consumer failure'), null]) {
    const events = [], seen = [], off = onMediaProcess(event => events.push(event));
    try {
      await assert.rejects(runStreamingWithBackpressure(process.execPath, ['-e', 'process.stdout.write("x");setInterval(()=>{},1000)'], {
        onStdout() {throw failure;}, onFailure(error) {seen.push(error);},
      }), error => error === failure);
      assert.deepEqual(seen, [failure]); assert.deepEqual(events.map(event => event.type), ['started', 'exited']);
      assert.throws(() => process.kill(events[0].pid, 0), {code: 'ESRCH'});
    } finally {off();}
  }
});

test('continuous default accepts more than the legacy buffered ceiling and enforces exact byte budgets', {timeout: 10000}, async () => {
  const size = MEDIA_RUNTIME_LIMITS.stdoutBytes + 1; let bytes = 0;
  const result = await runStreamingWithBackpressure(process.execPath, ['-e', `process.stdout.write(Buffer.alloc(${size}))`], {
    onStdout(chunk) {bytes += chunk.length;},
  });
  assert.equal(bytes, size); assert.deepEqual(result, {stdoutBytes: size});
  assert.deepEqual(await runStreamingWithBackpressure(process.execPath, ['-e', 'process.stdout.write("😀é")'], {
    maxStdoutBytes: 6, onStdout() {},
  }), {stdoutBytes: 6});
  await assert.rejects(runStreamingWithBackpressure(process.execPath, ['-e', 'process.stdout.write("😀é")'], {
    maxStdoutBytes: 5, onStdout() {},
  }), {code: 'MEDIA_OUTPUT_LIMIT'});
});

test('invalid continuous options and pre-aborted work never spawn a process', async () => {
  const events = [], off = onMediaProcess(event => events.push(event)), controller = new AbortController(); controller.abort();
  try {
    await assert.rejects(runStreamingWithBackpressure(process.execPath, [], {onStdout() {}, signal: controller.signal}), {code: 'MEDIA_CANCELLED'});
    for (const options of [{}, {onStdout: 'invalid'}, {onStdout() {}, timeout: 0}, {onStdout() {}, maxStdoutBytes: MEDIA_RUNTIME_LIMITS.streamingStdoutBytes + 1},
      {onStdout() {}, maxStderrBytes: MEDIA_RUNTIME_LIMITS.stderrBytes + 1}, {onStdout() {}, beforeSpawn: async () => {}}]) {
      await assert.rejects(runStreamingWithBackpressure(process.execPath, [], options), {code: 'MEDIA_INVALID_CONFIGURATION'});
    }
    assert.deepEqual(events, []);
  } finally {off();}
});

test('unconfirmed close keeps global admission closed and joins the blocked consumer before rejecting', {timeout: 10000}, async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), realClose = Promise.withResolvers(), controller = new AbortController();
  const events = [], off = onMediaProcess(event => events.push(event));
  let child, originalEmit, heldClose, settled = false;
  const run = createStreamingMediaRuntime({
    limits: MEDIA_RUNTIME_LIMITS, pullChunkBytes: MEDIA_PULL_CHUNK_BYTES,
    mediaConfigurationError, mediaExecutable, checkMediaEffect, throwIfMediaAborted,
    mediaInterrupted, onMediaInterruption, interruptedMediaError, terminateMediaProcess,
    spawnMedia(...args) {
      child = spawnMedia(...args); originalEmit = child.emit.bind(child);
      child.emit = (event, ...values) => {
        if (event === 'close') {heldClose = values; realClose.resolve(); return true;}
        return originalEmit(event, ...values);
      };
      return child;
    },
  });
  try {
    const work = run(process.execPath, ['-e', 'process.stdout.write("x");setInterval(()=>{},1000)'], {
      signal: controller.signal, timeout: 5000, onStdout: async () => {entered.resolve(); await release.promise;},
    });
    work.then(() => {settled = true;}, () => {settled = true;});
    const rejection = assert.rejects(work, {code: 'MEDIA_CANCELLED', terminationUnconfirmed: true});
    await entered.promise; controller.abort(); await realClose.promise;
    // Delay only delivery of this exact child's real close. Its observed exit
    // cannot release either the process registry or this callback's ownership.
    await delay(3200);
    assert.equal(hasUnconfirmedMediaProcesses(), true); assert.equal(settled, false);
    assert.deepEqual(events.map(event => event.type), ['started']);
    await assert.rejects(runStreamingWithBackpressure(process.execPath, ['-e', 'process.stdout.write("blocked")'], {onStdout() {}}),
      {code: 'MEDIA_TERMINATION_UNCONFIRMED', terminationUnconfirmed: true});
    release.resolve(); await rejection;
    child.emit = originalEmit; originalEmit('close', ...heldClose);
    assert.equal(hasUnconfirmedMediaProcesses(), false);
    assert.deepEqual(events.map(event => event.type), ['started', 'exited']);
    assert.deepEqual(await runStreamingWithBackpressure(process.execPath, ['-e', 'process.stdout.write("ok")'], {onStdout() {}}), {stdoutBytes: 2});
  } finally {
    controller.abort(); release.resolve();
    if (child) {child.emit = originalEmit; if (heldClose) originalEmit('close', ...heldClose); await terminateMediaProcess(child);}
    off();
  }
});

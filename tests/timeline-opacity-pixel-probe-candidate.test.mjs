import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {
  createTimelineOpacityPixelProbeCandidate as createProbe,
  TIMELINE_OPACITY_PIXEL_PROBE_LIMITS_CANDIDATE as LIMITS,
} from '../packages/business/src/timeline-opacity-pixel-probe-candidate.ts';
import {compileTimelineOpacityFilterCandidate as compile} from '../packages/business/src/timeline-opacity-filter-candidate.ts';
import {OPACITY_ENVELOPE_PROFILE} from '../packages/contracts/src/timeline-opacity-envelope.ts';

const sequence = ['straight-identity', 'straight-curve', 'premultiplied-identity', 'premultiplied-curve'];
function expectedPixels(index) {
  const source = index < 2 ? [200, 100, 24, 128] : [100, 50, 12, 128];
  const frames = index % 2 === 0 ? [source, source, source] : index === 1 ?
    [[200, 100, 24, 0], [200, 100, 24, 64], source] : [[0, 0, 0, 0], [50, 25, 6, 64], source];
  return Buffer.from(frames.flatMap(pixel => Array.from({length: 4}, () => pixel).flat()));
}
function fakeRuntime(behavior = (child, _input, index) => {
  child.stdout.end(expectedPixels(index)); child.stderr.end();
  setImmediate(() => child.emit('close', 0, null));
}, {termination = 'exited', holdInput = false, resolveFailure = false, spawnFailure = false} = {}) {
  const spawned = [], stopped = [], removed = [], inputs = [];
  const runtime = {
    resolveFfmpeg() {if (resolveFailure) throw new Error('missing'); return '/synthetic/ffmpeg';},
    spawnMedia(command, argv, options, owner) {
      if (spawnFailure) throw new Error('missing');
      const index = spawned.length, child = new EventEmitter(), chunks = [];
      child.pid = 100 + index;
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({
        write(chunk, _encoding, done) {chunks.push(Buffer.from(chunk)); done();},
        final(done) {
          const input = Buffer.concat(chunks); inputs.push(input);
          if (!holdInput) done();
          setImmediate(() => behavior(child, input, index));
        },
      });
      spawned.push({child, command, argv, options, owner}); return child;
    },
    async terminateMediaProcess(child, options) {
      assert.ok(spawned.some(record => record.child === child), 'only this harness child is stopped');
      assert.deepEqual(options, {interrupted: false}); stopped.push(child);
      if (termination === 'exited') child.emit('close', null, 'SIGTERM');
      return {status: termination, forced: false};
    },
    onMediaInterruption(child, observer) {child.interrupt = observer; return () => removed.push(child);},
  };
  return {runtime, spawned, stopped, removed, inputs};
}

test('four synthetic cases run serially, use only generated filters and preserve binary pixel expectations', async () => {
  let previousClosed = true;
  const fixture = fakeRuntime((child, input, index) => {
    assert.equal(previousClosed, true); previousClosed = false;
    assert.equal(input.length, 48);
    assert.deepEqual([...input.subarray(0, 4)], index < 2 ? [200, 100, 24, 128] : [100, 50, 12, 128]);
    child.stdout.write(expectedPixels(index).subarray(0, 7));
    child.stdout.end(expectedPixels(index).subarray(7)); child.stderr.end();
    child.emit('exit', 0, null);
    setImmediate(() => {previousClosed = true; child.emit('close', 0, null);});
  });
  const report = await createProbe(fixture.runtime)();
  assert.equal(report.complete, true); assert.equal(report.failureCode, null);
  assert.equal(report.executable, '/synthetic/ffmpeg'); assert.equal(report.limits, LIMITS);
  assert.deepEqual(report.results.map(result => result.id), sequence);
  assert.deepEqual(report.results.map(result => result.status), ['passed', 'passed', 'passed', 'passed']);
  for (const result of report.results) {
    assert.equal(result.inputBytes, 48); assert.equal(result.stdoutBytes, 48); assert.equal(result.stderrBytes, 0);
    assert.equal(result.inputFinished, true); assert.equal(result.stdoutEnded, true); assert.equal(result.stderrEnded, true);
    assert.equal(result.closeObserved, true); assert.equal(result.exitCode, 0); assert.equal(result.signal, null);
    assert.equal(result.termination, null); assert.equal(result.maxChannelError, 0);
  }
  for (const [index, record] of fixture.spawned.entries()) {
    const curve = index % 2 !== 0, alphaMode = index < 2 ? 'straight' : 'premultiplied';
    const filter = compile({durationFrames: 3, opacityEnvelope: {profileId: OPACITY_ENVELOPE_PROFILE,
      points: curve ? [{frame: 0, opacity: 0}, {frame: 1, opacity: 0.5}, {frame: 2, opacity: 1}] : [{frame: 0, opacity: 1}]}}, 0, 3, alphaMode).filter;
    assert.equal(record.command, '/synthetic/ffmpeg');
    assert.deepEqual(record.options, {stdio: ['pipe', 'pipe', 'pipe']});
    assert.deepEqual(record.owner, {kind: 'ffmpeg-opacity-pixel-probe-candidate'});
    assert.deepEqual(record.argv, ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1',
      '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', '2x2', '-framerate', '30', '-i', 'pipe:0',
      '-vf', filter, '-frames:v', '3', '-an', '-threads:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1']);
    assert.notEqual(filter, '', 'identity runs exercise the generated opacity filter, not a bypass');
    assert.ok(record.argv.indexOf('-threads') < record.argv.indexOf('-i'), 'decoder threads are constrained before input');
    assert.ok(record.argv.indexOf('-threads:v') > record.argv.indexOf('-i'), 'rawvideo output threads are constrained after input');
    assert.equal(Object.isFrozen(record.argv), true);
  }
  assert.equal(fixture.stopped.length, 0); assert.equal(fixture.removed.length, 4);
});

test('one-byte rounding tolerance passes, larger pixel mismatch stops before case two', async () => {
  for (const delta of [1, 2]) {
    const fixture = fakeRuntime((child, _input, index) => {
      const output = expectedPixels(index); output[0] += delta;
      child.stdout.end(output); child.stderr.end(); setImmediate(() => child.emit('close', 0, null));
    });
    const report = await createProbe(fixture.runtime)();
    assert.equal(report.complete, delta === 1);
    assert.equal(fixture.spawned.length, delta === 1 ? 4 : 1);
    assert.equal(report.results[0].maxChannelError, delta);
    if (delta === 2) {
      assert.equal(report.results[0].failureCode, 'OPACITY_PROBE_PIXEL_MISMATCH');
      assert.deepEqual(report.results.slice(1).map(result => result.status), ['not-run', 'not-run', 'not-run']);
    }
  }
});

test('stdout/stderr hard limits stop and join only the exact owned child', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const fixture = fakeRuntime(child => child[stream].write(Buffer.alloc(stream === 'stdout' ? 49 : 65537)));
    const report = await createProbe(fixture.runtime)();
    assert.equal(report.complete, false); assert.equal(fixture.spawned.length, 1); assert.equal(fixture.stopped.length, 1);
    assert.equal(report.results[0].failureCode, stream === 'stdout' ? 'OPACITY_PROBE_STDOUT_LIMIT' : 'OPACITY_PROBE_STDERR_LIMIT');
    assert.equal(report.results[0][`${stream}Bytes`], stream === 'stdout' ? 49 : 65537, 'observed overflow is reported without retaining it');
    assert.equal(report.results[0].closeObserved, true); assert.equal(report.results[0].termination, 'exited');
    assert.deepEqual(report.results.slice(1).map(result => result.status), ['not-run', 'not-run', 'not-run']);
  }
});

test('exact stderr cap is admitted without retaining or exposing diagnostics', async () => {
  const fixture = fakeRuntime((child, _input, index) => {
    child.stdout.end(expectedPixels(index)); child.stderr.end(Buffer.alloc(65536, 0x61));
    setImmediate(() => child.emit('close', 0, null));
  });
  const report = await createProbe(fixture.runtime)();
  assert.equal(report.complete, true);
  assert.deepEqual(report.results.map(result => result.stderrBytes), [65536, 65536, 65536, 65536]);
  assert.ok(!JSON.stringify(report).includes('aaaa'), 'report contains counts only');
});

test('later failure preserves the prior independent result and skips all later probes', async () => {
  const fixture = fakeRuntime((child, _input, index) => {
    child.stdout.end(expectedPixels(index)); child.stderr.end();
    setImmediate(() => child.emit('close', index === 1 ? 2 : 0, null));
  });
  const report = await createProbe(fixture.runtime)();
  assert.deepEqual(report.results.map(result => result.status), ['passed', 'failed', 'not-run', 'not-run']);
  assert.equal(fixture.spawned.length, 2); assert.equal(fixture.stopped.length, 0);
});

test('close/code0/no signal/full stdin and exact stdout are all required', async () => {
  for (const variant of ['short-output', 'nonzero', 'signal', 'unfinished-stdin', 'stdout-without-end', 'stderr-without-end']) {
    const fixture = fakeRuntime(child => {
      const output = expectedPixels(0);
      if (variant === 'stdout-without-end') child.stdout.write(output); else child.stdout.end(variant === 'short-output' ? output.subarray(0, 47) : output);
      if (variant !== 'stderr-without-end') child.stderr.end();
      setImmediate(() => child.emit('close', variant === 'nonzero' ? 1 : 0, variant === 'signal' ? 'SIGTERM' : null));
    }, {holdInput: variant === 'unfinished-stdin'});
    const report = await createProbe(fixture.runtime)();
    assert.equal(report.complete, false, variant); assert.equal(fixture.spawned.length, 1, variant);
    assert.equal(report.results[0].status, 'failed', variant); assert.equal(report.results[0].closeObserved, true, variant);
    assert.notEqual(report.results[0].failureCode, null, variant);
  }
});

test('exit alone cannot release the 5s execution fence; confirmed stop ends the sequence', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const fixture = fakeRuntime(child => child.emit('exit', 0, null));
  const pending = createProbe(fixture.runtime)();
  t.mock.timers.tick(4999); assert.equal(fixture.stopped.length, 0); assert.equal(fixture.spawned.length, 1);
  t.mock.timers.tick(1);
  const report = await pending;
  assert.equal(report.results[0].failureCode, 'OPACITY_PROBE_TIMEOUT');
  assert.equal(report.results[0].status, 'failed'); assert.equal(report.results[0].termination, 'exited');
  assert.equal(fixture.spawned.length, 1); assert.equal(fixture.stopped.length, 1);
});

test('unconfirmed or unowned stop is uncertain and never launches another case', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  for (const termination of ['unconfirmed', 'unowned']) {
    const fixture = fakeRuntime(() => {}, {termination});
    const pending = createProbe(fixture.runtime)(); t.mock.timers.tick(5000);
    const report = await pending;
    assert.equal(report.results[0].status, 'uncertain');
    assert.equal(report.results[0].failureCode, 'OPACITY_PROBE_TERMINATION_UNCONFIRMED');
    assert.equal(report.results[0].closeObserved, false); assert.equal(report.results[0].termination, termination);
    assert.equal(fixture.spawned.length, 1); assert.equal(fixture.stopped.length, 1);
  }
});

test('all three pipe errors and external scoped interruption stop serial probing', async () => {
  for (const stream of ['stdin', 'stdout', 'stderr', 'interrupt']) {
    const fixture = fakeRuntime(child => {
      if (stream === 'interrupt') child.interrupt(); else child[stream].emit('error', new Error('synthetic'));
    });
    const report = await createProbe(fixture.runtime)();
    assert.equal(report.complete, false); assert.equal(report.results[0].status, 'failed');
    assert.equal(fixture.spawned.length, 1); assert.equal(fixture.stopped.length, 1);
    assert.equal(report.results[0].failureCode, stream === 'interrupt' ? 'OPACITY_PROBE_INTERRUPTED' : `OPACITY_PROBE_${stream.toUpperCase()}_FAILED`);
  }
});

test('unavailable executable or synchronous spawn failure cannot retry or fall back', async () => {
  for (const options of [{resolveFailure: true}, {spawnFailure: true}]) {
    const fixture = fakeRuntime(undefined, options), report = await createProbe(fixture.runtime)();
    assert.equal(report.complete, false); assert.equal(fixture.spawned.length, 0); assert.equal(fixture.stopped.length, 0);
    assert.equal(report.failureCode, options.resolveFailure ? 'OPACITY_PROBE_FFMPEG_UNAVAILABLE' : 'OPACITY_PROBE_SPAWN_FAILED');
    assert.equal(report.results.length, 4);
  }
});

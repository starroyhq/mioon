import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createTimelineAudioContinuousDecoder} from '../packages/business/src/timeline-audio-continuous-decoder.ts';
import {run, runStreamingWithBackpressure, checkMediaEffect} from '../packages/business/src/media-runtime.mjs';
import {withProbePermit} from '../packages/business/src/media-probe.mjs';
import {onMediaProcess} from '../packages/business/src/media-processes.mjs';

function wav() {
  const samples = 9600, bytes = Buffer.alloc(44 + samples * 4);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(192000, 28);
  bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 4, 40);
  for (let at = 0; at < samples; at++) {bytes.writeInt16LE(8192, 44 + at * 4); bytes.writeInt16LE(-8192, 46 + at * 4);}
  return bytes;
}

test('a short FFmpeg segment keeps its paused tail readable across the next transport block', {timeout: 15000}, async t => {
  const root = await mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'mioon-continuous-tail-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const file = path.join(root, 'controlled.wav'); await writeFile(file, wav());
  const decoder = createTimelineAudioContinuousDecoder({run, runStreamingWithBackpressure, checkMediaEffect, withProbePermit});
  const options = {signal: t.signal, beforeEffect() {}}, source = await decoder.probe(file, options);
  // A five-frame original segment starts one frame before the 20-second
  // transport boundary in the numeric fixture. The child can exit while its
  // callback still owns four frames. Node's stdio flush must not create a
  // concurrent callback or discard the remaining readable bytes/EOF.
  for (let round = 0; round < 8; round++) {
    const events = [], off = onMediaProcess(event => {if (event.kind === 'ffmpeg') events.push(event.type);});
    const cursor = decoder.open(file, source, {sourceInFrame: 0, frameCount: 5, trimStartFrame: 0}, options);
    try {
      const first = await cursor.read(1600); assert.equal(first.length, 12800);
      // Let the short child finish producing. Owned close intentionally may
      // remain pending until the paused readable tail is consumed; requiring
      // that ownership proof before the next pull would deadlock the test.
      await delay(50);
      const tail = await cursor.read(6400); assert.equal(tail.length, 51200);
      for (let at = 0; at < tail.length; at += 8) {assert.equal(tail.readFloatLE(at), 0.25); assert.equal(tail.readFloatLE(at + 4), -0.25);}
      await cursor.done;
      assert.deepEqual(events, ['started', 'exited']);
    } finally {off(); await cursor.close();}
  }
});

test('decoder rejects oversized backing stores even when a visible stream chunk is tiny', async () => {
  const source = {durationSeconds: 600, streamIndex: 0, container: 'wav'}, options = {signal: new AbortController().signal, beforeEffect() {}};
  const decoder = createTimelineAudioContinuousDecoder({checkMediaEffect, async runStreamingWithBackpressure(_command, _args, opts) {
    await opts.onStdout(Buffer.alloc(2 * 1024 * 1024).subarray(0, 8)); return {stdoutBytes: 8};
  }});
  const cursor = decoder.open('/synthetic/controlled.wav', source, {sourceInFrame: 0, frameCount: 1, trimStartFrame: 0}, options);
  await assert.rejects(cursor.read(1600), {code: 'AUDIO_PREVIEW_INVALID_PCM'}); await cursor.close();
});

test('truncation and a failing child wake a pending source read and never publish partial PCM', async () => {
  const source = {durationSeconds: 600, streamIndex: 0, container: 'wav'}, options = {signal: new AbortController().signal, beforeEffect() {}};
  for (const mode of ['truncated', 'failed']) {
    const decoder = createTimelineAudioContinuousDecoder({checkMediaEffect, async runStreamingWithBackpressure(_command, _args, opts) {
      await opts.onStdout(Buffer.alloc(8));
      if (mode === 'failed') {const error = Object.assign(Error('Synthetic child exit'), {code: 'MEDIA_EXIT_FAILED'}); opts.onFailure(error); throw error;}
      return {stdoutBytes: 8};
    }});
    const cursor = decoder.open('/synthetic/controlled.wav', source, {sourceInFrame: 0, frameCount: 1, trimStartFrame: 0}, options);
    await assert.rejects(cursor.read(1600), error => ['AUDIO_PREVIEW_TRUNCATED_PCM', 'MEDIA_EXIT_FAILED'].includes(error.code));
    await cursor.close();
  }
});

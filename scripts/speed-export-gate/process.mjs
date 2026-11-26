import {spawn, spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {loadavg} from 'node:os';

export const MiB = 1024 * 1024;
export const ffmpegBase = ['-nostdin', '-hide_banner', '-y', '-filter_threads', '1', '-filter_complex_threads', '1'];

export function loadSnapshot() {
  const top = spawnSync('/usr/bin/top', ['-l', '1', '-n', '0'], {
    env: {...process.env, LC_ALL: 'C'}, encoding: 'utf8', timeout: 4000,
  });
  const idle = top.stdout?.match(/([\d.]+)% idle/u);
  return {at: new Date().toISOString(), load: loadavg(), cpuIdlePercent: idle ? Number(idle[1]) : null};
}

export function command(binary, args, options = {}) {
  const done = spawnSync(binary, args, {timeout: 900_000, maxBuffer: 16 * MiB, ...options});
  if (done.error) throw done.error;
  if (done.status !== 0) {
    throw new Error(`Command failed (${done.status ?? done.signal}): ${done.stderr.toString().slice(-3000)}`);
  }
  return done.stdout;
}

export function media(ffmpeg, args, options) {
  return command(ffmpeg, [...ffmpegBase, '-loglevel', 'error', ...args], options);
}

export function compare(expected, actual) {
  const overlap = Math.min(expected.length, actual.length);
  let contentMismatches = 0;
  let firstMismatch = null;
  for (let index = 0; index < overlap; index++) {
    if (expected[index] !== actual[index]) {
      contentMismatches++;
      firstMismatch ??= {index, expected: expected[index], actual: actual[index]};
    }
  }
  const countDelta = actual.length - expected.length;
  if (countDelta !== 0) {
    firstMismatch ??= {index: overlap, expected: expected[overlap] ?? null, actual: actual[overlap] ?? null};
  }
  return {expectedCount: expected.length, actualCount: actual.length, countDelta, contentMismatches,
    firstMismatch, pass: countDelta === 0 && contentMismatches === 0};
}

export function startFfmpeg(ffmpeg, args, {stdin = false, stdout = false} = {}) {
  const start = performance.now();
  const child = spawn(ffmpeg, [...ffmpegBase, '-loglevel', 'info', '-benchmark', ...args],
    {stdio: [stdin ? 'pipe' : 'ignore', stdout ? 'pipe' : 'ignore', 'pipe']});
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => {
    stderr = (stderr + chunk).slice(-16000);
  });
  let error;
  child.once('error', cause => { error = cause; });
  const closed = new Promise(resolve => {
    child.once('close', (code, signal) => {
      // This macOS build reports Darwin ru_maxrss (bytes) under the KiB label.
      const rss = stderr.match(/bench: maxrss=(\d+)KiB/u);
      resolve({code, signal, error: error?.code ?? null, wallSeconds: (performance.now() - start) / 1000,
        peakRssBytes: rss ? Number(rss[1]) : null});
    });
  });
  let stopping;
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return closed;
    if (!stopping) {
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 1500);
      stopping = closed.finally(() => clearTimeout(force));
    }
    return stopping;
  };
  const timeout = setTimeout(() => { void stop(); }, 900_000);
  void closed.then(() => clearTimeout(timeout));
  return {child, closed, stop, async result() {
    const result = await closed;
    if (result.code !== 0 || result.error) {
      throw new Error(`FFmpeg failed (${result.error ?? result.code ?? result.signal}): ${stderr.slice(-3000)}`);
    }
    return result;
  }};
}

export function probeFrames(ffprobe, file) {
  const response = command(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_frames',
    '-show_streams', '-show_entries', 'frame=key_frame,best_effort_timestamp:stream=time_base',
    '-of', 'json', file]);
  const {frames, streams} = JSON.parse(response);
  if (streams?.[0]?.time_base !== '1/30000') throw new Error('Fixture must have a 1/30000 video time base');
  return frames.map((frame, ordinal) => ({ordinal, pts: frame.best_effort_timestamp, key: frame.key_frame === 1}));
}

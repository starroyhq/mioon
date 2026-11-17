import { spawn } from 'node:child_process';
import { open, rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Writable } from 'node:stream';
import type { MotionWindow } from './render.ts';

export type MotionFfmpegStage = 'intermediate' | 'composite';

export interface MotionFfmpegMeasurement {
  userSeconds: number;
  systemSeconds: number;
  elapsedSeconds: number;
  peakRssKiB: number;
  meanCpuPercent: number | null;
}

interface ExportOptions {
  window: MotionWindow;
  ffmpegPath: string;
  inputPath: string;
  intermediatePath: string;
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  signal?: AbortSignal;
  onFrame?: (frame: number) => void;
  onChild?: (pid: number, stage: MotionFfmpegStage) => void;
  onStageMeasurement?: (stage: MotionFfmpegStage, result: MotionFfmpegMeasurement) => void;
}

function writeFrame(stream: Writable, frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(frame, error => error ? reject(error) : resolve());
  });
}

function parseFfmpegMeasurement(stderr: string, stage: MotionFfmpegStage): MotionFfmpegMeasurement {
  const timings = stderr.match(/^bench: utime=(\d+(?:\.\d+)?)s stime=(\d+(?:\.\d+)?)s rtime=(\d+(?:\.\d+)?)s\s*$/m);
  const peak = stderr.match(/^bench: maxrss=(\d+)KiB\s*$/m);
  if (!timings || !peak) throw Error(`Motion prototype FFmpeg ${stage} benchmark statistics missing`);
  const userSeconds = Number(timings[1]);
  const systemSeconds = Number(timings[2]);
  const elapsedSeconds = Number(timings[3]);
  // FFmpeg 7.1.5 and 9.0.2 print Darwin's byte-valued ru_maxrss with a KiB suffix.
  const peakRssKiB = Number(peak[1]) / (process.platform === 'darwin' ? 1024 : 1);
  return {userSeconds, systemSeconds, elapsedSeconds, peakRssKiB,
    meanCpuPercent: elapsedSeconds > 0 ? 100 * (userSeconds + systemSeconds) / elapsedSeconds : null};
}

async function runFfmpeg(options: ExportOptions, stage: MotionFfmpegStage, args: string[],
  feed?: (stdin: Writable) => Promise<void>): Promise<void> {
  options.signal?.throwIfAborted();
  const measure = options.onStageMeasurement;
  const diagnostics = measure ? ['-loglevel', 'info', '-nostats', '-benchmark'] : ['-loglevel', 'error'];
  const child = spawn(options.ffmpegPath, ['-hide_banner', ...diagnostics, '-nostdin', '-y', ...args],
    { stdio: [feed ? 'pipe' : 'ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderrTail = '';
  if (measure) {
    // Only the trailing numeric benchmark fields leave this collector.
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4096);
    });
  } else child.stderr?.resume();
  child.stdin?.on('error', () => { /* writeFrame and close report the failure */ });
  let spawnError: Error | undefined;
  let closed = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => {
      closed = true;
      if (code === 0) resolve();
      else reject(Error(`Motion prototype FFmpeg ${stage} failed (${signal ?? code ?? (spawnError && 'spawn')})`));
    });
  });
  const stop = () => {
    if (closed || escalation) return;
    child.kill('SIGTERM');
    escalation = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 2000);
  };
  options.signal?.addEventListener('abort', stop, { once: true });
  try {
    if (child.pid !== undefined) options.onChild?.(child.pid, stage);
    if (options.signal?.aborted) stop();
    await Promise.all(feed && child.stdin ? [done, feed(child.stdin)] : [done]);
    options.signal?.throwIfAborted();
    if (measure) measure(stage, parseFfmpegMeasurement(stderrTail, stage));
  } finally {
    stop();
    await done.catch(() => {});
    clearTimeout(escalation);
    options.signal?.removeEventListener('abort', stop);
  }
}

export async function exportMotionVideo(options: ExportOptions): Promise<void> {
  const { window, inputPath, intermediatePath, outputPath, width, height, fps, frames, signal } = options;
  const outputs: string[] = [];
  let completed = false;
  const cancel = () => window.close();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    if (![inputPath, intermediatePath, outputPath].every(path => isAbsolute(path)) ||
      ![width, height, fps, frames].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw Error('Invalid motion prototype export settings');
    }
    for (const path of [intermediatePath, outputPath]) {
      signal?.throwIfAborted();
      const file = await open(path, 'wx');
      outputs.push(path);
      await file.close();
    }
    // FFV1 in Matroska retains every channel, including the straight alpha.
    await runFfmpeg(options, 'intermediate', [
      '-protocol_whitelist', 'pipe', '-f', 'rawvideo', '-pixel_format', 'rgba',
      '-video_size', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0',
      '-an', '-c:v', 'ffv1', '-pix_fmt', 'bgra', '-f', 'matroska', intermediatePath,
    ], async stdin => {
      for (let frame = 0; frame < frames; frame += 1) {
        signal?.throwIfAborted();
        const rgba = await window.render(frame);
        signal?.throwIfAborted();
        if (rgba.length !== width * height * 4) throw Error('Unexpected motion prototype frame size');
        // A write must drain before requesting the next frame.
        await writeFrame(stdin, rgba);
        options.onFrame?.(frame);
      }
      stdin.end();
    });
    window.close();
    await runFfmpeg(options, 'composite', [
      '-protocol_whitelist', 'file', '-i', inputPath,
      '-protocol_whitelist', 'file', '-i', intermediatePath,
      '-filter_complex', '[0:v][1:v]overlay=alpha=straight:eof_action=pass[v]',
      '-map', '[v]', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'fast',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-f', 'mp4', outputPath,
    ]);
    completed = true;
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    window.close();
    if (!completed) await Promise.all(outputs.map(path => rm(path, { force: true })));
  }
}

import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import {constants, mkdirSync} from 'node:fs';
import {copyFile, lstat} from 'node:fs/promises';
import {arch, cpus, release} from 'node:os';
import {join, resolve} from 'node:path';
import {app, screen} from 'electron';
import {identityForChannel} from '../../identity.ts';
import {fixture, runTool} from './fixture.ts';
import {compareLegacyCaptures, hashFrame, verifyCaptures} from './frame-verification.ts';
import {measurePixelDifferences, measureResources, sparseDistribution} from './measurement.ts';
import {createMotionWindow, motionCaptureMarkerHeight, registerMotionScheme} from './render.ts';
import type {MotionWindow} from './render.ts';
import {exportMotionVideo} from './export.ts';

const {MIOON_MOTION_PROTOTYPE_ROOT: root, MIOON_MOTION_PROTOTYPE_CHANNEL: channel,
  MIOON_MOTION_PROTOTYPE_FFMPEG: ffmpeg, MIOON_MOTION_PROTOTYPE_FFPROBE: ffprobe,
  MIOON_MOTION_PROTOTYPE_OUTPUT: output, MIOON_MOTION_PROTOTYPE_PREVIEW: preview,
  MIOON_MOTION_PROTOTYPE_SOFTWARE: software, MIOON_MOTION_PROTOTYPE_LEGACY: compareLegacy} = process.env;

async function verifyPreviewClock(window: MotionWindow, signal: AbortSignal): Promise<{frame: number; mediaTime: number}> {
  const check = window.window.webContents.executeJavaScript(`(async () => {
    const video = document.querySelector('video');
    const overlay = document.querySelector('#motion-overlay');
    await video.play();
    const until = performance.now() + 2500;
    while (Number(overlay.dataset.frame) < 3 && performance.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    video.pause();
    return {frame: Number(overlay.dataset.frame), mediaTime: Number(overlay.dataset.mediaTime)};
  })()`, true);
  const timeout = setTimeout(() => window.close(), 5_000);
  try {
    const result = await check as {frame: number; mediaTime: number};
    signal.throwIfAborted();
    assert.ok(result.frame >= 3 && result.frame < fixture.frames, 'Preview must advance using decoded video frames');
    assert.equal(result.frame, Math.round(result.mediaTime * fixture.fps), 'Preview frame must match the local media clock');
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

function assertChildExited(pid: number): void {
  assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
}

async function benchmark(directory: string, ffmpegPath: string, ffprobePath: string, signal: AbortSignal): Promise<void> {
  const {width, height, fps, frames} = fixture;
  const inputPath = join(directory, 'fixture.mp4');
  const intermediatePath = join(directory, 'overlay.mkv');
  const outputPath = join(directory, 'composite.mp4');
  const options = {assetsDirectory: join(directory, 'assets'), width, height};
  // Keep both legacy passes inside the same Electron process and CI job.
  const legacy = compareLegacy === '1' ? await compareLegacyCaptures({...options, signal}) : undefined;
  const exportWindow = await createMotionWindow({...options, mode: 'export', signal});
  const sampleFrames = [0, 3, 7, 13, 21, 60, 120, 140, 149];
  const samples = new Map<number, Buffer>();
  const digest = createHash('sha256');
  const frameHashes: string[] = [];
  let resources: ReturnType<typeof measureResources> | undefined;
  let renderMs = 0;
  let framesRendered = 0;
  let usage: object;
  let totalMs = 0;
  try {
    for (const frame of sampleFrames) samples.set(frame, await exportWindow.render(frame));
    assert.ok(new Set([...samples.values()].map(frame => createHash('sha256').update(frame).digest('hex'))).size >= 4,
      'Offscreen capture must include distinct points in the animation');
    assert.ok(samples.get(0)!.every(byte => byte === 0), 'First frame should be fully transparent');
    assert.ok(samples.get(frames - 1)!.every(byte => byte === 0), 'Last frame should be fully transparent');
    resources = measureResources();
    const started = performance.now();
    await exportMotionVideo({
      window: {...exportWindow, async render(frame) {
        const started = performance.now();
        const rgba = await exportWindow.render(frame);
        renderMs += performance.now() - started;
        framesRendered++;
        const expected = samples.get(frame);
        if (expected) assert.ok(rgba.equals(expected), `Frame ${frame} changed between export passes`);
        frameHashes.push(hashFrame(rgba));
        digest.update(rgba);
        return rgba;
      }},
      ffmpegPath, inputPath, intermediatePath, outputPath, width, height, fps, frames, signal,
      onStageMeasurement: resources.recordFfmpegStage,
    });
    totalMs = performance.now() - started;
    assert.equal(framesRendered, frames);
    assert.equal(exportWindow.captureStats.accepted, frames + sampleFrames.length, 'Every exported frame needs a pixel marker');
    assert.ok(exportWindow.window.isDestroyed(), 'Successful export must release its window');
  } finally {
    usage = resources?.finish() ?? {};
    exportWindow.close();
  }

  const encoded = await runTool('FFV1 decoded hash', ffmpegPath, ['-v', 'error', '-i', intermediatePath,
    '-map', '0:v:0', '-c:v', 'rawvideo', '-pix_fmt', 'rgba', '-f', 'hash', '-hash', 'sha256', '-']);
  const rgbaSha256 = digest.digest('hex');
  const frameVerification = await verifyCaptures({...options, signal}, frameHashes, rgbaSha256);
  assert.equal(encoded, `SHA256=${rgbaSha256}`, 'FFV1 intermediate must round-trip all RGBA bytes');
  const encodedMp4 = await runTool('MP4 probe', ffprobePath, ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,avg_frame_rate,nb_read_frames', '-of', 'json', outputPath]);
  assert.deepEqual(JSON.parse(encodedMp4).streams,
    [{codec_name: 'h264', width, height, avg_frame_rate: `${fps}/1`, nb_read_frames: String(frames)}]);

  // A regular preview surface is bounded by the host display's work area.
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const units = Math.min(40, Math.floor(workArea.width / 9), Math.floor((workArea.height - motionCaptureMarkerHeight) / 16));
  const comparisonSize = {width: 9 * units, height: 16 * units};
  const comparison = {...options, ...comparisonSize};
  const comparisonWindow = await createMotionWindow({...comparison, mode: 'export', signal});
  const comparisonFrames = new Map<number, Buffer>();
  try {
    for (const frame of sampleFrames) comparisonFrames.set(frame, await comparisonWindow.render(frame));
  } finally {
    comparisonWindow.close();
  }
  const previewWindow = await createMotionWindow({...comparison, mode: 'preview', signal});
  const channels: number[] = Array(256).fill(0);
  const pixels: number[] = Array(256).fill(0);
  const visiblePixels: number[] = Array(256).fill(0);
  let previewClock: Awaited<ReturnType<typeof verifyPreviewClock>>;
  try {
    previewClock = await verifyPreviewClock(previewWindow, signal);
    for (const [frame, expected] of comparisonFrames) {
      const actual = await previewWindow.render(frame);
      assert.equal(actual.length, expected.length);
      const nonEmpty = (rgba: Buffer) => rgba.some((byte, index) => index % 4 === 3 && byte !== 0);
      assert.equal(nonEmpty(actual), nonEmpty(expected), `Preview frame ${frame} must preserve layer visibility`);
      measurePixelDifferences(expected, actual, channels, pixels, visiblePixels);
    }
  } finally {
    previewWindow.close();
  }

  const covered = visiblePixels.reduce((count, value) => count + value, 0);
  assert.ok(covered > 0, 'Preview comparison must include visible pixels');
  const meanVisibleDelta = visiblePixels.reduce((sum, count, delta) => sum + count * delta, 0) / covered;
  const visibleFractionAbove32 = visiblePixels.slice(33).reduce((sum, count) => sum + count, 0) / covered;
  // Only this fixture at 360×640 has measured tolerances at both 1× and Retina scale.
  const tolerance = comparisonSize.width === 360 ? {meanVisibleDelta: 45, visibleFractionAbove32: 0.30} : undefined;
  if (tolerance) {
    assert.ok(meanVisibleDelta <= tolerance.meanVisibleDelta && visibleFractionAbove32 <= tolerance.visibleFractionAbove32,
      `Preview exceeds measured tolerance (mean ${meanVisibleDelta}, fraction above 32 ${visibleFractionAbove32})`);
  }

  const cancellation = new AbortController();
  const cancelSignal = AbortSignal.any([signal, cancellation.signal]);
  const canceledWindow = await createMotionWindow({...options, mode: 'export', signal: cancelSignal});
  const canceledIntermediate = join(directory, 'canceled.mkv');
  const canceledOutput = join(directory, 'canceled.mp4');
  const children: number[] = [];
  const canceled = new Error('Prototype benchmark cancellation after frame 4');
  try {
    await assert.rejects(exportMotionVideo({
      window: canceledWindow,
      ffmpegPath, inputPath, intermediatePath: canceledIntermediate, outputPath: canceledOutput, width, height, fps, frames,
      signal: cancelSignal, onFrame(frame) { if (frame === 4) cancellation.abort(canceled); },
      onChild: pid => children.push(pid),
    }), error => error === canceled);
    assert.equal(children.length, 1);
    children.forEach(assertChildExited);
    assert.ok(canceledWindow.window.isDestroyed(), 'Canceled export must release its window');
    await assert.rejects(lstat(canceledIntermediate), {code: 'ENOENT'});
    await assert.rejects(lstat(canceledOutput), {code: 'ENOENT'});
  } finally {
    canceledWindow.close();
  }
  const ffmpegVersion = (await runTool('FFmpeg version', ffmpegPath, ['-version'])).split(/\s+/)[2];
  if (output) {
    const destination = resolve(output);
    await copyFile(intermediatePath, join(destination, 'overlay.mkv'), constants.COPYFILE_EXCL);
    await copyFile(outputPath, join(destination, 'composite.mp4'), constants.COPYFILE_EXCL);
  }
  console.log(JSON.stringify({
    host: {os: process.platform, release: release(), arch: arch(), cpu: cpus()[0]?.model, electron: process.versions.electron, ffmpeg: ffmpegVersion},
    renderer: software === '1' ? 'software' : 'default',
    gpuFeatures: app.getGPUFeatureStatus(), fixture, renderMs, totalMs, renderFps: frames / (renderMs / 1000), resources: usage,
    repeat: {frames: sampleFrames, byteIdentical: true}, rgbaSha256, ffv1RoundTrip: true,
    frameVerification: {exportReadback: exportWindow.captureStats, ...frameVerification}, legacy,
    preview: {...comparisonSize, devicePixelRatio: previewWindow.devicePixelRatio, clock: previewClock, frames: sampleFrames, maximumDelta: pixels.reduce((max, count, delta) => count ? delta : max, 0),
      channelDeltaCounts: sparseDistribution(channels), pixelMaxDeltaCounts: sparseDistribution(pixels),
      visiblePremultipliedPixelMaxDeltaCounts: sparseDistribution(visiblePixels), meanVisibleDelta, visibleFractionAbove32, tolerance},
    mp4: true, cancellation: {afterFrame: 4, windowClosed: true, ffmpegExited: true, partialOutputsRemoved: true},
  }, null, 2));
}

async function main(): Promise<void> {
  if (!root || !ffmpeg || !ffprobe || channel !== 'development') throw new Error('Development prototype launcher is required');
  const directory = root;
  const profile = join(directory, 'profile');
  mkdirSync(profile, {mode: 0o700});
  app.setName(identityForChannel(channel).productName);
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  app.setAppLogsPath(join(profile, 'logs'));
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('disable-background-networking');
  if (software === '1') app.disableHardwareAcceleration();
  registerMotionScheme();
  app.on('window-all-closed', () => {});
  const abort = new AbortController();
  const stop = () => abort.abort(new Error('Prototype interrupted'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await app.whenReady();
  if (preview === '1') {
    const window = await createMotionWindow({assetsDirectory: join(directory, 'assets'),
      width: fixture.width, height: fixture.height, mode: 'preview', showPreview: true, signal: abort.signal});
    if (!window.window.isDestroyed()) await new Promise<void>(resolve => window.window.once('closed', resolve));
  } else {
    await benchmark(directory, ffmpeg, ffprobe, abort.signal);
  }
}

void main().then(() => app.exit(0), error => {
  console.error(error instanceof Error ? error.message : 'Motion prototype failed');
  app.exit(1);
});

/** Synthetic media for SP-I0. Everything is generated locally; no downloads of
 * test media and no committed media files. */
import {spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import path from 'node:path';

export function runFfmpeg(ffmpeg, args, options = {}) {
  const done = spawnSync(ffmpeg, ['-nostdin', '-y', '-v', 'error', ...args],
    {encoding: 'utf8', timeout: options.timeout ?? 900_000, maxBuffer: 8 * 1024 * 1024});
  if (done.error) throw done.error;
  if (done.status !== 0) throw new Error(`ffmpeg failed (${done.status}): ${done.stderr.slice(-1200)}`);
  return done;
}

const portraitSpec = {width: 1080, height: 1920, fps: 30, sourceFrames: 150, seconds: 5};

export function generatePortrait(ffmpeg, dir) {
  mkdirSync(dir, {recursive: true});
  const file = path.join(dir, 'portrait.mkv');
  runFfmpeg(ffmpeg, ['-f', 'lavfi', '-i', `testsrc2=s=${portraitSpec.width}x${portraitSpec.height}:r=30:d=5`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-threads', '2', '-pix_fmt', 'yuv420p', file]);
  return {file, ...portraitSpec};
}

const analyticFps = 30, analyticWidth = 320, analyticHeight = 180, analyticFrames = 60;

function rawVideo(ffmpeg, filter, file) {
  runFfmpeg(ffmpeg, ['-f', 'lavfi', '-i', filter, '-frames:v', String(analyticFrames),
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p', file]);
}

export function generateAnalytic(ffmpeg, dir) {
  mkdirSync(dir, {recursive: true});
  const common = {width: analyticWidth, height: analyticHeight, fps: analyticFps, sourceFrames: analyticFrames};
  const sceneCut = path.join(dir, 'scene-cut.yuv');
  rawVideo(ffmpeg, `color=c=red:s=${analyticWidth}x${analyticHeight}:r=30:d=1[a];` +
    `color=c=blue:s=${analyticWidth}x${analyticHeight}:r=30:d=1[b];[a][b]concat=n=2:v=1:a=0,format=yuv420p`, sceneCut);
  // Motion samples: 120 fps ground truth, then every 4th frame becomes the
  // 30 fps input. At 0.25x, output frame j is exactly high-fps frame j.
  const highFps = 120, highFrames = 240;
  const highRaw = (filter, file) => runFfmpeg(ffmpeg, ['-f', 'lavfi', '-i', filter,
    '-frames:v', String(highFrames), '-f', 'rawvideo', '-pix_fmt', 'yuv420p', file]);
  const moving = speed => `color=c=black:s=${analyticWidth}x${analyticHeight}:r=${highFps}:d=2,format=yuv420p[bg];` +
    `color=c=white:s=60x60:r=${highFps}:d=2,format=yuv420p[sq];` +
    `[bg][sq]overlay=x='-40+${speed}*t':y=60,format=yuv420p`;
  const occlusionTruth = path.join(dir, 'occlusion-120.yuv');
  highRaw(moving(240) + `[occluded];color=c=gray:s=40x100:r=${highFps}:d=2,format=yuv420p[bar];` +
    `[occluded][bar]overlay=x=140:y=40,format=yuv420p`, occlusionTruth);
  const occlusion = path.join(dir, 'occlusion.yuv');
  runFfmpeg(ffmpeg, ['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${analyticWidth}x${analyticHeight}`,
    '-r', String(highFps), '-i', occlusionTruth, '-vf', "select='not(mod(n,4))'", '-vsync', 'vfr',
    '-frames:v', String(analyticFrames), '-f', 'rawvideo', '-pix_fmt', 'yuv420p', occlusion]);
  const fastTruth = path.join(dir, 'fast-motion-120.yuv');
  highRaw(moving(900), fastTruth);
  const fastMotion = path.join(dir, 'fast-motion.yuv');
  runFfmpeg(ffmpeg, ['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${analyticWidth}x${analyticHeight}`,
    '-r', String(highFps), '-i', fastTruth, '-vf', "select='not(mod(n,4))'", '-vsync', 'vfr',
    '-frames:v', String(analyticFrames), '-f', 'rawvideo', '-pix_fmt', 'yuv420p', fastMotion]);
  return {
    sceneCut: {file: sceneCut, cutSourceFrame: 30, ...common},
    occlusion: {file: occlusion, groundTruth: occlusionTruth, ...common},
    fastMotion: {file: fastMotion, groundTruth: fastTruth, ...common},
  };
}

export function decodeRawToFile(ffmpeg, file, output, size, frames) {
  runFfmpeg(ffmpeg, ['-i', file, '-frames:v', String(frames), '-f', 'rawvideo', '-pix_fmt', 'yuv420p', output]);
  return path.resolve(output);
}

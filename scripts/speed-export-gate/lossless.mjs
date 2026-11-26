import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {openSync, closeSync, createReadStream, fsyncSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {cpus, loadavg} from 'node:os';
import path from 'node:path';
import {
  compileTimeMap, timeMapRootFrames, TIMELINE_TIME_MAP_BASIS_PROFILE,
} from '../../packages/contracts/src/timeline-time-map.ts';

const audioRate = 48_000;
const audioFrameBytes = 2 * 4;
const clockProfile = 'speed-export-gate-ordinal-v1';
const bt709 = {color_range: 'tv', color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709'};
const hdr10 = {color_range: 'tv', color_space: 'bt2020nc', color_transfer: 'smpte2084', color_primaries: 'bt2020'};
const colorOptions = {color_range: '-color_range', color_space: '-colorspace', color_transfer: '-color_trc',
  color_primaries: '-color_primaries', chroma_location: '-chroma_sample_location'};
const profiles = [
  {format: 'yuv420p', depth: 8, alpha: false, color: {...bt709, chroma_location: 'left'}},
  {format: 'yuv444p10le', depth: 10, alpha: false, color: hdr10},
  {format: 'yuv420p10le', depth: 10, alpha: false, color: {...hdr10, color_transfer: 'arib-std-b67', chroma_location: 'center'}},
  {format: 'yuva444p', depth: 8, alpha: true, color: bt709},
  {format: 'gbrap16le', depth: 16, alpha: true,
    color: {color_range: 'pc', color_space: 'gbr', color_transfer: 'bt709', color_primaries: 'bt709'}},
];

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonHash = value => hash(JSON.stringify(value));
async function hashFile(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
const writeJson = (file, data) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
const videoInput = (format, size, fps, colorArgs, file) => [
  '-f', 'rawvideo', '-pixel_format', format, '-video_size', size, '-framerate', fps, ...colorArgs, '-i', file,
];
const audioInput = file => ['-f', 'f32le', '-ar', String(audioRate), '-ch_layout', 'stereo', '-i', file];

function muxArgs(profile, width, height, fps, video, audio, file, threads = 1) {
  const colorArgs = Object.entries(profile.color).flatMap(([key, value]) => [
    colorOptions[key], value === 'gbr' ? 'rgb' : value,
  ]);
  return [
    '-noauto_conversion_filters', ...videoInput(profile.format, `${width}x${height}`, fps, colorArgs, video), ...audioInput(audio),
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'ffv1', '-level', '3', '-slicecrc', '1', '-threads:v', String(threads),
    ...(threads === 4 ? ['-slices', '4'] : []),
    '-pix_fmt', `+${profile.format}`, ...colorArgs, '-fps_mode', 'passthrough', '-c:a', 'pcm_f32le', file,
  ];
}

function sourcePattern(profile, width, height, fps) {
  const modulus = 2 ** profile.depth;
  const gradientScale = profile.depth === 16 ? 73 : 1;
  const components = profile.format.startsWith('gbr') ? ['r', 'g', 'b', 'a'] : ['lum', 'cb', 'cr', 'a'];
  const planes = components.slice(0, profile.alpha ? 4 : 3).map((plane, index) =>
    `${plane}='mod(X*${17 * gradientScale + index * 4}+Y*${11 * gradientScale + index * 3}+N*${37 + index * 2}+${71 * index},${modulus})'`);
  return `nullsrc=s=${width}x${height}:r=${fps},format=${profile.format},geq=${planes.join(':')}`;
}

function frameBytesFor(profile, width, height) {
  const pixels = width * height;
  const components = profile.format.includes('420') ? 1.5 : (profile.alpha ? 4 : 3);
  return pixels * components * (profile.depth > 8 ? 2 : 1);
}

const rational = frame => ({kind: 'rational', numerator: String(frame), denominator: '1'});
const sampleBoundary = (ordinal, fps) => Number(BigInt(ordinal) * BigInt(audioRate) * BigInt(fps.fpsDenominator) / BigInt(fps.fpsNumerator));

function mapping(fps, direction) {
  const inputFrames = 19;
  const compiled = compileTimeMap({
    profile: TIMELINE_TIME_MAP_BASIS_PROFILE, sourceFps: fps, outputFps: fps,
    sourceRange: {start: rational(0), end: rational(inputFrames)},
    speed: {kind: 'constant', rate: {numerator: 3, denominator: 4}},
  });
  assert(compiled.ok, JSON.stringify(compiled));
  const frames = timeMapRootFrames(compiled.value, direction);
  assert(frames.ok, JSON.stringify(frames));
  return {inputFrames, mapHash: compiled.value.mapHash, frames: [...frames.value], fps, direction};
}

function makeClock(plan, mediaSha256) {
  const {fps, frames, mapHash, direction} = plan;
  return {
    profile: clockProfile, mediaSha256, mapHash, direction,
    timebase: {numerator: 1, denominator: fps.fpsNumerator}, frameCount: frames.length, audioRate,
    audioSampleCount: sampleBoundary(frames.length, fps),
    frames: frames.map((sourceFrame, ordinal) => ({
      ordinal, sourceFrame, ptsTick: String(BigInt(ordinal) * BigInt(fps.fpsDenominator)),
      startSample: sampleBoundary(ordinal, fps), endSample: sampleBoundary(ordinal + 1, fps),
    })),
  };
}

function validateClock(clock, plan, mediaBytes) {
  const mediaSha256 = hash(mediaBytes);
  assert.equal(clock.mediaSha256, mediaSha256, 'wrong intermediate');
  assert.deepEqual(clock, makeClock(plan, mediaSha256), 'invalid sidecar clock, ordinal or map');
}

function rangeFor(clock, start, end) {
  assert(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= clock.frameCount,
    'invalid half-open ordinal window');
  return {start, end, first: clock.frames[start], last: clock.frames[end - 1]};
}

function rejected(fn) {
  try { fn(); } catch (error) {
    if (error.code === 'ERR_ASSERTION') return true;
    throw error;
  }
  return false;
}

function formatEvidence(descriptor, profile) {
  const expectedColor = profile.color;
  return {
    decodedFormat: descriptor.name,
    componentDepths: descriptor.components.map(component => component.bit_depth),
    alpha: Boolean(descriptor.flags.alpha),
    expectedDepth: profile.depth, expectedAlpha: profile.alpha, expectedColor,
  };
}

export async function runLossless({ffmpeg, ffprobe, scratchDir, evidenceDir}) {
  const commands = [];
  const run = (binary, label, args, {allowFailure = false, measure = false} = {}) => {
    const executable = measure ? '/usr/bin/time' : binary;
    const processArgs = measure ? ['-l', binary, ...args] : args;
    const started = performance.now();
    const result = spawnSync(executable, processArgs, {maxBuffer: 16 * 1024 * 1024, timeout: 180_000,
      env: {...process.env, LC_ALL: 'C'}});
    const wallSeconds = (performance.now() - started) / 1000;
    const sanitize = value => value.replaceAll(scratchDir, '<scratch>').replaceAll(evidenceDir, '<evidence>');
    const entry = {label, binary: path.basename(binary), args: args.map(sanitize), status: result.status, wallSeconds,
      signal: result.signal, stderr: sanitize(result.stderr?.toString('utf8') ?? ''), errorCode: result.error?.code};
    if (measure) {
      const times = /([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/.exec(entry.stderr);
      const rss = /(\d+)\s+maximum resident set size/.exec(entry.stderr);
      entry.processUsage = {realSeconds: times ? Number(times[1]) : null, userSeconds: times ? Number(times[2]) : null,
        systemSeconds: times ? Number(times[3]) : null, peakRssBytes: rss ? Number(rss[1]) : null};
    }
    commands.push(entry);
    if (!allowFailure && (result.status !== 0 || result.error)) throw new Error(`${label} failed: ${entry.stderr || entry.errorCode}`);
    return {stdout: result.stdout, entry};
  };
  const ff = (label, args, options) => run(ffmpeg, label, [
    '-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-filter_threads', '1', ...args,
  ], options);
  const probe = (label, args) => JSON.parse(run(ffprobe, label, ['-v', 'error', ...args, '-of', 'json']).stdout);
  const local = name => path.join(scratchDir, name);
  const rawAudio = (name, sampleCount, file) => ff(name, [
    '-f', 'lavfi', '-i', `aevalsrc=0.6*sin(2*PI*(537*t+100*t*t))|0.27*cos(2*PI*(733*t+200*t*t)):s=${audioRate}:c=stereo`,
    '-af', `atrim=end_sample=${sampleCount}`, '-c:a', 'pcm_f32le', '-f', 'f32le', file,
  ]);
  const decodeVideo = (file, format, label, trim = []) => ff(label, [
    '-noauto_conversion_filters', '-threads', '1', '-i', file, '-map', '0:v:0', ...trim,
    '-c:v', 'rawvideo', '-threads:v', '1', '-pix_fmt', `+${format}`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-',
  ]).stdout;
  const decodeAudio = (file, label, trim = []) => ff(label, [
    '-noauto_conversion_filters', '-i', file, '-map', '0:a:0', ...trim, '-c:a', 'pcm_f32le', '-f', 'f32le', '-',
  ]).stdout;

  try {
    const rawFormats = probe('pixel-format-descriptors', ['-show_pixel_formats']).pixel_formats;
    const roundTrips = [];
    for (const [index, profile] of profiles.entries()) {
      const fps = index % 2 === 0 ? {fpsNumerator: 30, fpsDenominator: 1} : {fpsNumerator: 2997, fpsDenominator: 100};
      const fpsArg = `${fps.fpsNumerator}/${fps.fpsDenominator}`;
      const plan = mapping(fps, index % 2 === 0 ? 'forward' : 'reverse');
      const width = 96, height = 64;
      const size = frameBytesFor(profile, width, height);
      const name = profile.format;
      const synthesized = ff(`${name}: synthesize`, [
        '-f', 'lavfi', '-i', sourcePattern(profile, width, height, fpsArg), '-frames:v', String(plan.inputFrames),
        '-c:v', 'rawvideo', '-threads:v', '1', '-pix_fmt', `+${name}`, '-f', 'rawvideo', '-',
      ]).stdout;
      assert.equal(synthesized.length, plan.inputFrames * size);
      const expectedFrames = plan.frames.map(source => synthesized.subarray(source * size, (source + 1) * size));
      const video = Buffer.concat(expectedFrames);
      const videoInputFile = local(`${name}.raw`), audioInputFile = local(`${name}.f32`);
      const intermediate = local(`${name}.mkv`);
      writeFileSync(videoInputFile, video);
      rawAudio(`${name}: synthesize stereo`, sampleBoundary(plan.frames.length, fps), audioInputFile);
      const audio = readFileSync(audioInputFile);
      assert.equal(audio.length, sampleBoundary(plan.frames.length, fps) * audioFrameBytes);
      const encoded = ff(`${name}: mux FFV1 and PCM`,
        muxArgs(profile, width, height, fpsArg, videoInputFile, audioInputFile, intermediate), {allowFailure: true});
      if (encoded.entry.status !== 0) {
        roundTrips.push({format: name, encoded: false, pass: false, error: encoded.entry.stderr});
        continue;
      }
      const mediaBytes = readFileSync(intermediate);
      const streams = probe(`${name}: stream tags`, ['-show_streams', intermediate]).streams;
      const videoStream = streams.find(stream => stream.codec_type === 'video');
      const audioStream = streams.find(stream => stream.codec_type === 'audio');
      const format = formatEvidence(rawFormats.find(descriptor => descriptor.name === videoStream.pix_fmt), profile);
      const actualColor = Object.fromEntries(Object.keys(profile.color).map(key => [key, videoStream[key] ?? null]));
      const expectedColorSha256 = jsonHash(profile.color), actualColorSha256 = jsonHash(actualColor);
      const formatExact = videoStream.codec_name === 'ffv1' && format.decodedFormat === name &&
        format.alpha === format.expectedAlpha && format.componentDepths.every(depth => depth === format.expectedDepth);
      const decoded = decodeVideo(intermediate, videoStream.pix_fmt, `${name}: decode video`);
      const decodedAudio = decodeAudio(intermediate, `${name}: decode PCM`);
      const audioExact = audioStream.codec_name === 'pcm_f32le' && audioStream.sample_fmt === 'flt' &&
        audioStream.sample_rate === String(audioRate) && audioStream.channels === 2 && audio.equals(decodedAudio);
      const alphaSize = width * height * (profile.depth > 8 ? 2 : 1);
      const alphaBytes = buffer => Buffer.concat(plan.frames.map((_, ordinal) =>
        buffer.subarray((ordinal + 1) * size - alphaSize, (ordinal + 1) * size)));
      const alphaSha256 = profile.alpha ? hash(alphaBytes(video)) : null;
      const decodedAlphaSha256 = profile.alpha ? hash(alphaBytes(decoded)) : null;
      const sidecar = local(`${name}.clock.json`);
      writeJson(sidecar, makeClock(plan, hash(mediaBytes)));
      const clock = JSON.parse(readFileSync(sidecar, 'utf8'));
      validateClock(clock, plan, mediaBytes);
      const alteredClock = structuredClone(clock);
      alteredClock.frames[1].ptsTick = '0';
      const alteredOrdinal = structuredClone(clock);
      alteredOrdinal.frames[1].ordinal = 0;
      const invalidClockRejected = [
        () => validateClock(alteredClock, plan, mediaBytes),
        () => validateClock(alteredOrdinal, plan, mediaBytes),
        () => validateClock({...clock, mapHash: '0'.repeat(64)}, plan, mediaBytes),
        () => validateClock(clock, plan, Buffer.from('foreign intermediate')),
        () => rangeFor(clock, 0, clock.frameCount + 1),
      ].map(rejected);
      const windows = [];
      const boundaries = [0, 1, 2, 8, clock.frameCount - 1, clock.frameCount];
      const outputVideo = [], outputAudio = [];
      for (let cut = 1; cut < boundaries.length; cut++) {
        const {start, end, first, last} = rangeFor(clock, boundaries[cut - 1], boundaries[cut]);
        const actualVideo = decodeVideo(intermediate, videoStream.pix_fmt, `${name}: ordinal [${start},${end})`, [
          '-vf', `trim=start_frame=${start}:end_frame=${end}`,
        ]);
        const actualAudio = decodeAudio(intermediate, `${name}: samples [${first.startSample},${last.endSample})`, [
          '-af', `atrim=start_sample=${first.startSample}:end_sample=${last.endSample}`,
        ]);
        const wantedVideo = Buffer.concat(expectedFrames.slice(start, end));
        const wantedAudio = audio.subarray(first.startSample * audioFrameBytes, last.endSample * audioFrameBytes);
        outputVideo.push(actualVideo);
        outputAudio.push(actualAudio);
        windows.push({start, end, first, last, frames: actualVideo.length / size, samples: actualAudio.length / audioFrameBytes,
          expectedVideoSha256: hash(wantedVideo), videoSha256: hash(actualVideo), expectedAudioSha256: hash(wantedAudio),
          audioSha256: hash(actualAudio), pass: wantedVideo.equals(actualVideo) && wantedAudio.equals(actualAudio)});
      }
      const videoJoinedExact = video.equals(Buffer.concat(outputVideo)), audioJoinedExact = audio.equals(Buffer.concat(outputAudio));
      const containerPts = probe(`${name}: container timestamps`, ['-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=pts',
        intermediate]).frames.map(frame => frame.pts);
      const [containerNum, containerDen] = videoStream.time_base.split('/').map(Number);
      const clockErrors = containerPts.map((pts, ordinal) =>
        Number(BigInt(pts) * BigInt(containerNum) * BigInt(clock.timebase.denominator) -
          BigInt(clock.frames[ordinal].ptsTick) * BigInt(containerDen)));
      const clockEvidence = {sidecar: clock, containerTimebase: videoStream.time_base, containerPts,
        containerPtsDiffer: clockErrors.filter(error => error !== 0).length,
        containerMaxAbsoluteErrorMs: Math.max(...clockErrors.map(Math.abs)) * 1000 / (containerDen * clock.timebase.denominator),
        invalidClockRejected, windows, videoJoinedExact, audioJoinedExact};
      const pass = formatExact && video.equals(decoded) && alphaSha256 === decodedAlphaSha256 &&
        expectedColorSha256 === actualColorSha256 && audioExact && containerPts.length === clock.frameCount &&
        windows.every(window => window.pass) && videoJoinedExact && audioJoinedExact && invalidClockRejected.every(Boolean);
      roundTrips.push({format: name, fps: fpsArg, geometry: [width, height], direction: plan.direction,
        frames: plan.frames.length, samples: audio.length / audioFrameBytes, bytes: mediaBytes.length, formatExact,
        ...format, actualColor, expectedColorSha256, actualColorSha256,
        sourceVideoSha256: hash(video), decodedVideoSha256: hash(decoded),
        sourceFrameSha256: expectedFrames.map(hash), sourceAudioSha256: hash(audio), decodedAudioSha256: hash(decodedAudio),
        alphaSha256, decodedAlphaSha256, audioExact, clock: clockEvidence, pass});
    }

    const floatFile = local('float32-rejected.mkv');
    const floatProbe = ff('float32 video: strict rejection', [
      '-noauto_conversion_filters', '-f', 'lavfi', '-i', 'nullsrc=s=64x64:r=30,format=gbrpf32le',
      '-frames:v', '2', '-c:v', 'ffv1', '-pix_fmt', '+gbrpf32le', floatFile,
    ], {allowFailure: true}).entry;
    const float32Rejected = floatProbe.status > 0 && /common format|pixel format/i.test(floatProbe.stderr);
    const thresholds = {differentBytes: 0, differentDepthOrAlphaOrColorFields: 0, wrongOrdinalOrSample: 0,
      invalidSidecarsOrWindowsAllowed: 0, proxyBytesMax: 10 * 1024 ** 3, wallSecondsPerSourceSecondMax: 1,
      fourThreadPeakRssBytesMax: 1024 ** 3};
    const writeSpeed = [];
    let fourThreadOption;
    const width = 1080, height = 1920, fps = 30, sourceSeconds = 5;
    const audio = local('portrait.f32');
    rawAudio('portrait: synthesize stereo', sourceSeconds * audioRate, audio);
    for (const profile of [profiles[0], profiles[2], profiles[4]]) {
      const name = profile.format;
      const video = local('portrait.raw'), output = local('portrait.mkv');
      const synthetic = profile.alpha ? `:alpha=160,format=yuva444p16le,format=${name}` : `,format=${name}`;
      ff(`${name}: synthesize portrait`, [
        '-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:r=${fps}${synthetic}`,
        '-frames:v', String(sourceSeconds * fps), '-c:v', 'rawvideo', '-threads:v', '1', '-pix_fmt', `+${name}`,
        '-f', 'rawvideo', video,
      ]);
      const inputBytes = statSync(video).size + statSync(audio).size;
      assert.equal(statSync(video).size, frameBytesFor(profile, width, height) * sourceSeconds * fps);
      try {
        for (const threads of (profile.alpha ? [1, 4] : [1])) {
          const loadBefore = loadavg();
          const started = performance.now();
          const muxed = ff(`${name}: write portrait with ${threads} thread(s)`,
            muxArgs(profile, width, height, String(fps), video, audio, output, threads), {allowFailure: true, measure: true});
          let analysis;
          if (muxed.entry.status === 0) {
            const fd = openSync(output, 'r');
            try { fsyncSync(fd); } finally { closeSync(fd); }
            const wallSeconds = (performance.now() - started) / 1000;
            const fileBytes = statSync(output).size;
            const wallSecondsPerSourceSecond = wallSeconds / sourceSeconds;
            const pass = fileBytes <= thresholds.proxyBytesMax && wallSecondsPerSourceSecond <= thresholds.wallSecondsPerSourceSecondMax;
            analysis = {inputBytes, fileBytes, wallSeconds, wallSecondsPerSourceSecond, bytesPerSourceSecond: fileBytes / sourceSeconds,
              writeMiBPerWallSecond: fileBytes / (1024 ** 2 * wallSeconds), rawToProxyRatio: inputBytes / fileBytes,
              sameRateSecondsAtCacheLimit: Math.floor(thresholds.proxyBytesMax / (fileBytes / sourceSeconds)), pass};
          } else {
            analysis = {pass: false, error: muxed.entry.stderr};
          }
          const row = {format: name, geometry: [width, height], fps, sourceSeconds, threads,
            ffmpeg: muxed.entry.processUsage, logicalCpus: cpus().length, loadBefore, loadAfter: loadavg(), ...analysis};
          if (threads === 1) {
            writeSpeed.push(row);
          } else {
            fourThreadOption = row;
            if (muxed.entry.status === 0) {
              const expectedVideoSha256 = await hashFile(video);
              const expectedAudioSha256 = await hashFile(audio);
              const videoSha256 = ff('four-thread candidate: hash portrait video', [
                '-noauto_conversion_filters', '-threads', '4', '-i', output, '-map', '0:v:0', '-c:v', 'rawvideo',
                '-threads:v', '1', '-pix_fmt', `+${name}`, '-fps_mode', 'passthrough', '-f', 'hash', '-hash', 'sha256', '-',
              ]).stdout.toString().trim().split('=')[1];
              const audioSha256 = hash(decodeAudio(output, 'four-thread candidate: decode portrait PCM'));
              const roundTripExact = videoSha256 === expectedVideoSha256 && audioSha256 === expectedAudioSha256;
              const rss = row.ffmpeg.peakRssBytes;
              Object.assign(row, {expectedVideoSha256, videoSha256, expectedAudioSha256, audioSha256, roundTripExact,
                pass: row.pass && roundTripExact && rss !== null && rss <= thresholds.fourThreadPeakRssBytesMax});
            }
          }
          rmSync(output, {force: true});
        }
      } finally {
        rmSync(video, {force: true});
        rmSync(output, {force: true});
      }
    }
    return {thresholds, roundTrips, float32Video: {strictlyRejected: float32Rejected, status: floatProbe.status}, writeSpeed, fourThreadOption,
      pass: roundTrips.every(row => row.pass) && float32Rejected && writeSpeed.every(row => row.pass)};
  } finally {
    writeJson(path.join(evidenceDir, 'commands.json'), commands);
  }
}

/** Three-way interpolation measurement on the SP0 portrait sample. */
import {spawnSync} from 'node:child_process';
import {readFileSync, statSync, mkdirSync} from 'node:fs';
import path from 'node:path';

const encoder = ['-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2',
  '-bf', '0', '-g', '60', '-pix_fmt', 'yuv420p', '-r', '30'];
const endpoints = 'tpad=start=2:start_mode=clone:stop=2:stop_mode=clone,';
export const MODE_FILTERS = Object.freeze({
  off: endpoints + 'setpts=4*(PTS-STARTPTS),fps=30,trim=end_frame=600',
  blend: endpoints + 'setpts=4*(PTS-STARTPTS),framerate=fps=30:interp_start=0:interp_end=255,trim=end_frame=600',
  optical: endpoints + 'setpts=4*(PTS-STARTPTS),minterpolate=fps=30:mi_mode=mci:mc_mode=obmc:me_mode=bilat:me=epzs:mb_size=16:search_param=32:vsbmc=0,trim=end_frame=600',
});

function parseTimeStats(file) {
  let text = '';
  try {text = readFileSync(file, 'utf8');} catch {return {};}
  const cpu = text.match(/([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys/);
  const rss = text.match(/(\d+)\s+maximum resident set size/);
  return {userSeconds: cpu ? Number(cpu[2]) : null, systemSeconds: cpu ? Number(cpu[3]) : null,
    peakRssBytes: rss ? Number(rss[1]) : null};
}

export function probe(ffprobe, file) {
  const done = spawnSync(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,nb_read_frames,duration,codec_name', '-of', 'json', file],
    {encoding: 'utf8', timeout: 120_000});
  if (done.status !== 0) throw new Error(`ffprobe failed: ${done.stderr.slice(-500)}`);
  const stream = JSON.parse(done.stdout).streams?.[0] ?? {};
  return {width: stream.width, height: stream.height, rFrameRate: stream.r_frame_rate,
    avgFrameRate: stream.avg_frame_rate, nbFrames: Number(stream.nb_read_frames ?? stream.nb_frames), duration: Number(stream.duration),
    codec: stream.codec_name};
}

export function measureMode(ffmpeg, ffprobe, {input, filter, output, workRoot, name}) {
  mkdirSync(path.dirname(output), {recursive: true});
  const stats = `${output}.time`;
  const args = ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-filter_threads', '1',
    '-i', input, '-vf', filter, ...encoder, output];
  const start = process.hrtime.bigint();
  const done = spawnSync('/usr/bin/time', ['-l', '-o', stats, ffmpeg, ...args],
    {encoding: 'utf8', timeout: 900_000, maxBuffer: 16 * 1024 * 1024});
  const wallSeconds = Number(process.hrtime.bigint() - start) / 1e9;
  if (done.error) throw done.error;
  if (done.status !== 0) throw new Error(`${name} failed (${done.status}): ${done.stderr.slice(-1200)}`);
  const info = probe(ffprobe, output);
  return {name, filter, wallSeconds: Number(wallSeconds.toFixed(3)), ...parseTimeStats(stats),
    bytes: statSync(output).size, output: info,
    exact600: info.nbFrames === 600 && info.rFrameRate === '30/1' && info.width === 1080 && info.height === 1920};
}

export function measureAllModes(ffmpeg, ffprobe, input, workRoot) {
  mkdirSync(workRoot, {recursive: true});
  const rows = [];
  for (const [name, filter] of Object.entries(MODE_FILTERS)) {
    rows.push(measureMode(ffmpeg, ffprobe, {input, filter, name,
      output: path.join(workRoot, `portrait-${name}.mkv`), workRoot}));
  }
  return {inputSpec: {width: 1080, height: 1920, fps: '30/1', sourceFrames: 150, durationSeconds: 5},
    outputSpec: {rate: '1/4', fps: '30/1', frames: 600, durationSeconds: 20},
    codecThreads: 2, filterThreads: 1, measuredRuns: 1, rows};
}

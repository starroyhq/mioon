import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {cpus, totalmem} from 'node:os';
import path from 'node:path';
import {MEDIA_TOOLS_RELEASE, mediaToolsBuild} from '../../apps/desktop/src/media-tools.ts';
import {resolveTools} from '../speed-interp-phase/tools.mjs';
import {loadSnapshot} from './process.mjs';

const suites = {
  fast: ['./fast-path.mjs', 'runFastPath'],
  lookup: ['./video.mjs', 'runLookup'],
  lossless: ['./lossless.mjs', 'runLossless'],
  reverse: ['./video.mjs', 'runReverse'],
  segments: ['./segments.mjs', 'runSegments'],
  cancel: ['./segments.mjs', 'runCancel'],
  audio: ['./audio.mjs', 'runAudio'],
};

function writeJson(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function verifiedTools(scratch) {
  const release = MEDIA_TOOLS_RELEASE;
  const build = mediaToolsBuild(release, process.platform, process.arch);
  if (release.version !== '7.1.5-1' || !build) throw new Error('Expected Mioon media-tools 7.1.5-1 for this Mac architecture');
  const ffmpeg = process.env.MIOON_FFMPEG_PATH;
  const ffprobe = process.env.MIOON_FFPROBE_PATH;
  if (Boolean(ffmpeg) !== Boolean(ffprobe)) throw new Error('Set both MIOON_FFMPEG_PATH and MIOON_FFPROBE_PATH');
  const tools = ffmpeg ? {ffmpeg: path.resolve(ffmpeg), ffprobe: path.resolve(ffprobe)}
    : resolveTools(scratch);
  const identity = {release: release.version, source: ffmpeg ? 'supplied Mioon pair' : 'Mioon media-tools release'};
  for (const name of ['ffmpeg', 'ffprobe']) {
    const file = readFileSync(tools[name]);
    const sha256 = createHash('sha256').update(file).digest('hex');
    if (file.length !== build[name].unpackedBytes || sha256 !== build[name].unpackedSha256) {
      throw new Error(`${name} differs from Mioon media-tools ${release.version}`);
    }
    const version = execFileSync(tools[name], ['-version'], {encoding: 'utf8', timeout: 30_000}).split('\n')[0];
    if (!version.startsWith(`${name} version ${release.ffmpegVersion} `)) throw new Error(`Unexpected ${name} version`);
    identity[name] = {sha256, version};
  }
  return {ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, identity};
}

const [output, ...requested] = process.argv.slice(2);
if (output === '--help' || !output) {
  console.log('用法：node scripts/speed-export-gate/run-gate.mjs <新证据目录> [fast lookup lossless reverse segments cancel audio]');
  process.exit(output ? 0 : 1);
}
const names = requested.length ? [...new Set(requested)] : Object.keys(suites);
if (names.some(name => !Object.hasOwn(suites, name))) throw new Error('未知的量测项目');
const evidence = path.resolve(output);
mkdirSync(evidence, {mode: 0o700});
const scratch = mkdtempSync('/private/tmp/mioon-speed-export-');
try {
  const {ffmpeg, ffprobe, identity} = verifiedTools(scratch);
  const summary = {mediaTools: identity, machine: {arch: process.arch, platform: process.platform, node: process.version,
    logicalCpus: cpus().length, cpu: cpus()[0]?.model, memoryBytes: totalmem()}, suites: {}};
  for (const name of names) {
    const directory = path.join(scratch, name);
    const evidenceDir = path.join(evidence, name);
    mkdirSync(directory);
    mkdirSync(evidenceDir);
    const before = loadSnapshot();
    console.log(`开始 ${name}，CPU 空闲 ${before.cpuIdlePercent}%`);
    try {
      const [module, method] = suites[name];
      const run = (await import(module))[method];
      const result = await run({ffmpeg, ffprobe, scratchDir: directory, evidenceDir});
      if (typeof result.pass !== 'boolean') throw new Error('量测结果缺少通过状态');
      writeJson(path.join(evidenceDir, 'result.json'), result);
      summary.suites[name] = {status: result.pass ? 'pass' : 'fail', before, after: loadSnapshot()};
    } catch (error) {
      const diagnostic = String(error?.stack ?? error).replaceAll(scratch, '<scratch>')
        .replaceAll(evidence, '<evidence>').replace(/\/Users\/[^\s"'\x60:]+/gu, '<local-path>');
      writeJson(path.join(evidenceDir, 'error.json'), {diagnostic});
      summary.suites[name] = {status: 'error', before, after: loadSnapshot()};
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
    console.log(`${name} ${summary.suites[name].status}`);
    writeJson(path.join(evidence, 'summary.json'), summary);
  }
  process.exitCode = Object.values(summary.suites).some(row => row.status === 'error') ? 1
    : Object.values(summary.suites).some(row => row.status === 'fail') ? 2 : 0;
} finally {
  rmSync(scratch, {recursive: true, force: true});
}

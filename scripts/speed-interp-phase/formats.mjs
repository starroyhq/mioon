/** Direct minterpolate pixel-format admission. The filter must receive the
 * source format itself (`-noauto_conversion_filters`); anything else is a
 * silent 8-bit conversion, which the plan forbids for the optical profile. */
import {spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';

export const FORMAT_CANDIDATES = Object.freeze([
  'yuv410p', 'yuv411p', 'yuv420p', 'yuv422p', 'yuv440p', 'yuv444p',
  'yuvj420p', 'yuvj422p', 'yuvj444p', 'yuva420p', 'yuva422p', 'yuva444p', 'gray',
  'nv12', 'p010le', 'gray10le', 'gray16le', 'yuv420p10le', 'yuv420p12le', 'yuv444p16le',
  'yuva420p10le', 'gbrp', 'gbrp10le', 'rgb24', 'rgba', 'gbrpf32le',
]);

function run(ffmpeg, args, timeout = 120_000) {
  const done = spawnSync(ffmpeg, args, {encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024});
  return {status: done.status, stderr: done.stderr ?? '', error: done.error};
}

function makeInput(ffmpeg, dir, format) {
  const file = path.join(dir, `in-${format}.yuv`);
  const generated = run(ffmpeg, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i',
    'testsrc2=s=64x64:d=0.2:r=10', '-pix_fmt', format, '-f', 'rawvideo', file]);
  return generated.status === 0 ? file : null;
}

export function probeFormats(ffmpeg, workRoot) {
  const dir = path.join(workRoot, 'formats');
  mkdirSync(dir, {recursive: true});
  const filter = 'minterpolate=fps=20:mi_mode=mci:mc_mode=obmc:me_mode=bilat:me=epzs:mb_size=16:search_param=32:vsbmc=0';
  const accepted = [], rejected = [];
  for (const format of FORMAT_CANDIDATES) {
    const input = makeInput(ffmpeg, dir, format);
    if (!input) {rejected.push({format, reason: 'INPUT_GENERATION_UNSUPPORTED'}); continue;}
    const direct = run(ffmpeg, ['-nostdin', '-v', 'error', '-noauto_conversion_filters', '-f', 'rawvideo',
      '-pix_fmt', format, '-s', '64x64', '-r', '10', '-i', input, '-frames:v', '4', '-vf', filter, '-f', 'null', '-']);
    if (direct.status === 0) {accepted.push(format); continue;}
    const negative = run(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', format,
      '-s', '64x64', '-r', '10', '-i', input, '-frames:v', '4', '-vf', filter, '-f', 'null', '-']);
    rejected.push({format, reason: direct.stderr.split('\n').find(line => line.includes('do not have a common format')) ??
      direct.stderr.split('\n').find(line => line.length > 0) ?? 'FILTER_REJECTED', autoConversionSucceeded: negative.status === 0});
  }
  return {filter, accepted8BitPlanar: accepted, rejected,
    note: 'accepted list is the direct filter input set; YUVJ formats are 8-bit planar but limited-range deprecated inputs'};
}

export function probeFilterHelp(ffmpeg, workRoot) {
  const done = spawnSync(ffmpeg, ['-hide_banner', '-h', 'filter=minterpolate'], {encoding: 'utf8', timeout: 60_000});
  writeFileSync(path.join(workRoot, 'minterpolate-help.txt'), done.stdout + done.stderr);
  return {status: done.status, text: (done.stdout + done.stderr).slice(0, 20_000)};
}

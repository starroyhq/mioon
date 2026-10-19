import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, writeFile, realpath} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createMockRendererCapability} from '../verify/packages/business/src/providers/mock-renderer-capability.ts';
import {createMockProvider} from '../verify/packages/business/src/providers/mock.mjs';

const exec = promisify(execFile);
const out = path.dirname(new URL(import.meta.url).pathname);
const ffmpeg = process.env.MIOON_FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
const ffprobe = process.env.MIOON_FFPROBE_PATH || '/opt/homebrew/bin/ffprobe';
const results = {tools: {}, filterCapabilities: {}, parser: {}, commands: [], production: {}};
for (const [name, file] of [['ffmpeg', ffmpeg], ['ffprobe', ffprobe]]) {
  const {stdout} = await exec(file, ['-version']);
  results.tools[name] = {path: file, realpath: await realpath(file), version: stdout.split('\n')[0], configuration: stdout.split('\n').find(line => line.startsWith('configuration:'))};
}
const {stdout: listing} = await exec(ffmpeg, ['-hide_banner', '-filters']);
await writeFile(path.join(out, 'ffmpeg-filters.txt'), listing);
for (const name of ['drawtext', 'subtitles', 'hue', 'drawbox', 'scale', 'overlay', 'concat', 'testsrc2']) {
  results.filterCapabilities[name] = new RegExp(`^[TSC.]{2,3}\\s+${name}\\s+`, 'm').test(listing.split('\n').map(line => line.trim()).join('\n'));
}
for (const [label, text] of [['actual', listing], ['only-separator-removed', listing.replace(/^\s*------\s*\r?\n/m, '')]]) {
  const lacks = createMockRendererCapability({run: async () => text, throwIfMediaAborted() {}});
  results.parser[label] = {lacksDrawtext: await lacks()};
}
const common = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=24', '-t', '2'];
const graph = "hue=h=48,drawbox=x=0:y=0:w=iw:h=74:color=black@0.85:t=fill,drawtext=text='SIMULATED MOCK':fontcolor=white:fontsize=26:x=(w-tw)/2:y=20";
async function runCase(label, file, args) {
  const entry = {label, file, args};
  try { const result = await exec(file, args, {timeout: 30_000, maxBuffer: 4 * 1024 * 1024}); Object.assign(entry, {exitCode: 0, stdout: result.stdout, stderr: result.stderr}); }
  catch (error) { Object.assign(entry, {exitCode: error.code, signal: error.signal ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? ''}); }
  results.commands.push(entry);
  await writeFile(path.join(out, label + '.stderr.txt'), entry.stderr);
  return entry;
}
await runCase('mock-production-graph', ffmpeg, [...common, '-vf', graph, '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p', '-threads', '1', '-f', 'null', '-']);
const controlFile = path.join(out, 'control-hue-drawbox-h264.mp4');
await runCase('positive-control-hue-drawbox-h264', ffmpeg, [...common, '-vf', graph.slice(0, graph.indexOf(',drawtext=')), '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p', '-threads', '1', '-movflags', '+faststart', controlFile]);
const probe = await runCase('positive-control-ffprobe', ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', controlFile]);
if (probe.exitCode === 0) results.controlProbe = JSON.parse(probe.stdout);
const root = path.join(out, 'mock-workspace'); await mkdir(path.join(root, 'media'), {recursive: true});
const db = new DatabaseSync(':memory:');
try {
  const provider = createMockProvider({db, root});
  const accepted = await provider.submit({prompt: 'Local diagnostic', duration: 2, aspectRatio: '9:16', parameters: {scenario: 'success', delayMs: 0}, referenceAssets: []}, {requestId: 'local-diagnostic-1'});
  const id = accepted.providerJobId ?? accepted.id;
  results.production.poll = await provider.poll(id, {});
  try { await provider.download(id, path.join(root, 'media', 'mock.mp4'), {}); results.production.download = {unexpectedSuccess: true}; }
  catch (error) { results.production.download = {code: error.code, message: error.message, retryable: error.retryable}; }
} finally { db.close(); }
await writeFile(path.join(out, 'mock-diagnostics.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify({tools: results.tools, filterCapabilities: results.filterCapabilities, parser: results.parser, commands: results.commands.map(({label,exitCode,stderr}) => ({label,exitCode,stderr})), production: results.production}, null, 2));

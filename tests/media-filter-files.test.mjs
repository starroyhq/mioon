import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runStreaming} from '../packages/business/src/media-runtime.mjs';

test('real FFmpeg reads simple and complex filter files without putting graph bytes in argv', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-filter-files-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  for (const complex of [false, true]) {
    const script = path.join(root, `owned space ; ' 中文 ${complex}.filter`);
    const graph = `${complex ? '[0:v]' : ''}drawbox=x=0:y=0:w=8:h=16:color=white:t=fill,format=gray${complex ? '[outv]' : ''}`;
    await writeFile(script, graph, {flag:'wx', mode:0o600});
    const chunks = [], args = ['-hide_banner','-loglevel','error','-filter_threads','1','-filter_complex_threads','1',
      '-f','lavfi','-i','color=c=black:s=16x16:r=30',complex ? '-/filter_complex' : '-/filter:v',script,
      ...(complex ? ['-map','[outv]'] : []),'-frames:v','2','-an','-c:v','rawvideo','-pix_fmt','gray','-threads','1','-f','rawvideo','pipe:1'];
    assert.equal(args.includes(graph), false);
    await runStreaming('ffmpeg', args, {timeout:30000,maxStdoutBytes:512,maxStderrBytes:64*1024,onStdout:chunk=>chunks.push(Buffer.from(chunk))});
    const pixels = Buffer.concat(chunks); assert.equal(pixels.length, 512);
    for (let frame=0;frame<2;frame++) for (let y=0;y<16;y++) for (let x=0;x<16;x++)
      assert.equal(pixels[frame*256+y*16+x], x<8 ? 255 : 0);
    assert.equal(await readFile(script,'utf8'), graph);
  }
});

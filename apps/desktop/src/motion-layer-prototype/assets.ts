import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {build} from 'esbuild';
import {TIMELINE_SUBTITLE_FONT_SHA256} from '../../../../packages/contracts/src/timeline-subtitle-profile.ts';

/** Stage source-controlled renderer inputs and the caller's synthetic fixture in a fresh private directory. */
export async function prepareMotionAssets(root: string, assetsDirectory: string, videoPath: string): Promise<void> {
  const source = path.join(root, 'apps/web/src/motion-layer-prototype');
  const font = await readFile(path.join(root, 'packages/business/resources/subtitles/mioon-subtitle-cjk-sc-v1.otf'));
  if (createHash('sha256').update(font).digest('hex') !== TIMELINE_SUBTITLE_FONT_SHA256) {
    throw new Error('Motion prototype font hash mismatch');
  }

  await mkdir(assetsDirectory, {mode: 0o700});
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: [path.join(source, 'page.tsx')],
    outfile: path.join(assetsDirectory, 'page.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    define: {'process.env.NODE_ENV': '"production"'},
    legalComments: 'eof',
    write: false,
  });
  const script = bundle.outputFiles[0];
  if (bundle.outputFiles.length !== 1 || !script || path.basename(script.path) !== 'page.js') {
    throw new Error('Unexpected motion prototype bundle output');
  }
  await Promise.all([
    writeFile(script.path, script.contents, {flag: 'wx'}),
    writeFile(path.join(assetsDirectory, 'font.otf'), font, {flag: 'wx'}),
    copyFile(path.join(source, 'index.html'), path.join(assetsDirectory, 'index.html'), constants.COPYFILE_EXCL),
    copyFile(path.join(source, 'stylesheet.css'), path.join(assetsDirectory, 'stylesheet.css'), constants.COPYFILE_EXCL),
    copyFile(videoPath, path.join(assetsDirectory, 'video.mp4'), constants.COPYFILE_EXCL),
  ]);
}

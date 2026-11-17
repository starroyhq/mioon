import {spawn} from 'node:child_process';
import {access, mkdtemp, realpath, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {build} from 'esbuild';
import {prepareMotionAssets} from '../apps/desktop/src/motion-layer-prototype/assets.ts';
import {fixture, runTool} from '../apps/desktop/src/motion-layer-prototype/fixture.ts';

async function main(): Promise<void> {
  const {values} = parseArgs({options: {
    channel: {type: 'string'},
    preview: {type: 'boolean'},
    software: {type: 'boolean'},
    'compare-legacy': {type: 'boolean'},
    output: {type: 'string'},
  }});
  if (values.channel !== 'development' || (values.preview && (values.output || values['compare-legacy']))) {
    throw new Error('Usage: node scripts/motion-layer-prototype.ts --channel=development [--preview | --output=DIR] [--software] [--compare-legacy]');
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const temporary = await mkdtemp(join(await realpath(tmpdir()), 'mioon-motion-layer-'));
  const ffmpeg = process.env.MIOON_FFMPEG_PATH ?? 'ffmpeg';
  const ffprobe = process.env.MIOON_FFPROBE_PATH ?? 'ffprobe';
  const entry = join(temporary, 'main.cjs');
  const video = join(temporary, 'fixture.mp4');
  const assets = join(temporary, 'assets');
  try {
    // Use a generated clip so the preview and benchmark never read a project.
    await runTool('FFmpeg fixture', ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', `testsrc2=size=${fixture.width}x${fixture.height}:rate=${fixture.fps}`,
      '-frames:v', String(fixture.frames), '-c:v', 'libx264', '-threads', '2',
      '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video]);
    await prepareMotionAssets(root, assets, video);
    await build({
      absWorkingDir: root,
      entryPoints: ['apps/desktop/src/motion-layer-prototype/main.ts'],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      external: ['electron'],
    });
    const electron: string = createRequire(import.meta.url)('electron');
    await access(electron);
    const result = await new Promise<number>((resolve, reject) => {
      const child = spawn(electron, [entry], {
        stdio: ['ignore', 'inherit', 'pipe'],
        env: {...process.env, MIOON_MOTION_PROTOTYPE_CHANNEL: values.channel, MIOON_MOTION_PROTOTYPE_ROOT: temporary,
          MIOON_MOTION_PROTOTYPE_FFMPEG: ffmpeg, MIOON_MOTION_PROTOTYPE_FFPROBE: ffprobe,
          MIOON_MOTION_PROTOTYPE_PREVIEW: values.preview ? '1' : '0',
          MIOON_MOTION_PROTOTYPE_LEGACY: values['compare-legacy'] ? '1' : '0',
          MIOON_MOTION_PROTOTYPE_SOFTWARE: values.software ? '1' : '0',
          MIOON_MOTION_PROTOTYPE_OUTPUT: values.output ?? ''},
      });
      let diagnostics = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { diagnostics = (diagnostics + chunk).slice(-16_384); });
      const stop = () => child.kill('SIGTERM');
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      child.once('error', reject);
      child.once('close', (code, signal) => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        if (code !== 0 && diagnostics) {
          const redacted = diagnostics.replaceAll(root, '<workspace>/').replaceAll(temporary, '<scratch>')
            .replaceAll(homedir(), '<home>');
          process.stderr.write(redacted);
        }
        resolve(code ?? (signal === 'SIGINT' ? 130 : 1));
      });
    });
    process.exitCode = result;
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Motion prototype failed');
  process.exitCode = 1;
}

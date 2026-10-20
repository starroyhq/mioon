import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startServer} from '../apps/server/src/index.ts';
import {command, executable} from '../.github/scripts/media-environment.ts';
import {exerciseComposition, smokeEnvironment} from '../.github/scripts/desktop-smoke.ts';

// Source-only integration of the exact native-smoke HTTP recipe. It does not
// claim Electron window, signing, notarization or native shutdown verification.
// This file belongs to Linux full; the portable lane runs the pure helper file.
test('native CI composition recipe uses real shared HTTP and produces authenticated 720p audio-video MP4', {timeout: 180000}, async () => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-actions-composition-'));
  const names = ['MIOON_FFMPEG_PATH', 'MIOON_FFPROBE_PATH', 'MIOON_ENABLE_LIVE_PROVIDER'] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const ffmpeg = await executable('ffmpeg', process.env.MIOON_FFMPEG_PATH), ffprobe = await executable('ffprobe', process.env.MIOON_FFPROBE_PATH);
    process.env.MIOON_FFMPEG_PATH = ffmpeg; process.env.MIOON_FFPROBE_PATH = ffprobe; process.env.MIOON_ENABLE_LIVE_PROVIDER = '0';
    const env = smokeEnvironment(process.env, path.join(directory, 'user-data'), ffmpeg, ffprobe);
    const video = path.join(directory, 'synthetic.mp4'), audio = path.join(directory, 'synthetic.wav');
    await command(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x18bf57:s=320x180:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-n', video], 'SYNTHETIC_VIDEO_FAILED', {env});
    await command(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:a', 'pcm_s16le', '-n', audio], 'SYNTHETIC_AUDIO_FAILED', {env});
    server = await startServer({dataDir: path.join(directory, 'workspace'), port: 0});
    const checks: string[] = [], phases: string[] = [];
    const result = await exerciseComposition({origin: server.url, token: server.token, video, audio, ffprobe, directory, env,
      onCheck: name => { checks.push(name); }, onPhase: phase => { phases.push(phase); }});
    assert.deepEqual(phases, ['seed', 'render']);
    assert.deepEqual(checks, ['anonymous-http-rpc-denied', 'project-import-and-multitrack-edit-through-public-http-rpc', 'real-authenticated-mp4-with-video-audio-and-expected-geometry']);
    assert.equal(result.width, 1280); assert.equal(result.height, 720); assert.ok(result.bytes > 1000);
  } finally {
    await server?.close();
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    await rm(directory, {recursive: true, force: true});
  }
});

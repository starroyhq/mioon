import test from 'node:test';
import assert from 'node:assert/strict';
import {FFMPEG_LIBRARIES as CI_LIBRARIES} from '../.github/scripts/install-ffmpeg.ts';
import {FFMPEG_LIBRARIES, FFMPEG_VERSION, FONTCONFIG_RUNTIME_OPTIONS, MACOS_DEPLOYMENT_TARGET, MEDIA_TOOLS_VERSION, SOURCES, assetName, buildEnvironment, curlArguments, ffmpegConfigureArguments,
  listedNames, manifestName, minimumMacOS, sourcesBundleName, unexpectedLinks} from '../.github/scripts/build-media-tools.ts';
import {FFMPEG_SOURCE} from '../.github/scripts/install-ffmpeg.ts';

test('every source is pinned to an HTTPS archive with a SHA-256 and the CI FFmpeg mirror', () => {
  assert.equal(new Set(SOURCES.map(entry => entry.name)).size, SOURCES.length);
  for (const entry of SOURCES) {
    assert.equal(new URL(entry.url).protocol, 'https:', entry.name);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/u, entry.name);
    assert.match(entry.file, /^[a-z0-9.-]+\.tar\.(?:xz|gz|bz2)$/u, entry.name);
    assert.ok(entry.license.length > 0, entry.name);
  }
  const ffmpeg = SOURCES.find(entry => entry.name === 'ffmpeg')!;
  assert.equal(ffmpeg.version, FFMPEG_VERSION);
  assert.equal(ffmpeg.url, FFMPEG_SOURCE.url);
  assert.equal(ffmpeg.sha256, FFMPEG_SOURCE.sha256);
  assert.deepEqual(SOURCES.filter(entry => entry.role === 'shipped').map(entry => entry.name).sort(),
    ['expat', 'ffmpeg', 'fontconfig', 'freetype', 'fribidi', 'harfbuzz', 'libass', 'x264', 'zimg']);
  assert.ok(MEDIA_TOOLS_VERSION.startsWith(`${FFMPEG_VERSION}-`));
  // Downloads ignore ~/.curlrc (`-q` must come first), fail on HTTP errors and never leave HTTPS.
  const curl = curlArguments('https://example.test/a.tar.xz', '/work/a.tar.xz.download');
  assert.equal(curl[0], '-q');
  for (const [flag, value] of [['--proto', '=https'], ['--proto-redir', '=https'], ['--output', '/work/a.tar.xz.download']]) assert.equal(curl[curl.indexOf(flag) + 1], value, flag);
  assert.ok(curl.includes('--fail') && curl.at(-1) === 'https://example.test/a.tar.xz');
});

test('FFmpeg is configured statically, without network protocols, with the libraries the application uses', () => {
  const args = ffmpegConfigureArguments('/work/prefix', 'arm64', '/sdk');
  for (const required of ['--disable-autodetect', '--disable-network', '--disable-shared', '--enable-static', '--pkg-config-flags=--static', '--disable-ffplay', '--enable-gpl']) {
    assert.ok(args.includes(required), required);
  }
  for (const library of FFMPEG_LIBRARIES) assert.ok(args.includes(`--enable-${library}`), library);
  // Same libraries as the Linux CI toolchain, except encoders the application never invokes.
  assert.deepEqual(CI_LIBRARIES.filter(name => !FFMPEG_LIBRARIES.includes(name)).sort(), ['libmp3lame', 'libvpx', 'libwebp']);
  assert.ok(!args.some(value => /nonfree|version3/u.test(value)), 'the build stays redistributable under GPL-2.0-or-later');
  assert.ok(args.some(value => value.includes(`-mmacosx-version-min=${MACOS_DEPLOYMENT_TARGET}`)));
  assert.ok(ffmpegConfigureArguments('/p', 'x64', '/sdk').some(value => value.includes('-arch x86_64')));
});

test('fontconfig looks only at fixed system locations, never at the build machine', () => {
  for (const option of FONTCONFIG_RUNTIME_OPTIONS) {
    const value = option.split('=')[1]!;
    assert.match(value, /^\/(?:etc|var|usr\/share)\//u, option);
    assert.doesNotMatch(value, /runner|tmp|prefix|homebrew|local/u, option);
  }
});

test('child builds cannot see Homebrew or /usr/local and pkg-config only searches the private prefix', () => {
  const env = buildEnvironment({arch: 'x64', sdk: '/sdk', prefix: '/work/prefix', toolBin: ['/work/tools/bin'], home: '/home/runner', temp: '/work/tmp'});
  assert.equal(env.PATH, '/work/tools/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(env.PKG_CONFIG_LIBDIR, '/work/prefix/lib/pkgconfig');
  assert.equal(env.PKG_CONFIG_PATH, '');
  assert.equal(env.MACOSX_DEPLOYMENT_TARGET, MACOS_DEPLOYMENT_TARGET);
  assert.ok(!Object.values(env).some(value => /homebrew|\/usr\/local/u.test(value)));
});

test('verification parsers reject non-system libraries and read listings and deployment targets', () => {
  const otool = '/out/ffmpeg:\n\t/System/Library/Frameworks/CoreText.framework/Versions/A/CoreText (compatibility version 1.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n\t/opt/homebrew/opt/x264/lib/libx264.164.dylib (compatibility version 164.0.0)\n\t@rpath/libass.9.dylib (compatibility version 1.0.0)\n';
  assert.deepEqual(unexpectedLinks(otool), ['/opt/homebrew/opt/x264/lib/libx264.164.dylib', '@rpath/libass.9.dylib']);
  assert.deepEqual(unexpectedLinks('/out/ffmpeg:\n\t/usr/lib/libz.1.dylib (compatibility version 1.0.0)\n'), []);
  assert.equal(minimumMacOS('Load command 9\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform 1\n    minos 12.0\n      sdk 27.0\n'), '12.0');
  assert.equal(minimumMacOS('cmd LC_UUID'), null);
  const encoders = listedNames('Encoders:\n V..... = Video\n ------\n V....D libx264              libx264 H.264\n A....D aac                  AAC (Advanced Audio Coding)\n');
  assert.ok(encoders.has('libx264') && encoders.has('aac') && !encoders.has('Video'));
  const filters = listedNames('Filters:\n  T.. = Timeline support\n TSC drawtext          V->V       Draw text\n ... zscale            V->V       Apply resizing\n');
  assert.ok(filters.has('drawtext') && filters.has('zscale'));
  const protocols = listedNames('Supported file protocols:\nInput:\n  file\n  pipe\nOutput:\n  file\n');
  assert.deepEqual([...protocols].sort(), ['file', 'pipe']);
});

test('release asset names match the application catalog convention', () => {
  assert.equal(assetName('ffmpeg', 'arm64'), `mioon-ffmpeg-${MEDIA_TOOLS_VERSION}-darwin-arm64.gz`);
  assert.equal(assetName('ffprobe', 'x64'), `mioon-ffprobe-${MEDIA_TOOLS_VERSION}-darwin-x64.gz`);
  assert.equal(manifestName('x64'), `mioon-media-tools-${MEDIA_TOOLS_VERSION}-darwin-x64.json`);
  assert.equal(sourcesBundleName(), `mioon-media-tools-${MEDIA_TOOLS_VERSION}-sources.tar`);
});

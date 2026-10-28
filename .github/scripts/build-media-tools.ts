import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {availableParallelism} from 'node:os';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {pathToFileURL} from 'node:url';
import {createGzip} from 'node:zlib';

/**
 * Builds the FFmpeg / ffprobe pair that Mioon offers as an in-app download on macOS.
 *
 * Every shipped component is compiled from a pinned, checksummed source archive into
 * static libraries, so the two executables only link libraries that ship with macOS.
 * The configuration mirrors the Linux CI toolchain where the application needs it
 * (libx264, libass, fontconfig, freetype, harfbuzz, zimg, fribidi) and leaves out
 * network protocols, which Mioon never uses. Builds are native only: run arm64 on an
 * Apple Silicon runner and x64 on an Intel runner.
 */
export const MEDIA_TOOLS_VERSION = '7.1.5-1';
export const FFMPEG_VERSION = '7.1.5';
export const MACOS_DEPLOYMENT_TARGET = '12.0';
export type MediaToolsArch = 'arm64' | 'x64';
export type SourceRole = 'shipped' | 'build-tool';
export interface PinnedSource {
  readonly name: string;
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly file: string;
  readonly license: string;
  readonly role: SourceRole;
}
const source = (value: PinnedSource): PinnedSource => Object.freeze(value);
// Checksums were recorded from the official release archives (FFmpeg from the
// repository's verified mirror). A changed upstream archive fails the build.
export const SOURCES: readonly PinnedSource[] = Object.freeze([
  source({name: 'ffmpeg', version: FFMPEG_VERSION, file: 'ffmpeg-7.1.5.tar.xz', license: 'GPL-2.0-or-later (as configured)', role: 'shipped',
    url: 'https://github.com/starroyhq/mioon/releases/download/ci-ffmpeg-7.1.5/ffmpeg-7.1.5.tar.xz',
    sha256: 'de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f'}),
  source({name: 'x264', version: 'b35605ace3ddf7c1a5d67a2eb553f034aef41d55', file: 'x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.bz2', license: 'GPL-2.0-or-later', role: 'shipped',
    url: 'https://code.videolan.org/videolan/x264/-/archive/b35605ace3ddf7c1a5d67a2eb553f034aef41d55/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.bz2',
    sha256: '6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224'}),
  source({name: 'freetype', version: '2.14.3', file: 'freetype-2.14.3.tar.xz', license: 'FTL OR GPL-2.0-or-later', role: 'shipped',
    url: 'https://download.savannah.gnu.org/releases/freetype/freetype-2.14.3.tar.xz',
    sha256: '36bc4f1cc413335368ee656c42afca65c5a3987e8768cc28cf11ba775e785a5f'}),
  source({name: 'harfbuzz', version: '14.6.0', file: 'harfbuzz-14.6.0.tar.xz', license: 'MIT', role: 'shipped',
    url: 'https://github.com/harfbuzz/harfbuzz/releases/download/14.6.0/harfbuzz-14.6.0.tar.xz',
    sha256: 'd07a007327277708a2a73ae437887cdbaf282937f6d03ca5467723e9099af586'}),
  source({name: 'fribidi', version: '1.0.17', file: 'fribidi-1.0.17.tar.xz', license: 'LGPL-2.1-or-later', role: 'shipped',
    url: 'https://github.com/fribidi/fribidi/releases/download/v1.0.17/fribidi-1.0.17.tar.xz',
    sha256: '6949dcde27d41cebad1fd741fcafc36d55a1020d2d872d4a6eb3914caabbada2'}),
  source({name: 'expat', version: '2.9.0', file: 'expat-2.9.0.tar.xz', license: 'MIT', role: 'shipped',
    url: 'https://github.com/libexpat/libexpat/releases/download/R_2_9_0/expat-2.9.0.tar.xz',
    sha256: '1e6371862cc31999b368c3b89b49994f0677e1bab5f1b2b85ae3741f5d803051'}),
  source({name: 'fontconfig', version: '2.16.0', file: 'fontconfig-2.16.0.tar.xz', license: 'HPND-sell-variant', role: 'shipped',
    url: 'https://www.freedesktop.org/software/fontconfig/release/fontconfig-2.16.0.tar.xz',
    sha256: '6a33dc555cc9ba8b10caf7695878ef134eeb36d0af366041f639b1da9b6ed220'}),
  source({name: 'libass', version: '0.17.5', file: 'libass-0.17.5.tar.xz', license: 'ISC', role: 'shipped',
    url: 'https://github.com/libass/libass/releases/download/0.17.5/libass-0.17.5.tar.xz',
    sha256: '2dca25c0e0c837ddf00b52011b3f82cac1e4ddd3ad018227806b0c2288864acc'}),
  source({name: 'zimg', version: '3.0.6', file: 'zimg-release-3.0.6.tar.gz', license: 'WTFPL', role: 'shipped',
    url: 'https://github.com/sekrit-twc/zimg/archive/refs/tags/release-3.0.6.tar.gz',
    sha256: 'be89390f13a5c9b2388ce0f44a5e89364a20c1c57ce46d382b1fcc3967057577'}),
  // Build-only tools: zimg ships no generated configure script, and x86 assembly needs NASM.
  // macOS ships an M4 older than Autoconf accepts.
  source({name: 'm4', version: '1.4.19', file: 'm4-1.4.19.tar.xz', license: 'GPL-3.0-or-later', role: 'build-tool',
    url: 'https://ftp.gnu.org/gnu/m4/m4-1.4.19.tar.xz',
    sha256: '63aede5c6d33b6d9b13511cd0be2cac046f2e70fd0a07aa9573a04a82783af96'}),
  source({name: 'autoconf', version: '2.72', file: 'autoconf-2.72.tar.xz', license: 'GPL-3.0-or-later', role: 'build-tool',
    url: 'https://ftp.gnu.org/gnu/autoconf/autoconf-2.72.tar.xz',
    sha256: 'ba885c1319578d6c94d46e9b0dceb4014caafe2490e437a0dbca3f270a223f5a'}),
  source({name: 'automake', version: '1.18.1', file: 'automake-1.18.1.tar.xz', license: 'GPL-2.0-or-later', role: 'build-tool',
    url: 'https://ftp.gnu.org/gnu/automake/automake-1.18.1.tar.xz',
    sha256: '168aa363278351b89af56684448f525a5bce5079d0b6842bd910fdd3f1646887'}),
  source({name: 'libtool', version: '2.5.4', file: 'libtool-2.5.4.tar.xz', license: 'GPL-2.0-or-later', role: 'build-tool',
    url: 'https://ftp.gnu.org/gnu/libtool/libtool-2.5.4.tar.xz',
    sha256: 'f81f5860666b0bc7d84baddefa60d1cb9fa6fceb2398cc3baca6afaa60266675'}),
  source({name: 'nasm', version: '2.16.03', file: 'nasm-2.16.03.tar.xz', license: 'BSD-2-Clause', role: 'build-tool',
    url: 'https://www.nasm.us/pub/nasm/releasebuilds/2.16.03/nasm-2.16.03.tar.xz',
    sha256: '1412a1c760bbd05db026b6c0d1657affd6631cd0a63cddb6f73cc6d4aa616148'}),
]);
export const PYTHON_BUILD_TOOLS = Object.freeze(['meson==1.12.1', 'ninja==1.13.0']);
export const FFMPEG_LIBRARIES = Object.freeze(['gpl', 'pthreads', 'zlib', 'libx264', 'libass', 'libfontconfig', 'libfreetype', 'libharfbuzz', 'libzimg', 'libfribidi']);
export const REQUIRED_ENCODERS = Object.freeze(['libx264', 'aac']);
export const REQUIRED_FILTERS = Object.freeze(['drawtext', 'subtitles', 'zscale', 'loudnorm', 'ebur128', 'scale', 'overlay', 'amix']);
const FORBIDDEN_PROTOCOLS = Object.freeze(['http', 'https', 'tcp', 'tls', 'udp', 'rtmp', 'rtp', 'ftp']);
const MAXIMUM_SOURCE_BYTES = 64 * 1024 * 1024;

export class MediaToolsBuildFailure extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {super(detail ? `${code}: ${detail}` : code); this.name = 'MediaToolsBuildFailure'; this.code = code;}
}
function fail(code: string, detail?: string): never {throw new MediaToolsBuildFailure(code, detail);}

export function clangArch(arch: MediaToolsArch): 'arm64' | 'x86_64' {return arch === 'arm64' ? 'arm64' : 'x86_64';}
export function assetName(tool: 'ffmpeg' | 'ffprobe', arch: MediaToolsArch, version = MEDIA_TOOLS_VERSION): string {return `mioon-${tool}-${version}-darwin-${arch}.gz`;}
export function manifestName(arch: MediaToolsArch, version = MEDIA_TOOLS_VERSION): string {return `mioon-media-tools-${version}-darwin-${arch}.json`;}
export function sourcesBundleName(version = MEDIA_TOOLS_VERSION): string {return `mioon-media-tools-${version}-sources.tar`;}

/** Flags shared by every C/C++ compilation and link of one architecture. */
export function compilerFlags(arch: MediaToolsArch, sdk: string): string {
  return `-arch ${clangArch(arch)} -isysroot ${sdk} -mmacosx-version-min=${MACOS_DEPLOYMENT_TARGET}`;
}
export function ffmpegConfigureArguments(prefix: string, arch: MediaToolsArch, sdk: string): string[] {
  const flags = compilerFlags(arch, sdk);
  return [
    `--prefix=${prefix}`, '--cc=clang', '--cxx=clang++', '--pkg-config=pkg-config', '--pkg-config-flags=--static',
    `--extra-cflags=${flags} -O2 -I${prefix}/include`, `--extra-ldflags=${flags} -L${prefix}/lib`, '--extra-libs=-lc++',
    '--disable-autodetect', '--disable-doc', '--disable-debug', '--disable-ffplay', '--disable-network', '--disable-shared', '--enable-static',
    ...FFMPEG_LIBRARIES.map(name => `--enable-${name}`),
  ];
}

// Children receive a fixed PATH without Homebrew or /usr/local, so configure
// scripts cannot pick up host libraries. pkg-config only searches the prefix.
export function buildEnvironment(options: {arch: MediaToolsArch; sdk: string; prefix: string; toolBin: readonly string[]; home: string; temp: string}): Record<string, string> {
  const flags = compilerFlags(options.arch, options.sdk);
  return {
    PATH: [...options.toolBin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: options.home, TMPDIR: options.temp, LANG: 'C', LC_ALL: 'C',
    CC: 'clang', CXX: 'clang++', CFLAGS: `${flags} -O2`, CXXFLAGS: `${flags} -O2`, OBJCFLAGS: `${flags} -O2`,
    CPPFLAGS: `-I${options.prefix}/include`, LDFLAGS: `${flags} -L${options.prefix}/lib`,
    MACOSX_DEPLOYMENT_TARGET: MACOS_DEPLOYMENT_TARGET, PKG_CONFIG_LIBDIR: `${options.prefix}/lib/pkgconfig`, PKG_CONFIG_PATH: '',
  };
}

interface RunOptions {cwd: string; env: Record<string, string>; log: string; capture?: boolean}
async function run(file: string, args: readonly string[], options: RunOptions): Promise<string> {
  const log = createWriteStream(options.log, {flags: 'a'});
  log.write(`\n$ ${file} ${args.join(' ')}\n`);
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(file, [...args], {cwd: options.cwd, env: options.env, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
      const output: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => {log.write(chunk); if (options.capture) output.push(chunk);});
      child.stderr.on('data', (chunk: Buffer) => {log.write(chunk);});
      child.once('error', error => reject(new MediaToolsBuildFailure('MEDIA_TOOLS_COMMAND_FAILED', `${path.basename(file)}: ${error.message}`)));
      child.once('close', code => code === 0 ? resolve(Buffer.concat(output).toString('utf8'))
        : reject(new MediaToolsBuildFailure('MEDIA_TOOLS_COMMAND_FAILED', `${path.basename(file)} ${args[0] ?? ''} exited ${code}; see ${options.log}`)));
    });
  } finally {await new Promise(resolve => log.end(resolve));}
}

export async function fileSha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function fetchSource(entry: PinnedSource, directory: string): Promise<string> {
  const file = path.join(directory, entry.file);
  const existing = await lstat(file).catch(() => null);
  if (existing?.isFile() && await fileSha256(file) === entry.sha256) return file;
  await rm(file, {force: true});
  const response = await fetch(entry.url, {redirect: 'follow', signal: AbortSignal.timeout(300000)});
  if (!response.ok || !response.body) fail('MEDIA_TOOLS_SOURCE_DOWNLOAD_FAILED', `${entry.name} HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAXIMUM_SOURCE_BYTES) fail('MEDIA_TOOLS_SOURCE_SIZE_INVALID', entry.name);
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) fail('MEDIA_TOOLS_SOURCE_SHA256_MISMATCH', entry.name);
  await writeFile(file, bytes, {flag: 'wx', mode: 0o644});
  return file;
}

async function extract(archive: string, destination: string, env: Record<string, string>, log: string): Promise<string> {
  await rm(destination, {recursive: true, force: true});
  await mkdir(destination, {recursive: true});
  await run('/usr/bin/tar', ['-xf', archive, '--strip-components=1', '-C', destination], {cwd: path.dirname(destination), env, log});
  return destination;
}

async function capture(file: string, args: readonly string[], env: Record<string, string>, log: string, cwd = '/'): Promise<string> {
  return (await run(file, args, {cwd, env, log, capture: true})).trim();
}

interface BuildContext {
  arch: MediaToolsArch; work: string; prefix: string; tools: string; sources: string; buildRoot: string;
  sdk: string; jobs: number; log: string; env: Record<string, string>; hostEnv: Record<string, string>;
}
const sourceOf = (name: string): PinnedSource => SOURCES.find(entry => entry.name === name) ?? fail('MEDIA_TOOLS_SOURCE_UNKNOWN', name);
async function unpack(context: BuildContext, name: string, env = context.env): Promise<string> {
  const entry = sourceOf(name);
  return extract(path.join(context.sources, entry.file), path.join(context.buildRoot, name), env, context.log);
}
async function autotools(context: BuildContext, name: string, args: readonly string[], env = context.env, prefix = context.prefix): Promise<void> {
  const directory = await unpack(context, name, env);
  await run('./configure', [`--prefix=${prefix}`, ...args], {cwd: directory, env, log: context.log});
  await run('/usr/bin/make', [`-j${context.jobs}`], {cwd: directory, env, log: context.log});
  await run('/usr/bin/make', ['install'], {cwd: directory, env, log: context.log});
}
async function meson(context: BuildContext, name: string, args: readonly string[], tags?: string): Promise<void> {
  const directory = await unpack(context, name);
  const tool = path.join(context.tools, 'venv/bin/meson');
  await run(tool, ['setup', 'build', `--prefix=${context.prefix}`, '--libdir=lib', '--buildtype=release', '--default-library=static', '-Db_ndebug=true', ...args],
    {cwd: directory, env: context.env, log: context.log});
  await run(tool, ['compile', '-C', 'build', '-j', String(context.jobs)], {cwd: directory, env: context.env, log: context.log});
  await run(tool, ['install', '-C', 'build', ...(tags ? ['--tags', tags] : [])], {cwd: directory, env: context.env, log: context.log});
}
/**
 * Fontconfig compiles its configuration and cache locations into the library. Use
 * fixed, root-owned system paths instead of the build directory: /etc/fonts/fonts.conf
 * is normally absent on macOS, so the built-in fallback configuration applies, with
 * the macOS font folders and a per-user cache in ~/.cache/fontconfig.
 */
export const FONTCONFIG_RUNTIME_OPTIONS = Object.freeze(['-Dbaseconfig-dir=/etc/fonts', '-Dconfig-dir=/etc/fonts/conf.d', '-Dcache-dir=/var/cache/fontconfig',
  '-Dtemplate-dir=/usr/share/fontconfig/conf.avail', '-Dxml-dir=/usr/share/xml/fontconfig']);

async function bootstrapTools(context: BuildContext, python: string): Promise<void> {
  const venv = path.join(context.tools, 'venv');
  await run(python, ['-m', 'venv', venv], {cwd: context.work, env: context.hostEnv, log: context.log});
  await run(path.join(venv, 'bin/pip'), ['install', '--disable-pip-version-check', '--no-input', ...PYTHON_BUILD_TOOLS], {cwd: context.work, env: context.hostEnv, log: context.log});
  for (const name of ['m4', 'autoconf', 'automake', 'libtool']) await autotools(context, name, [], context.hostEnv, context.tools);
  // x86 assembly in x264 and libass is assembled with NASM; arm64 uses clang.
  if (context.arch === 'x64') await autotools(context, 'nasm', [], context.hostEnv, context.tools);
}

async function buildLibraries(context: BuildContext): Promise<void> {
  await autotools(context, 'expat', ['--disable-shared', '--enable-static', '--without-xmlwf', '--without-examples', '--without-tests', '--without-docbook']);
  await meson(context, 'freetype', ['-Dbrotli=disabled', '-Dbzip2=disabled', '-Dharfbuzz=disabled', '-Dpng=disabled', '-Dzlib=internal', '-Dtests=disabled']);
  await meson(context, 'harfbuzz', ['-Dfreetype=enabled', '-Dglib=disabled', '-Dgobject=disabled', '-Dcairo=disabled', '-Dchafa=disabled', '-Dpng=disabled',
    '-Dzlib=disabled', '-Dicu=disabled', '-Draster=disabled', '-Dvector=disabled', '-Dgpu=disabled', '-Dgpu_demo=disabled', '-Dsubset=disabled', '-Dtests=disabled',
    '-Dintrospection=disabled', '-Ddocs=disabled', '-Dutilities=disabled', '-Dbenchmark=disabled']);
  await meson(context, 'fribidi', ['-Ddocs=false', '-Dbin=false', '-Dtests=false']);
  // Only the static library, headers and pkg-config file are installed; the
  // configuration templates would otherwise be written to the system paths.
  await meson(context, 'fontconfig', ['-Ddoc=disabled', '-Dnls=disabled', '-Dtests=disabled', '-Dtools=disabled', '-Dcache-build=disabled', '-Dxml-backend=expat',
    ...FONTCONFIG_RUNTIME_OPTIONS], 'devel');
  await autotools(context, 'libass', ['--disable-shared', '--enable-static', '--disable-libunibreak', '--disable-test', '--disable-compare', '--disable-profile', '--disable-fuzz']);
  const zimg = await unpack(context, 'zimg');
  await run('./autogen.sh', [], {cwd: zimg, env: context.env, log: context.log});
  // zimg is C++; its static pkg-config entry must name the macOS C++ runtime.
  await run('./configure', [`--prefix=${context.prefix}`, '--disable-shared', '--enable-static', 'STL_LIBS=-lc++'], {cwd: zimg, env: context.env, log: context.log});
  await run('/usr/bin/make', [`-j${context.jobs}`], {cwd: zimg, env: context.env, log: context.log});
  await run('/usr/bin/make', ['install'], {cwd: zimg, env: context.env, log: context.log});
  const x264 = await unpack(context, 'x264');
  const flags = compilerFlags(context.arch, context.sdk);
  await run('./configure', [`--prefix=${context.prefix}`, '--enable-static', '--enable-pic', '--disable-cli', '--disable-opencl', '--disable-avs', '--disable-swscale',
    '--disable-lavf', '--disable-ffms', '--disable-gpac', '--disable-lsmash', `--extra-cflags=${flags}`, `--extra-ldflags=${flags}`, `--extra-asflags=${context.arch === 'arm64' ? flags : ''}`],
    {cwd: x264, env: context.env, log: context.log});
  await run('/usr/bin/make', [`-j${context.jobs}`], {cwd: x264, env: context.env, log: context.log});
  await run('/usr/bin/make', ['install-lib-static'], {cwd: x264, env: context.env, log: context.log});
}

async function buildFFmpeg(context: BuildContext): Promise<{ffmpeg: string; ffprobe: string; configure: string[]}> {
  const directory = await unpack(context, 'ffmpeg');
  const configure = ffmpegConfigureArguments(context.prefix, context.arch, context.sdk);
  await run('./configure', configure, {cwd: directory, env: context.env, log: context.log});
  await run('/usr/bin/make', [`-j${context.jobs}`, 'ffmpeg', 'ffprobe'], {cwd: directory, env: context.env, log: context.log});
  return {ffmpeg: path.join(directory, 'ffmpeg'), ffprobe: path.join(directory, 'ffprobe'), configure};
}

/** Only macOS system libraries and frameworks may be linked dynamically. */
export function unexpectedLinks(otoolOutput: string): string[] {
  return otoolOutput.split('\n').slice(1).map(line => line.trim().split(' (')[0]!).filter(Boolean)
    .filter(link => !link.startsWith('/usr/lib/') && !link.startsWith('/System/Library/Frameworks/'));
}
export function minimumMacOS(otoolLoadCommands: string): string | null {
  const match = /cmd LC_BUILD_VERSION[\s\S]*?minos ([0-9.]+)/u.exec(otoolLoadCommands);
  return match?.[1] ?? null;
}
export function listedNames(output: string): Set<string> {
  // Encoder, filter and protocol listings print one entry per line after a legend.
  const names = new Set<string>();
  for (const line of output.split('\n')) {
    const match = /^\s*(?:[A-Z.|]{2,}\s+)?([a-z0-9_]+)\b/u.exec(line);
    if (match) names.add(match[1]!);
  }
  return names;
}

interface VerifyResult {ffmpeg: string; ffprobe: string; links: Record<string, string[]>; minimumMacOS: string; architectures: string; buildconf: string}
export async function verifyTools(directory: string, arch: MediaToolsArch, options: {log: string; env: Record<string, string>; work: string}): Promise<VerifyResult> {
  const {log, env} = options;
  const ffmpeg = path.join(directory, 'ffmpeg'), ffprobe = path.join(directory, 'ffprobe');
  const versions: Record<string, string> = {};
  const links: Record<string, string[]> = {};
  let minimum = '', architectures = '';
  for (const [name, file] of [['ffmpeg', ffmpeg], ['ffprobe', ffprobe]] as const) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) fail('MEDIA_TOOLS_BINARY_INVALID', name);
    const first = (await capture(file, ['-version'], env, log)).split('\n')[0] ?? '';
    if (!first.startsWith(`${name} version ${FFMPEG_VERSION} `)) fail('MEDIA_TOOLS_VERSION_MISMATCH', first);
    versions[name] = first;
    const linked = await capture('/usr/bin/otool', ['-L', file], env, log);
    const unexpected = unexpectedLinks(linked);
    if (unexpected.length) fail('MEDIA_TOOLS_UNEXPECTED_DYLIB', unexpected.join(', '));
    links[name] = linked.split('\n').slice(1).map(line => line.trim()).filter(Boolean);
    const loadCommands = await capture('/usr/bin/otool', ['-l', file], env, log);
    const minos = minimumMacOS(loadCommands);
    if (minos !== MACOS_DEPLOYMENT_TARGET) fail('MEDIA_TOOLS_DEPLOYMENT_TARGET_MISMATCH', `${name} minos ${minos}`);
    minimum = minos;
    const archs = await capture('/usr/bin/lipo', ['-archs', file], env, log);
    if (archs !== clangArch(arch)) fail('MEDIA_TOOLS_ARCHITECTURE_MISMATCH', `${name} ${archs}`);
    architectures = archs;
  }
  const encoders = listedNames(await capture(ffmpeg, ['-hide_banner', '-encoders'], env, log));
  for (const name of REQUIRED_ENCODERS) if (!encoders.has(name)) fail('MEDIA_TOOLS_ENCODER_MISSING', name);
  const filters = listedNames(await capture(ffmpeg, ['-hide_banner', '-filters'], env, log));
  for (const name of REQUIRED_FILTERS) if (!filters.has(name)) fail('MEDIA_TOOLS_FILTER_MISSING', name);
  const protocols = listedNames(await capture(ffmpeg, ['-hide_banner', '-protocols'], env, log));
  for (const name of FORBIDDEN_PROTOCOLS) if (protocols.has(name)) fail('MEDIA_TOOLS_NETWORK_PROTOCOL_PRESENT', name);
  const drawtext = await capture(ffmpeg, ['-hide_banner', '-h', 'filter=drawtext'], env, log);
  for (const option of ['fontfile', 'textfile', 'text_shaping', 'expansion', 'borderw', 'line_spacing']) {
    if (!new RegExp(`^\\s+${option}\\s+<`, 'mu').test(drawtext)) fail('MEDIA_TOOLS_DRAWTEXT_OPTION_MISSING', option);
  }
  const buildconf = await capture(ffmpeg, ['-hide_banner', '-buildconf'], env, log);
  // Functional checks match what the application runs: the simulated provider's
  // default-font caption, an explicit-font caption with shaping disabled, colour
  // conversion through zscale, AAC audio and an ffprobe read of the result.
  const scratch = path.join(options.work, `verify-${arch}`);
  await rm(scratch, {recursive: true, force: true});
  await mkdir(scratch, {recursive: true});
  let fontPath = '';
  for (const candidate of ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/SFNS.ttf']) {
    if (await stat(candidate).catch(() => null)) {fontPath = candidate; break;}
  }
  if (!fontPath) fail('MEDIA_TOOLS_TEST_FONT_MISSING');
  await writeFile(path.join(scratch, 'caption.txt'), 'Mioon 1080 Caption\n');
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=24', '-t', '1',
    '-vf', "hue=h=120,drawbox=x=0:y=0:w=iw:h=74:color=black@0.85:t=fill,drawtext=text='SIMULATED MOCK':fontcolor=white:fontsize=26:x=(w-tw)/2:y=20",
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p', '-threads', '1', path.join(scratch, 'mock.mp4')], {cwd: scratch, env, log});
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '1', '-filter_complex', `[0:v]zscale=matrixin=709:transferin=709:primariesin=709:matrix=709:transfer=709:primaries=709,format=yuv420p,drawtext=fontfile=${fontPath.replaceAll(':', '\\:')}:textfile=caption.txt:expansion=none:text_shaping=0:fontsize=48:borderw=3:line_spacing=8:fontcolor=white:bordercolor=black:x=(w-tw)/2:y=h-200[v];[1:a]loudnorm=I=-16:TP=-1.5:LRA=11[a]`,
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', path.join(scratch, 'export.mp4')], {cwd: scratch, env, log});
  await writeFile(path.join(scratch, 'cue.ass'), '[Script Info]\nScriptType: v4.00+\nPlayResX: 360\nPlayResY: 640\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, Alignment\nStyle: Default,Arial,24,&H00FFFFFF,2\n\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,Mioon\n');
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=360x640:r=24', '-t', '1', '-vf', 'subtitles=cue.ass',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(scratch, 'subtitles.mp4')], {cwd: scratch, env, log});
  const probe = JSON.parse(await capture(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path.join(scratch, 'export.mp4')], env, log, scratch)) as
    {streams?: {codec_name?: string; width?: number; height?: number}[]};
  const codecs = (probe.streams ?? []).map(stream => stream.codec_name).sort().join(',');
  if (codecs !== 'aac,h264' || !probe.streams?.some(stream => stream.width === 1080 && stream.height === 1920)) fail('MEDIA_TOOLS_SMOKE_OUTPUT_INVALID', codecs);
  await rm(scratch, {recursive: true, force: true});
  return {ffmpeg: versions.ffmpeg!, ffprobe: versions.ffprobe!, links, minimumMacOS: minimum, architectures, buildconf};
}

function nativeArch(arch: MediaToolsArch): void {
  if (process.platform !== 'darwin') fail('MEDIA_TOOLS_REQUIRES_MACOS');
  if (process.arch !== arch) fail('MEDIA_TOOLS_REQUIRES_NATIVE_ARCH', `${process.arch} cannot build ${arch}`);
}
async function hostTool(name: string): Promise<string> {
  for (const directory of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) {
    const candidate = path.join(directory, name);
    if (await stat(candidate).catch(() => null)) return realpath(candidate);
  }
  fail('MEDIA_TOOLS_HOST_TOOL_MISSING', name);
}

export async function build(options: {arch: MediaToolsArch; work: string; output: string}): Promise<void> {
  nativeArch(options.arch);
  const work = path.resolve(options.work), output = path.resolve(options.output);
  await mkdir(work, {recursive: true}); await mkdir(output, {recursive: true});
  const log = path.join(work, `build-${options.arch}.log`);
  const temp = path.join(work, 'tmp');
  await mkdir(temp, {recursive: true});
  const tools = path.join(work, 'tools'), prefix = path.join(work, `prefix-${options.arch}`), sources = path.join(work, 'sources'), buildRoot = path.join(work, `build-${options.arch}`);
  for (const directory of [tools, sources]) await mkdir(directory, {recursive: true});
  await rm(prefix, {recursive: true, force: true}); await rm(buildRoot, {recursive: true, force: true});
  await mkdir(path.join(prefix, 'lib/pkgconfig'), {recursive: true}); await mkdir(buildRoot, {recursive: true});
  // Only pkg-config and python come from the host; both run outside the shipped code.
  const pkgConfig = await hostTool('pkg-config'), python = await hostTool('python3');
  const shims = path.join(tools, 'host-bin');
  await rm(shims, {recursive: true, force: true}); await mkdir(shims, {recursive: true});
  await writeFile(path.join(shims, 'pkg-config'), `#!/bin/sh\nexec '${pkgConfig}' "$@"\n`, {mode: 0o755});
  const toolBin = [path.join(tools, 'venv/bin'), path.join(tools, 'bin'), shims];
  const hostEnv = {PATH: [...toolBin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'), HOME: process.env.HOME ?? work, TMPDIR: temp, LANG: 'C', LC_ALL: 'C'};
  const sdk = (await capture('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], hostEnv, log)).trim();
  const env = buildEnvironment({arch: options.arch, sdk, prefix, toolBin, home: hostEnv.HOME, temp});
  const context: BuildContext = {arch: options.arch, work, prefix, tools, sources, buildRoot, sdk, jobs: Math.max(1, availableParallelism()), log, env, hostEnv};
  for (const entry of SOURCES) await fetchSource(entry, sources);
  if (!(await stat(path.join(tools, 'venv/bin/meson')).catch(() => null)) || !(await stat(path.join(tools, 'bin/autoreconf')).catch(() => null)) ||
    (options.arch === 'x64' && !(await stat(path.join(tools, 'bin/nasm')).catch(() => null)))) await bootstrapTools(context, python);
  await buildLibraries(context);
  const built = await buildFFmpeg(context);
  for (const name of ['ffmpeg', 'ffprobe'] as const) {
    await copyFile(built[name], path.join(output, name));
    await chmod(path.join(output, name), 0o755);
  }
  const verified = await verifyTools(output, options.arch, {log, env, work});
  const sdkVersion = await capture('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-version'], hostEnv, log);
  const clang = (await capture('/usr/bin/clang', ['--version'], hostEnv, log)).split('\n')[0] ?? '';
  await writeFile(path.join(output, 'build-info.json'), JSON.stringify({
    schema: 1, version: MEDIA_TOOLS_VERSION, ffmpegVersion: FFMPEG_VERSION, arch: options.arch, minimumMacOS: MACOS_DEPLOYMENT_TARGET,
    sdkVersion, clang, configure: built.configure.map(argument => argument.replaceAll(prefix, '<prefix>').replaceAll(sdk, '<sdk>')),
    sources: SOURCES.map(({name, version, file, sha256, license, role}) => ({name, version, file, sha256, license, role})),
    pythonBuildTools: PYTHON_BUILD_TOOLS, versions: {ffmpeg: verified.ffmpeg, ffprobe: verified.ffprobe}, links: verified.links,
  }, null, 2) + '\n');
}

export async function verify(options: {arch: MediaToolsArch; directory: string; work: string}): Promise<void> {
  nativeArch(options.arch);
  const work = path.resolve(options.work);
  await mkdir(work, {recursive: true});
  const env = {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME ?? work, TMPDIR: work, LANG: 'C', LC_ALL: 'C'};
  await verifyTools(path.resolve(options.directory), options.arch, {log: path.join(work, `verify-${options.arch}.log`), env, work});
}

export interface PackagedAsset {file: string; sha256: string; bytes: number; unpackedSha256: string; unpackedBytes: number}
/** Gzip the signed executables and describe them for the application's pinned catalog. */
export async function packageTools(options: {arch: MediaToolsArch; directory: string; output: string}): Promise<Record<'ffmpeg' | 'ffprobe', PackagedAsset>> {
  const directory = path.resolve(options.directory), output = path.resolve(options.output);
  await mkdir(output, {recursive: true});
  const assets = {} as Record<'ffmpeg' | 'ffprobe', PackagedAsset>;
  for (const tool of ['ffmpeg', 'ffprobe'] as const) {
    const input = path.join(directory, tool), file = assetName(tool, options.arch), target = path.join(output, file);
    await pipeline(createReadStream(input), createGzip({level: 9}), createWriteStream(target, {flags: 'wx', mode: 0o644}));
    assets[tool] = {file, sha256: await fileSha256(target), bytes: (await stat(target)).size, unpackedSha256: await fileSha256(input), unpackedBytes: (await stat(input)).size};
  }
  const info = JSON.parse(await readFile(path.join(directory, 'build-info.json'), 'utf8')) as Record<string, unknown>;
  await writeFile(path.join(output, manifestName(options.arch)), JSON.stringify({...info, assets}, null, 2) + '\n', {flag: 'wx'});
  return assets;
}

/** Corresponding source for the release: every shipped component plus this script. */
export async function bundleSources(options: {work: string; output: string}): Promise<string> {
  const work = path.resolve(options.work), output = path.resolve(options.output);
  const staging = path.join(work, 'sources-bundle');
  await rm(staging, {recursive: true, force: true});
  await mkdir(staging, {recursive: true});
  for (const entry of SOURCES.filter(item => item.role === 'shipped')) {
    const file = path.join(work, 'sources', entry.file);
    if (await fileSha256(file) !== entry.sha256) fail('MEDIA_TOOLS_SOURCE_SHA256_MISMATCH', entry.name);
    await copyFile(file, path.join(staging, entry.file));
  }
  await copyFile(new URL(import.meta.url), path.join(staging, 'build-media-tools.ts'));
  await writeFile(path.join(staging, 'README.txt'), [
    `Mioon media tools ${MEDIA_TOOLS_VERSION}: FFmpeg ${FFMPEG_VERSION} and ffprobe for macOS ${MACOS_DEPLOYMENT_TARGET}+`,
    '', 'The executables are distributed under the GNU General Public License, version 2 or later, because they include libx264.',
    'This archive contains the complete corresponding source of every component linked into them and build-media-tools.ts,',
    'the script that downloads, verifies, configures and compiles them. Run it on a Mac of the target architecture:',
    '', '  node build-media-tools.ts build --arch=arm64 --work=<dir> --output=<dir>', '',
    ...SOURCES.filter(item => item.role === 'shipped').map(item => `${item.name} ${item.version} (${item.license}) sha256 ${item.sha256}`), '',
  ].join('\n'));
  const target = path.join(output, sourcesBundleName());
  await mkdir(output, {recursive: true});
  const names = (await readdir(staging)).sort();
  await run('/usr/bin/tar', ['-cf', target, '-C', staging, ...names], {cwd: staging, env: {PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C'}, log: path.join(work, 'sources.log')});
  return target;
}

function argument(args: readonly string[], name: string): string {
  const prefix = `--${name}=`;
  const values = args.filter(value => value.startsWith(prefix));
  if (values.length !== 1 || values[0]!.length === prefix.length) fail('MEDIA_TOOLS_ARGUMENTS_INVALID', name);
  return values[0]!.slice(prefix.length);
}
function archArgument(args: readonly string[]): MediaToolsArch {
  const value = argument(args, 'arch');
  if (value !== 'arm64' && value !== 'x64') fail('MEDIA_TOOLS_ARGUMENTS_INVALID', 'arch');
  return value;
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = args;
  if (command === 'build') await build({arch: archArgument(rest), work: argument(rest, 'work'), output: argument(rest, 'output')});
  else if (command === 'verify') await verify({arch: archArgument(rest), directory: argument(rest, 'dir'), work: argument(rest, 'work')});
  else if (command === 'package') process.stdout.write(`${JSON.stringify(await packageTools({arch: archArgument(rest), directory: argument(rest, 'dir'), output: argument(rest, 'output')}), null, 2)}\n`);
  else if (command === 'sources') process.stdout.write(`${await bundleSources({work: argument(rest, 'work'), output: argument(rest, 'output')})}\n`);
  else fail('MEDIA_TOOLS_ARGUMENTS_INVALID', 'command');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof MediaToolsBuildFailure ? error.message : `MEDIA_TOOLS_BUILD_FAILED: ${error instanceof Error ? error.message : String(error)}`}\n`);
    process.exitCode = 1;
  });
}

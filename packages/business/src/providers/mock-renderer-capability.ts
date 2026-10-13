import {statSync} from 'node:fs';
import path from 'node:path';

interface CapabilityRuntime {
  run(command: string, args: string[], options: {timeout: number; signal?: AbortSignal}): Promise<unknown>;
  throwIfMediaAborted(signal?: AbortSignal): void;
}
interface ToolConfiguration {readonly executable: string; readonly searchPath: string | undefined}
interface CachedCapability {readonly configuration: ToolConfiguration; readonly identity: string; readonly hasDrawtext: boolean}

export const DRAWTEXT_MESSAGE = '当前 FFmpeg 缺少 drawtext 滤镜（需要 libfreetype），无法生成模拟视频。请换用包含该滤镜的构建（例如 Homebrew 的 ffmpeg-full），再重新选择 ffmpeg 与 ffprobe。';

function configuration(): ToolConfiguration {
  return {executable: process.env.MIOON_FFMPEG_PATH ?? '', searchPath: process.env.PATH};
}
function sameConfiguration(left: ToolConfiguration, right: ToolConfiguration): boolean {
  return left.executable === right.executable && left.searchPath === right.searchPath;
}
function executableIdentity(tool: string): string | undefined {
  if (!tool || !path.isAbsolute(tool) || tool.includes('\0')) return undefined;
  try {
    // Follow executable symlinks: replacing either their target or the tool at
    // this same configured path invalidates both positive and negative results.
    const file = statSync(tool, {bigint: true});
    return file.isFile() ? [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':') : undefined;
  } catch { return undefined; }
}
const FILTER_LEGENDS = new Set(['T.. = Timeline support', '.S. = Slice threading', '..C = Command support',
  'A = Audio input/output', 'V = Video input/output', 'N = Dynamic number and/or type of input/output', '| = Source or sink filter']);
function hasDrawtext(listing: unknown): boolean | undefined {
  if (typeof listing !== 'string') return undefined;
  const lines = listing.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.shift() !== 'Filters:') return undefined;
  let scale = false, drawtext = false, rows = false;
  for (const line of lines) {
    // Keep the existing two/three-flag fixture formats and real FFmpeg legends.
    // Any unrecognized line makes absence unproven, even beside a scale row.
    if (!rows && FILTER_LEGENDS.has(line.replace(/\s+/g, ' '))) continue;
    const row = /^[TSC.]{2,3}\s+([a-zA-Z0-9_]+)\s+[AVN|]+->[AVN|]+\s+\S.*$/.exec(line);
    if (!row) return undefined;
    rows = true;
    if (row[1] === 'scale') scale = true;
    if (row[1] === 'drawtext') drawtext = true;
  }
  return scale ? drawtext : undefined;
}
function lifecycleFailure(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null &&
    (('code' in cause && cause.code === 'MEDIA_CANCELLED') || ('terminationUnconfirmed' in cause && cause.terminationUnconfirmed === true));
}

/** Mock-only evidence, not a renderer admission token. At most one configured
 * executable identity is cached; default PATH lookup and unknown results never
 * are. The shared runtime owns all execution, output bounds and child cleanup. */
export function createMockRendererCapability(runtime: CapabilityRuntime): (signal?: AbortSignal) => Promise<boolean> {
  let cached: CachedCapability | undefined;
  return async function lacksDrawtext(signal?: AbortSignal): Promise<boolean> {
    runtime.throwIfMediaAborted(signal);
    const before = configuration(), identity = executableIdentity(before.executable);
    if (identity !== undefined && cached && sameConfiguration(before, cached.configuration) && identity === cached.identity) return !cached.hasDrawtext;
    cached = undefined;
    let listing: unknown;
    try { listing = await runtime.run('ffmpeg', ['-hide_banner', '-filters'], {timeout: 15_000, signal}); }
    catch (cause) {
      if (lifecycleFailure(cause)) throw cause;
      runtime.throwIfMediaAborted(signal);
      return false;
    }
    runtime.throwIfMediaAborted(signal);
    if (!sameConfiguration(before, configuration())) return false;
    if (before.executable && (identity === undefined || executableIdentity(before.executable) !== identity)) return false;
    const supported = hasDrawtext(listing);
    if (supported === undefined) return false;
    if (identity !== undefined) cached = {configuration: before, identity, hasDrawtext: supported};
    return !supported;
  };
}

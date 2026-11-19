import {run} from './media-runtime.ts';
import type {MediaEffectFence} from './media-runtime.ts';
import {mediaExecutable} from './media-environment.ts';
import {PREMULTIPLIED_OVERLAY_ALPHA_MODE_TAG, probePremultipliedOverlay} from './premultiplied-overlay-probe.ts';
import type {PremultipliedOverlayVariant} from './premultiplied-overlay-probe.ts';

// One behavior probe per tool per backend process: previews and exports share
// the staged premultiplied RGBA8 layers, so the graph shape must not be chosen
// from a version string alone.
const variants = new Map<string, PremultipliedOverlayVariant>();

export class TimelinePremultipliedOverlayUnsupported extends Error {
  readonly code = 'TIMELINE_PREMULTIPLIED_OVERLAY_UNSUPPORTED' as const;
}

/** Returns the consumer-chain fragment that declares the staged layer as
 * premultiplied on tools with alpha-mode negotiation, or an empty string on
 * older tools whose `overlay=alpha=premultiplied` already assumes it. */
export async function timelinePremultipliedOverlayInputTag({signal, beforeEffect}: {signal?: AbortSignal; beforeEffect?: MediaEffectFence} = {}): Promise<string> {
  const ffmpeg = mediaExecutable('ffmpeg');
  const known = variants.get(ffmpeg);
  if (known !== undefined) return known === 'alpha-mode-tag' ? PREMULTIPLIED_OVERLAY_ALPHA_MODE_TAG : '';
  const result = await probePremultipliedOverlay(ffmpeg, {
    execute: (file, args, options) => run(file, args, {timeout: options.timeout, maxStdoutBytes: 65536, maxStderrBytes: 65536,
      ...(signal === undefined ? {} : {signal}), ...(beforeEffect === undefined ? {} : {beforeEffect})}),
  });
  if (!result.ok) throw new TimelinePremultipliedOverlayUnsupported(`当前视频工具的预乘透明度合成结果不正确（期望 ${result.expected.join(',')}，实际 ${result.observed?.join(',') ?? '无输出'}），请改用 Mioon 提供的 FFmpeg 7.1.5 或 8.1 以上的版本`);
  variants.set(ffmpeg, result.variant);
  return result.variant === 'alpha-mode-tag' ? PREMULTIPLIED_OVERLAY_ALPHA_MODE_TAG : '';
}

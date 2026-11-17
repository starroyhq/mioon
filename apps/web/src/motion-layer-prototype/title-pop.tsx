import {isTimelineSubtitleCodePoint} from '../../../../packages/contracts/src/timeline-subtitle-profile.ts';
import {cubicBezier, fadeOpacity, frameProgress, interpolate, springProgress, staggerFrame} from './runtime.ts';
import type {MotionFrameProps} from './runtime.ts';

export interface TitlePopParams {
  readonly text: string;
  readonly color: string;
  readonly fontSize: number;
  readonly enterFrames: number;
  readonly exitFrames: number;
  readonly durationFrames: number;
}

const enterOpacity = cubicBezier(0.2, 0.65, 0.3, 1);

export function TitlePop({frame, fps, width, height, params}: MotionFrameProps<TitlePopParams>) {
  const {text, color, fontSize, enterFrames, exitFrames, durationFrames} = params;
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)
    || !Number.isSafeInteger(frame) || !Number.isFinite(fps) || fps <= 0) {
    throw new RangeError('Invalid motion frame geometry or clock');
  }
  if (typeof text !== 'string' || text.length > 32 || !text.trim()
    || typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)
    || !Number.isFinite(fontSize) || fontSize <= 0 || fontSize > 1024
    || ![enterFrames, exitFrames, durationFrames].every(value => Number.isSafeInteger(value) && value >= 0)
    || durationFrames === 0 || enterFrames + exitFrames > durationFrames) {
    throw new RangeError('Invalid title pop parameters');
  }
  const glyphs = Array.from(text);
  if (!glyphs.every(glyph => isTimelineSubtitleCodePoint(glyph.codePointAt(0)))) {
    throw new RangeError('Title contains characters outside the pinned font');
  }
  const opacity = fadeOpacity(frame, durationFrames, 0, exitFrames);
  if (opacity === 0) return null;

  const gaps = glyphs.length - 1;
  const delayBudget = Math.min(gaps * Math.max(1, Math.round(fps * 0.06)), Math.floor(enterFrames / 2));
  const spacing = gaps === 0 ? 0 : delayBudget / gaps;
  const glyphEnterFrames = enterFrames - delayBudget;

  return (
    <div aria-hidden="true" style={{width, height, overflow: 'hidden', display: 'grid', placeItems: 'center', pointerEvents: 'none', opacity}}>
      <span style={{color, fontSize, fontFamily: '"Mioon Motion Prototype"', fontWeight: 400, fontSynthesis: 'none', lineHeight: 1.2, whiteSpace: 'pre'}}>
        {glyphs.map((glyph, index) => {
          const progress = frameProgress(staggerFrame(frame, index, spacing), glyphEnterFrames);
          const spring = springProgress(progress);
          return (
            <span key={index} style={{
              display: 'inline-block',
              opacity: enterOpacity(progress),
              transform: `translateY(${interpolate(fontSize * 0.44, 0, spring)}px) scale(${interpolate(0.8, 1, spring)})`,
            }}>{glyph}</span>
          );
        })}
      </span>
    </div>
  );
}

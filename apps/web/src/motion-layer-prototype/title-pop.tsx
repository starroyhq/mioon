import {sampleTitlePop, titleFontFamily} from './title-pop-state.ts';
import type {TitlePopParams} from './title-pop-state.ts';
import type {MotionFrameProps} from './runtime.ts';

export type {TitlePopParams} from './title-pop-state.ts';

/** Retain the original DOM raster path for the same-job capture comparison. */
export function TitlePop(props: MotionFrameProps<TitlePopParams>) {
  const state = sampleTitlePop(props);
  if (!state) return null;
  const {width, height, params: {fontSize, color}} = props;
  return (
    <div aria-hidden="true" style={{width, height, overflow: 'hidden', display: 'grid', placeItems: 'center', pointerEvents: 'none', opacity: state.opacity}}>
      <span style={{color, fontSize, fontFamily: titleFontFamily, fontWeight: 400, fontSynthesis: 'none', lineHeight: 1.2, whiteSpace: 'pre'}}>
        {state.glyphs.map(({glyph, opacity, offsetY, scale}, index) => (
          <span key={index} style={{display: 'inline-block', opacity, transform: `translateY(${offsetY}px) scale(${scale})`}}>
            {glyph}
          </span>
        ))}
      </span>
    </div>
  );
}

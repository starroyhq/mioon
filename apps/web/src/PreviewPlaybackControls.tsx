import React from 'react';
import {useEffect, useRef, useState} from 'react';
import {Play, Pause, StepBack, StepForward, Maximize} from '@mioon/ui/components/workbench-icons';
import {Button} from '@mioon/ui/components/button';
import {useI18n} from './i18n/I18nProvider.tsx';
import {displayTimelineFrame} from './timeline-removal.ts';
interface Props {
  bindingKey: string; getMedia: () => HTMLMediaElement | null; isCurrent: (media: HTMLMediaElement) => boolean;
  position: number; duration: number; fps: number; format: 'timecode'|'seconds'; standaloneSource: boolean;
  onStep: (delta: number) => void; metadata: string;
}
/** A control always re-reads the current binding; a retained event cannot play
 * a hidden/disposed source after workspace or preview-mode navigation. */
export default function PreviewPlaybackControls(props: Props) {
  const {t} = useI18n();
  const current = useRef(props);current.current = props;
  const [state,setState] = useState({playing:false,ready:false}), [failed,setFailed] = useState(false);
  // Parent layout effects restore the binding/visibility before readiness is
  // sampled, including a retained player reopened after its metadata loaded.
  useEffect(() => {
    const media = props.getMedia();setFailed(false);
    const update = () => setState({playing:Boolean(media && props.isCurrent(media) && !media.paused && !media.ended),ready:Boolean(media && props.isCurrent(media) && media.readyState >= 1)});
    update();
    const events = ['play','playing','pause','ended','loadedmetadata','emptied','error'];
    for (const name of events) media?.addEventListener(name,update);
    return () => {for (const name of events) media?.removeEventListener(name,update);};
  }, [props.bindingKey,props.getMedia,props.isCurrent]);
  async function toggle() {
    const value = current.current, media = value.getMedia();
    if (!media || !value.isCurrent(media) || media.readyState < 1) return;
    if (!media.paused) {media.pause();return;}
    setFailed(false);
    try {await media.play();} catch {if (current.current.bindingKey===value.bindingKey && value.isCurrent(media)) setFailed(true);}
  }
  function fullscreen() {
    const value=current.current,media=value.getMedia();
    if (!media || !value.isCurrent(media) || !media.requestFullscreen) return;
    void media.requestFullscreen().catch(() => {if(current.current.bindingKey===value.bindingKey&&value.isCurrent(media))setFailed(true);});
  }
  return <footer className="preview-footer edit-preview-footer" title={props.metadata}>
    <output data-testid={props.standaloneSource?'source-preview-position':undefined}>{displayTimelineFrame(props.position,props.fps,props.format)}<small> / {displayTimelineFrame(props.duration,props.fps,props.format)}</small></output>
    <div className="edit-preview-playback"><Button variant="ghost" size="icon-sm" aria-label={t('edit.preview.previous')} disabled={!state.ready} onClick={() => current.current.onStep(-1)}><StepBack size={15}/></Button><Button variant="ghost" className="edit-preview-play" data-testid="preview-play-pause" aria-label={t(state.playing?'edit.preview.pause':'edit.preview.play')} disabled={!state.ready} onClick={() => {void toggle();}}>{state.playing?<Pause size={17}/>:<Play size={17}/>}</Button><Button variant="ghost" size="icon-sm" aria-label={t('edit.preview.next')} disabled={!state.ready} onClick={() => current.current.onStep(1)}><StepForward size={15}/></Button></div>
    <div className="edit-preview-options">{failed && <span role="status">{t('edit.preview.unavailable')}</span>}<span className="sr-only">{props.metadata}</span><Button variant="ghost" size="icon-sm" aria-label={t('edit.preview.fullscreen')} disabled={!state.ready} onClick={fullscreen}><Maximize size={15}/></Button></div>
  </footer>;
}

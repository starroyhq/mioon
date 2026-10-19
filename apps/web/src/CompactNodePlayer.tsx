import React,{useLayoutEffect,useMemo,useRef,useState} from 'react';
import {WorkbenchButton} from '@mioon/ui/components/workbench-controls';
import {Play,Pause} from '@mioon/ui/components/workbench-icons';
import {useWorkspaceVisibility} from './workspace-visibility.tsx';
import {useI18n} from './i18n/I18nProvider.tsx';
type Events=Pick<React.VideoHTMLAttributes<HTMLVideoElement>,'onLoadedMetadata'|'onTimeUpdate'|'onPlay'|'onPause'|'onEnded'|'onError'>;
interface Props{sourceKey:string;renderMedia(events:Events):React.ReactNode}
const stamp=(seconds:number)=>`${Math.floor(Math.max(0,seconds)/60)}:${String(Math.floor(Math.max(0,seconds)%60)).padStart(2,'0')}`;
/** Media retains decoder/source ownership. This leaf only owns compact explicit
 * controls, fenced to the visible node and exact current video element. */
export default function CompactNodePlayer({sourceKey,renderMedia}:Props){
  const {t}=useI18n(),visible=useWorkspaceVisibility(),container=useRef<HTMLDivElement>(null);
  const [state,setState]=useState({sourceKey,playing:false,time:0,duration:0,error:false});
  const current=state.sourceKey===sourceKey?state:{sourceKey,playing:false,time:0,duration:0,error:false};
  const token=useMemo(()=>({sourceKey,visible}),[sourceKey,visible]),live=useRef<typeof token|null>(null);
  const element=()=>container.current?.querySelector('video')??null;
  useLayoutEffect(()=>{live.current=token;const video=element();if(!visible)video?.pause();else if(video)update(video);return()=>{live.current=null;element()?.pause();};},[token]);
  const active=(video:HTMLVideoElement)=>visible&&live.current===token&&video===element()&&video.isConnected;
  function update(video:HTMLVideoElement){if(!active(video))return;setState({sourceKey,playing:!video.paused&&!video.ended,time:Number.isFinite(video.currentTime)?video.currentTime:0,duration:Number.isFinite(video.duration)?video.duration:0,error:false});}
  function toggle(){const video=element();if(!video||!active(video))return;if(!video.paused){video.pause();update(video);return;}
    void video.play().then(()=>{if(!active(video)){video.pause();return;}update(video);}).catch(()=>{if(active(video))setState({...current,sourceKey,error:true,playing:false});});}
  const events:Events={onLoadedMetadata:event=>update(event.currentTarget),onTimeUpdate:event=>update(event.currentTarget),onPlay:event=>update(event.currentTarget),onPause:event=>update(event.currentTarget),onEnded:event=>update(event.currentTarget),onError:event=>{if(active(event.currentTarget))setState({...current,sourceKey,error:true,playing:false});}};
  return <div ref={container} className="compact-node-player nodrag nowheel">
    {renderMedia(events)}
    <div className="compact-node-controls">
      <WorkbenchButton variant="icon" size="compact" aria-label={t(current.playing?'redesign.board.pause':'redesign.board.play')} disabled={!visible} onClick={event=>{event.stopPropagation();toggle();}}>{current.playing?<Pause size={13}/>:<Play size={13}/>}</WorkbenchButton>
      <input type="range" min={0} max={Math.max(current.duration,.01)} step={.01} value={Math.min(current.time,current.duration)} aria-label={t('redesign.board.seek')} disabled={!visible||current.duration<=0} onPointerDown={event=>event.stopPropagation()} onChange={event=>{const video=element();if(!video||!active(video))return;try{video.currentTime=Math.min(current.duration,Math.max(0,Number(event.target.value)));update(video);}catch{setState({...current,sourceKey,error:true});}}}/>
      <span className="compact-node-time">{stamp(current.time)} / {stamp(current.duration)}</span>
    </div>
    {current.error&&<span className="compact-node-error" role="alert">{t('redesign.board.playbackUnavailable')}</span>}
  </div>;
}

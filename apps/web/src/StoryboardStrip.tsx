import React,{useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Collapsible,CollapsibleTrigger,CollapsibleContent} from '@mioon/ui/components/collapsible';
import {WorkbenchButton} from '@mioon/ui/components/workbench-controls';
import {Clapperboard,ChevronDown,Plus,ArrowUp,ArrowDown} from '@mioon/ui/components/workbench-icons';
import {useI18n} from './i18n/I18nProvider.tsx';
import {WorkspaceVisibilityProvider,useWorkspaceVisibility} from './workspace-visibility.jsx';
interface Shot{id:string;title:string;duration:number;selectedVersionId?:string|null}
interface Version{id:string;assetId?:string;number:number;snapshot?:{duration?:number}}
interface Props{scope:string;open:boolean;onOpenChange(value:boolean):void;shots:readonly Shot[];versions:readonly Version[];selectedId:string|null;reordering:boolean;assetDragType:string;onSelect(shotId:string):void|Promise<void>;onReorder(shotId:string,index:number):void;onAddShot():void;renderThumbnail(shot:Shot):React.ReactNode}
export default function StoryboardStrip(props:Props){
  const {t,formatNumber}=useI18n(),visible=useWorkspaceVisibility(),[drag,setDrag]=useState<{scope:string;id:string}|null>(null),token=useMemo(()=>({scope:props.scope,open:props.open,visible}),[props.scope,props.open,visible]),live=useRef<typeof token|null>(null);
  useLayoutEffect(()=>{live.current=token;setDrag(null);return()=>{live.current=null;};},[token]);
  const current=()=>visible&&live.current===token,dragId=drag?.scope===props.scope?drag.id:null;
  const total=props.shots.reduce((sum,shot)=>sum+Number(props.versions.find(version=>version.id===shot.selectedVersionId)?.snapshot?.duration||shot.duration),0);
  return <Collapsible open={props.open} onOpenChange={next=>{if(current())props.onOpenChange(next);}} className={`board-storyboard ${props.open?'':'sequence-collapsed'}`} render={<section aria-label={t('storyboard.order')}/>}>
    <header><Clapperboard size={14}/><h2>{t('storyboard.title')}</h2><span className="storyboard-summary">{t('storyboard.summary',{count:props.shots.length,seconds:formatNumber(total)})}</span><CollapsibleTrigger render={<WorkbenchButton variant="icon" size="compact" aria-label={t(props.open?'storyboard.collapse':'storyboard.expand')}/>}><ChevronDown size={14}/></CollapsibleTrigger></header>
    <WorkspaceVisibilityProvider visible={props.open}><CollapsibleContent keepMounted inert={!props.open} className="storyboard-track" data-testid="storyboard">{props.shots.map((shot,index)=>{
      const version=props.versions.find(item=>item.id===shot.selectedVersionId);
      return <div key={shot.id} className={`storyboard-shot ${props.selectedId===shot.id?'selected':''} ${dragId===shot.id?'dragging':''}`} data-testid={`storyboard-shot-${shot.id}`} draggable={!props.reordering}
        onDragStart={event=>{if(!current()||!props.open||props.reordering){event.preventDefault();return;}event.dataTransfer.setData('text/plain',shot.id);if(version?.assetId)event.dataTransfer.setData(props.assetDragType,version.assetId);event.dataTransfer.effectAllowed='copyMove';setDrag({scope:props.scope,id:shot.id});}}
        onDragEnd={()=>{if(current())setDrag(null);}} onDragOver={event=>{if(current()&&props.open&&dragId)event.preventDefault();}} onDrop={event=>{if(!current()||!props.open||!dragId||props.reordering)return;event.preventDefault();props.onReorder(dragId,index);setDrag(null);}}>
        <WorkbenchButton variant="ghost" className="storyboard-preview" aria-label={t('storyboard.select',{name:`${index+1} ${shot.title}`})} onClick={()=>{if(current()&&props.open)void props.onSelect(shot.id);}}>{props.renderThumbnail(shot)}<span className="storyboard-index">{String(index+1).padStart(2,'0')}</span><span className="storyboard-duration">{version?.snapshot?.duration||shot.duration}s</span>{version&&<span className="storyboard-version">V{version.number}</span>}</WorkbenchButton>
        <div className="storyboard-shot-meta"><span title={shot.title}>{shot.title}</span><div><WorkbenchButton variant="icon" aria-label={t('storyboard.moveEarlier',{name:shot.title})} disabled={index===0||props.reordering} onClick={()=>{if(current()&&props.open)props.onReorder(shot.id,index-1);}}><ArrowUp size={12}/></WorkbenchButton><WorkbenchButton variant="icon" aria-label={t('storyboard.moveLater',{name:shot.title})} disabled={index===props.shots.length-1||props.reordering} onClick={()=>{if(current()&&props.open)props.onReorder(shot.id,index+1);}}><ArrowDown size={12}/></WorkbenchButton></div></div>
      </div>;
    })}{!props.shots.length?<div className="storyboard-empty">{t('storyboard.empty')}</div>:<WorkbenchButton variant="ghost" className="storyboard-add" aria-label={t('storyboard.addNext')} onClick={()=>{if(current()&&props.open)props.onAddShot();}}><Plus size={20}/></WorkbenchButton>}</CollapsibleContent></WorkspaceVisibilityProvider>
  </Collapsible>;
}

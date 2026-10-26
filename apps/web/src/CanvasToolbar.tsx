import React,{useLayoutEffect,useMemo,useRef,useState} from 'react';
import {WorkbenchButton} from '@mioon/ui/components/workbench-controls';
import {WorkbenchPopover,WorkbenchPopoverTrigger,WorkbenchPopoverTitle,WorkbenchPopoverContent} from '@mioon/ui/components/workbench-popover';
import {Plus,Type,Image,Video,Sparkles,Link} from '@mioon/ui/components/workbench-icons';
import {useI18n} from './i18n/I18nProvider.tsx';
import {WorkbenchTooltip} from '@mioon/ui/components/workbench-tooltip';
import {useWorkspaceVisibility} from './workspace-visibility.tsx';
import './board-redesign.css';
interface Props{scope:string;visible?:boolean;addingShot?:boolean;imageDisabled?:boolean;onAddShot():void;onAddText():void;onAddImage():void;onAddVideo():void;onGenerateImage():void}
export default function CanvasToolbar({scope,visible:requestedVisible=true,addingShot=false,imageDisabled=false,onAddShot,onAddText,onAddImage,onAddVideo,onGenerateImage}:Props){
  const ancestorVisible=useWorkspaceVisibility(),visible=requestedVisible&&ancestorVisible;
  const {t}=useI18n(),[legend,setLegend]=useState(false),token=useMemo(()=>({scope,visible}),[scope,visible]),live=useRef<typeof token|null>(null);
  useLayoutEffect(()=>{live.current=token;setLegend(false);return()=>{live.current=null;};},[token]);
  const admit=(action:()=>void)=>{if(visible&&live.current===token)action();};
  const hint=(content:string,button:React.ReactElement)=>visible?<WorkbenchTooltip content={content}>{button}</WorkbenchTooltip>:button;
  return <div className="board-toolbar-heading" data-text-selectable={false}><div className="board-floating-toolbar" role="toolbar" aria-label={t('shell.canvasWorkspace')}>
    <WorkbenchButton variant="primary" data-testid="add-shot" disabled={!visible||addingShot} onClick={()=>admit(onAddShot)}><Plus size={15}/>{t('redesign.board.addShot')}</WorkbenchButton><span className="board-toolbar-separator"/>
    {hint(t('shell.text'),<WorkbenchButton variant="ghost" aria-label={t('shell.text')} data-testid="add-text-node" disabled={!visible} onClick={()=>admit(onAddText)}><Type size={15}/><span className="board-tool-label">{t('shell.text')}</span></WorkbenchButton>)}
    {hint(t('assets.image'),<WorkbenchButton variant="ghost" aria-label={t('assets.image')} data-testid="add-image-node" disabled={!visible} onClick={()=>admit(onAddImage)}><Image size={15}/><span className="board-tool-label">{t('assets.image')}</span></WorkbenchButton>)}
    {hint(t('assets.video'),<WorkbenchButton variant="ghost" aria-label={t('assets.video')} data-testid="add-video-node" disabled={!visible} onClick={()=>admit(onAddVideo)}><Video size={15}/><span className="board-tool-label">{t('assets.video')}</span></WorkbenchButton>)}
    {hint(t('shell.images'),<WorkbenchButton variant="ghost" aria-label={t('shell.images')} id="right-dock-image-tab" data-testid="right-dock-tab-image" disabled={!visible||imageDisabled} onClick={()=>admit(onGenerateImage)}><Sparkles size={15}/><span className="board-tool-label">{t('shell.images')}</span></WorkbenchButton>)}
    <WorkbenchPopover open={legend&&visible} onOpenChange={next=>admit(()=>setLegend(next))}><WorkbenchPopoverTrigger render={<WorkbenchButton variant="icon" aria-label={t('redesign.board.connectionLegend')} title={t('redesign.board.connectionLegend')} disabled={!visible}/>}><Link size={16}/></WorkbenchPopoverTrigger>
      <WorkbenchPopoverContent className="board-legend-popover" hidden={!visible} inert={!visible} finalFocus={visible?undefined:false}><WorkbenchPopoverTitle>{t('redesign.board.connectionLegend')}</WorkbenchPopoverTitle><div data-testid="connection-legend" className="board-legend-items" data-text-selectable><div><span className="reference-swatch"/><section><strong>{t('redesign.board.referenceTitle')}</strong><p>{t('redesign.board.referenceHint')}</p></section></div><div><span className="visual-swatch"/><section><strong>{t('redesign.board.visualTitle')}</strong><p>{t('redesign.board.visualHint')}</p></section></div></div></WorkbenchPopoverContent>
    </WorkbenchPopover>
  </div></div>;
}

import React,{useLayoutEffect,useMemo,useRef,useState} from 'react';
import {WorkbenchButton} from '@mioon/ui/components/workbench-controls';
import {WorkbenchPopover,WorkbenchPopoverTrigger,WorkbenchPopoverTitle,WorkbenchPopoverContent} from '@mioon/ui/components/workbench-popover';
import {Plus,Type,Image,Video,Sparkles,Link,Box,Grid2X2} from '@mioon/ui/components/workbench-icons';
import {useI18n} from './i18n/I18nProvider.tsx';
import {WorkbenchTooltip} from '@mioon/ui/components/workbench-tooltip';
import {useWorkspaceVisibility} from './workspace-visibility.tsx';
import {canvasEditMacShortcuts} from './CanvasEditingControls.tsx';
import './board-redesign.css';
interface Props{scope:string;visible?:boolean;addingShot?:boolean;imageDisabled?:boolean;previsDisabled?:boolean;addingPrevis?:boolean;editing?:{tidy():void;tidyDisabled?:boolean;hasSelection?:boolean;archive?:React.ReactNode};onAddShot():void;onAddPrevis?():void;onAddText():void;onAddImage():void;onAddVideo():void;onGenerateImage():void}
export default function CanvasToolbar({scope,visible:requestedVisible=true,addingShot=false,imageDisabled=false,previsDisabled=false,addingPrevis=false,editing,onAddShot,onAddPrevis,onAddText,onAddImage,onAddVideo,onGenerateImage}:Props){
  const ancestorVisible=useWorkspaceVisibility(),visible=requestedVisible&&ancestorVisible;
  const {t}=useI18n(),[legend,setLegend]=useState(false),token=useMemo(()=>({scope,visible}),[scope,visible]),live=useRef<typeof token|null>(null);
  useLayoutEffect(()=>{live.current=token;setLegend(false);return()=>{live.current=null;};},[token]);
  const admit=(action:()=>void)=>{if(visible&&live.current===token)action();};
  const hint=(content:string,button:React.ReactElement)=>visible?<WorkbenchTooltip content={content}>{button}</WorkbenchTooltip>:button;
  const mac=canvasEditMacShortcuts();
  return <div className="board-toolbar-heading" data-text-selectable={false}><div className={`board-floating-toolbar${editing?' canvas-edit-toolbar':''}`} role="toolbar" aria-label={t('shell.canvasWorkspace')}>
    <WorkbenchButton variant="primary" data-testid="add-shot" disabled={!visible||addingShot} onClick={()=>admit(onAddShot)}><Plus size={15}/>{t('redesign.board.addShot')}</WorkbenchButton><span className="board-toolbar-separator"/>
    {onAddPrevis&&hint(t('previs.toolbar.addHint'),<WorkbenchButton variant="ghost" aria-label={t('previs.toolbar.add')} data-testid="add-previs-node" disabled={!visible||previsDisabled||addingPrevis} onClick={()=>admit(onAddPrevis)}><Box size={15}/><span className="board-tool-label">{t('previs.toolbar.add')}</span></WorkbenchButton>)}
    {hint(t('shell.text'),<WorkbenchButton variant="ghost" aria-label={t('shell.text')} data-testid="add-text-node" disabled={!visible} onClick={()=>admit(onAddText)}><Type size={15}/><span className="board-tool-label">{t('shell.text')}</span></WorkbenchButton>)}
    {hint(t('assets.image'),<WorkbenchButton variant="ghost" aria-label={t('assets.image')} data-testid="add-image-node" disabled={!visible} onClick={()=>admit(onAddImage)}><Image size={15}/><span className="board-tool-label">{t('assets.image')}</span></WorkbenchButton>)}
    {hint(t('assets.video'),<WorkbenchButton variant="ghost" aria-label={t('assets.video')} data-testid="add-video-node" disabled={!visible} onClick={()=>admit(onAddVideo)}><Video size={15}/><span className="board-tool-label">{t('assets.video')}</span></WorkbenchButton>)}
    {hint(t('shell.images'),<WorkbenchButton variant="ghost" aria-label={t('shell.images')} id="right-dock-image-tab" data-testid="right-dock-tab-image" disabled={!visible||imageDisabled} onClick={()=>admit(onGenerateImage)}><Sparkles size={15}/><span className="board-tool-label">{t('shell.images')}</span></WorkbenchButton>)}
    {editing&&<><span className="board-toolbar-separator" aria-hidden="true"/>
      {hint(`${t(editing.hasSelection?'canvas.edit.tidySelected':'canvas.edit.tidyHint')} · ${mac?'⇧⌘L':'Ctrl+Shift+L'}`,<WorkbenchButton variant="ghost" aria-label={t('canvas.edit.tidy')} aria-keyshortcuts={mac?'Meta+Shift+L':'Control+Shift+L'} data-testid="canvas-tidy" disabled={!visible||editing.tidyDisabled} onClick={()=>admit(editing.tidy)}><Grid2X2 size={15} aria-hidden="true"/><span className="board-tool-label">{t('canvas.edit.tidy')}</span></WorkbenchButton>)}
    </>}
    <WorkbenchPopover open={legend&&visible} onOpenChange={next=>admit(()=>setLegend(next))}><WorkbenchPopoverTrigger render={<WorkbenchButton variant="icon" aria-label={t('redesign.board.connectionLegend')} title={t('redesign.board.connectionLegend')} disabled={!visible}/>}><Link size={16}/></WorkbenchPopoverTrigger>
      <WorkbenchPopoverContent className="board-legend-popover" hidden={!visible} inert={!visible} finalFocus={visible?undefined:false}><WorkbenchPopoverTitle>{t('redesign.board.connectionLegend')}</WorkbenchPopoverTitle><div data-testid="connection-legend" className="board-legend-items" data-text-selectable><div><span className="reference-swatch"/><section><strong>{t('redesign.board.referenceTitle')}</strong><p>{t('redesign.board.referenceHint')}</p></section></div><div><span className="visual-swatch"/><section><strong>{t('redesign.board.visualTitle')}</strong><p>{t('redesign.board.visualHint')}</p></section></div></div></WorkbenchPopoverContent>
    </WorkbenchPopover>
    {editing?.archive}
  </div></div>;
}

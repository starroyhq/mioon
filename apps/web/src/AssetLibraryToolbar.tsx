import React,{useLayoutEffect,useMemo,useRef,useState} from 'react';
import {WorkbenchButton,WorkbenchChip} from '@mioon/ui/components/workbench-controls';
import {WorkbenchPopover,WorkbenchPopoverTrigger,WorkbenchPopoverTitle,WorkbenchPopoverClose,WorkbenchPopoverContent} from '@mioon/ui/components/workbench-popover';
import {SlidersHorizontal,Grid2X2,List,X} from '@mioon/ui/components/workbench-icons';
import {useI18n} from './i18n/I18nProvider.tsx';
export type LibraryLayout='grid'|'list';
export interface LibraryFilterChip{key:string;label:string;remove():void;disabled?:boolean}
export function useAssetLibraryLayout(scope:string|undefined){
  const [state,setState]=useState<{scope:string|undefined;value:LibraryLayout}>({scope,value:'grid'});
  return {layout:state.scope===scope?state.value:'grid' as LibraryLayout,setLayout:(value:LibraryLayout)=>setState({scope,value})};
}
interface Props{scope:string|undefined;visible:boolean;count:number;layout:LibraryLayout;onLayout(value:LibraryLayout):void;search:React.ReactNode;chips:readonly LibraryFilterChip[];children:React.ReactNode}
/** Filter portals retire with the owning project or hidden library. Old close,
 * chip and toggle callbacks cannot regain authority when the panel reopens. */
export default function AssetLibraryToolbar({scope,visible,count,layout,onLayout,search,chips,children}:Props){
  const {t,formatNumber}=useI18n(),[opened,setOpened]=useState(false);
  const token=useMemo(()=>({scope,visible}),[scope,visible]),live=useRef<typeof token|null>(null);
  useLayoutEffect(()=>{live.current=token;setOpened(false);return()=>{live.current=null;};},[token]);
  const admitted=()=>Boolean(scope&&visible&&live.current===token);
  return <div className="asset-library-toolbar">
    <div className="asset-library-search-row">{search}<WorkbenchPopover open={opened&&visible} onOpenChange={next=>{if(admitted())setOpened(next);}}>
      <WorkbenchPopoverTrigger render={<WorkbenchButton variant="icon" className="asset-filter-trigger" aria-label={t('redesign.library.filters')} title={t('redesign.library.filters')} data-testid="asset-filters-open" disabled={!visible||!scope} />}><SlidersHorizontal size={15}/>{chips.length>0&&<span className="asset-filter-count">{formatNumber(chips.length)}</span>}</WorkbenchPopoverTrigger>
      {/* Nested official Select portals use layer 50; keep this parent below
          them and above workspace overlays so its body cannot cover options. */}
      <WorkbenchPopoverContent className="asset-filter-popover" zIndex={40} hidden={!visible} inert={!visible} finalFocus={visible?undefined:false}>
        <header><WorkbenchPopoverTitle>{t('redesign.library.filters')}</WorkbenchPopoverTitle><WorkbenchPopoverClose render={<WorkbenchButton variant="icon" aria-label={t('common.close')}/>}><X size={14}/></WorkbenchPopoverClose></header>
        {visible&&<div className="asset-filter-popover-body">{children}</div>}
      </WorkbenchPopoverContent>
    </WorkbenchPopover></div>
    {chips.length>0&&<div className="asset-filter-chips" data-testid="asset-filter-chips">{chips.map(chip=><WorkbenchChip key={chip.key} className="asset-filter-chip" title={chip.label} aria-label={t('redesign.library.removeFilter',{filter:chip.label})} disabled={!visible||chip.disabled} onClick={()=>{if(admitted())chip.remove();}}>{chip.label}<X size={11}/></WorkbenchChip>)}</div>}
    <div className="asset-library-view-row"><span role="status">{t('redesign.library.itemCount',{count})}</span><div role="group" aria-label={t('redesign.library.layout')}>
      <WorkbenchButton variant="icon" size="compact" data-testid="asset-layout-grid" aria-label={t('redesign.library.grid')} title={t('redesign.library.grid')} aria-pressed={layout==='grid'} disabled={!visible} onClick={()=>{if(admitted())onLayout('grid');}}><Grid2X2 size={15}/></WorkbenchButton>
      <WorkbenchButton variant="icon" size="compact" data-testid="asset-layout-list" aria-label={t('redesign.library.list')} title={t('redesign.library.list')} aria-pressed={layout==='list'} disabled={!visible} onClick={()=>{if(admitted())onLayout('list');}}><List size={15}/></WorkbenchButton>
    </div></div>
  </div>;
}

import React,{useCallback,useEffect,useRef,useState} from 'react';
import {WorkbenchAlert,WorkbenchBadge,WorkbenchButton,WorkbenchProgress} from '@mioon/ui/components/workbench-controls';
import {useI18n} from './i18n/I18nProvider.tsx';
import {workspaceBackupBridge} from './workspace-settings-client.ts';
import type {MediaToolDiagnostics,MediaToolsStatus,ToolPaths,WorkspaceToolsBridge} from '../../../packages/contracts/src/workspace-info.ts';

const ACTIVE=new Set(['downloading','verifying','checking','installing']);
const megabytes=(bytes:number)=>`${(bytes/1048576).toFixed(1)} MB`;
const same=(a:ToolPaths|null,b:ToolPaths|null)=>Boolean(a&&b&&a.ffmpeg===b.ffmpeg&&a.ffprobe===b.ffprobe);
export function mediaToolsFailureKey(code:string){
 if(code==='MEDIA_TOOLS_CANCELLED')return 'workspace.tools.download.cancelled' as const;
 if(['MEDIA_TOOLS_CHECKSUM_MISMATCH','MEDIA_TOOLS_SIZE_MISMATCH','MEDIA_TOOLS_ARCHIVE_INVALID'].includes(code))return 'workspace.tools.download.corrupt' as const;
 if(code==='MEDIA_TOOLS_CHECK_FAILED')return 'workspace.tools.download.checkFailed' as const;
 if(['MEDIA_TOOLS_STORAGE_UNAVAILABLE','MEDIA_TOOLS_INSTALL_FAILED'].includes(code))return 'workspace.tools.download.storage' as const;
 return 'workspace.tools.download.network' as const;
}
/** Mioon's pinned FFmpeg build: download, verify, install and save its paths through the fixed native bridge. */
export default function SettingsMediaToolsDownload({native,active,saved,onInstalled,onBusyChange}:{native:WorkspaceToolsBridge;active:boolean;saved:ToolPaths|null;
 onInstalled:(paths:ToolPaths,diagnostics:MediaToolDiagnostics)=>void;onBusyChange?:(busy:boolean)=>void}){
 const {t}=useI18n(),[status,setStatus]=useState<MediaToolsStatus|null>(null),[failure,setFailure]=useState<string|null>(null),[done,setDone]=useState(false),[running,setRunning]=useState(false);
 const mounted=useRef(true),runningRef=useRef(false);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const refresh=useCallback(async()=>{try{const value=await native.mediaToolsStatus();if(mounted.current)setStatus(value);}catch{/* The offer stays hidden without a status. */}},[native]);
 useEffect(()=>{if(active)void refresh();},[active,refresh]);
 const installing=running||(status!==null&&ACTIVE.has(status.progress.phase));
 useEffect(()=>{onBusyChange?.(installing);},[installing,onBusyChange]);
 // Progress is polled only while an installation runs, including one started before this page opened.
 useEffect(()=>{if(!installing)return;const timer=setInterval(()=>{void refresh();},400);return()=>clearInterval(timer);},[installing,refresh]);
 if(!status?.offer)return null;
 const {offer,progress}=status,inUse=same(status.installed,saved),restart=workspaceBackupBridge()?.restart;
 const install=async()=>{
  if(runningRef.current||!active)return;runningRef.current=true;setRunning(true);setFailure(null);setDone(false);
  try{const result=await native.installMediaTools();if(!mounted.current)return;if(result.ok){onInstalled(result.paths,result.diagnostics);setDone(true);}else setFailure(result.code);}
  catch{if(mounted.current)setFailure('MEDIA_TOOLS_INSTALL_FAILED');}
  finally{runningRef.current=false;if(mounted.current){setRunning(false);void refresh();}}
 };
 const phase=progress.phase==='verifying'?t('workspace.tools.download.verifying'):progress.phase==='checking'?t('workspace.tools.download.checking')
  :progress.phase==='installing'?t('workspace.tools.download.installing')
   :t('workspace.tools.download.downloading',{received:megabytes(progress.receivedBytes),total:megabytes(progress.totalBytes||offer.downloadBytes)});
 const percent=progress.phase==='downloading'&&progress.totalBytes>0?progress.receivedBytes/progress.totalBytes*100:progress.phase==='idle'?0:100;
 return <section className="workspace-tool-card workspace-tool-download" data-testid="workspace-tools-download">
  <header><h2>{t('workspace.tools.download.title')}</h2>{inUse&&<WorkbenchBadge tone="success">{t('workspace.tools.download.inUse')}</WorkbenchBadge>}</header>
  <p>{t('workspace.tools.download.summary',{version:offer.ffmpegVersion,arch:t(offer.arch==='arm64'?'workspace.tools.download.archArm64':'workspace.tools.download.archX64'),size:megabytes(offer.downloadBytes)})}</p>
  <p>{t('workspace.tools.download.help')}<span data-text-selectable>{offer.sourceUrl}</span></p>
  {installing&&<div className="workspace-tool-download-progress" data-testid="workspace-tools-download-progress"><WorkbenchProgress value={percent} label={phase}/><span aria-live="polite">{phase}</span></div>}
  {failure&&!installing&&<WorkbenchAlert tone={failure==='MEDIA_TOOLS_CANCELLED'?'neutral':'warning'} data-testid="workspace-tools-download-failure">{t(mediaToolsFailureKey(failure))}</WorkbenchAlert>}
  {done&&!installing&&<WorkbenchAlert tone="success" actions={restart&&<WorkbenchButton onClick={()=>{void restart().catch(()=>{});}}>{t('workspace.tools.download.restart')}</WorkbenchButton>}>{t('workspace.tools.download.done')}</WorkbenchAlert>}
  <div className="workspace-tool-actions">{installing
   ?<WorkbenchButton data-testid="workspace-tools-download-cancel" disabled={progress.phase==='installing'} onClick={()=>{void native.cancelMediaToolsInstall().catch(()=>{});}}>{t('workspace.tools.download.cancel')}</WorkbenchButton>
   :!inUse&&<WorkbenchButton variant="primary" data-testid="workspace-tools-download-install" disabled={!active} onClick={()=>void install()}>{t(status.installed?'workspace.tools.download.use':'workspace.tools.download.install')}</WorkbenchButton>}</div>
 </section>;
}

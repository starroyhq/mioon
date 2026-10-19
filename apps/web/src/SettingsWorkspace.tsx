import React,{useEffect,useState} from 'react';
import type {ReactNode} from 'react';
import {WorkbenchAlert,WorkbenchButton} from '@mioon/ui/components/workbench-controls';
import {useI18n} from './i18n/I18nProvider.tsx';
import {readWorkspaceInfo,revealWorkspaceLocation,workspaceToolsBridge} from './workspace-info-client.ts';
import type {WorkspaceInfo} from '../../../packages/contracts/src/workspace-info.ts';
import './workspace-tools.css';
export default function SettingsWorkspace({active,children}:{active:boolean;children?:ReactNode}){
 const {t,formatNumber}=useI18n(),[info,setInfo]=useState<WorkspaceInfo|null>(null),[failed,setFailed]=useState(false),[copied,setCopied]=useState(false),[refresh,setRefresh]=useState(0);
 useEffect(()=>{if(!active)return;let live=true;const abort=new AbortController();setFailed(false);void readWorkspaceInfo(abort.signal).then(value=>{if(live)setInfo(value);}).catch(()=>{if(live)setFailed(true);});return()=>{live=false;abort.abort();};},[active,refresh]);
 return <section className="settings-workspace" data-testid="settings-workspace"><h2>{t('workspace.info.title')}</h2>{failed&&<WorkbenchAlert tone="warning" actions={<WorkbenchButton onClick={()=>setRefresh(value=>value+1)}>{t('projects.refreshList')}</WorkbenchButton>}>{t('workspace.info.failed')}</WorkbenchAlert>}
 <dl className="workspace-info-list"><div><dt>{t('workspace.info.directory')}</dt><dd><input readOnly aria-label={t('workspace.info.directory')} value={info?.dataDirectory??''}/></dd></div><div><dt>{t('workspace.info.usage')}</dt><dd>{info?`${formatNumber(info.usage.bytes/1024/1024,{maximumFractionDigits:1})} MB`:'—'}</dd></div></dl>
 {info&&!info.usage.complete&&<p>{t('workspace.info.estimate')}</p>}{info&&info.pendingProjectCleanup>0&&<WorkbenchAlert tone="warning">{t('workspace.info.cleanupPending',{count:info.pendingProjectCleanup})}</WorkbenchAlert>}
 <div className="workspace-tool-actions"><WorkbenchButton disabled={!info||!active} onClick={()=>{if(info&&active)void navigator.clipboard.writeText(info.dataDirectory).then(()=>setCopied(true)).catch(()=>setFailed(true));}}>{t('workspace.info.copy')}</WorkbenchButton>{workspaceToolsBridge()&&<WorkbenchButton disabled={!info||!active} onClick={()=>{if(active)void revealWorkspaceLocation().catch(()=>setFailed(true));}}>{t('workspace.info.open')}</WorkbenchButton>}</div>
 {copied&&<p role="status">{t('workspace.info.copied')}</p>}{children}</section>;
}

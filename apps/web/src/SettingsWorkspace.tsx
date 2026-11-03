import React,{useEffect,useRef,useState} from 'react';
import {WorkbenchAlert,WorkbenchBadge,WorkbenchButton} from '@mioon/ui/components/workbench-controls';
import {useI18n} from './i18n/I18nProvider.tsx';
import {readWorkspaceInfo,revealWorkspaceLocation,workspaceToolsBridge} from './workspace-info-client.ts';
import type {WorkspaceInfo} from '../../../packages/contracts/src/workspace-info.ts';
import {readWorkspaceSettings} from './workspace-settings-client.ts';
import type {WorkspaceSettings} from '../../../packages/contracts/src/workspace-configuration.ts';
import './workspace-tools.css';
export default function SettingsWorkspace({active}:{active:boolean}) {
 const {t,formatNumber}=useI18n();
 const [info,setInfo]=useState<WorkspaceInfo|null>(null),[settings,setSettings]=useState<WorkspaceSettings|null>(null),[error,setError]=useState<string|null>(null),[copied,setCopied]=useState(false),[revision,refresh]=useState(0);
 const mounted=useRef(true),visible=useRef(active),readEpoch=useRef(0);
 if(visible.current!==active)readEpoch.current++;visible.current=active;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{
  if(!active)return;let live=true,reading=false;const controller=new AbortController();
  const read=async()=>{if(!live||!visible.current||reading)return;reading=true;const owner=++readEpoch.current;
   try{const values=await Promise.allSettled([readWorkspaceInfo(controller.signal),readWorkspaceSettings(controller.signal)]);if(!live||!visible.current||owner!==readEpoch.current)return;
    if(values[0].status==='fulfilled')setInfo(values[0].value);if(values[1].status==='fulfilled')setSettings(values[1].value);
    const failed=values.find(value=>value.status==='rejected');if(failed?.status==='rejected')setError((failed.reason as {code?:string})?.code??'NETWORK');else setError(null);
   }finally{reading=false;}
  };void read();const timer=setInterval(()=>void read(),5000);return()=>{live=false;controller.abort();clearInterval(timer);};
 },[active,revision]);
 const reportError=(failure:unknown)=>{if(mounted.current)setError((failure as {code?:string})?.code??'NETWORK');};
 return <section className="settings-workspace settings-managed-workspace" data-testid="settings-workspace"><div className="settings-workspace-body">
 {error&&<WorkbenchAlert tone="warning" data-text-selectable>{t(error==='WORKSPACE_SETTINGS_CONFLICT'?'workspace.settings.conflict':'workspace.settings.failed')}</WorkbenchAlert>}
 <dl className="workspace-info-list" data-text-selectable><div><dt>{t('workspace.info.directory')}</dt><dd className="workspace-directory-actions"><input readOnly data-text-selectable aria-label={t('workspace.info.directory')} value={info?.dataDirectory??''}/><WorkbenchButton disabled={!info||!active} onClick={()=>{if(info&&visible.current)void navigator.clipboard.writeText(info.dataDirectory).then(()=>setCopied(true)).catch(reportError);}}>{t('workspace.info.copy')}</WorkbenchButton>{workspaceToolsBridge()&&<WorkbenchButton disabled={!info||!active} onClick={()=>{if(visible.current)void revealWorkspaceLocation().catch(reportError);}}>{t('workspace.info.open')}</WorkbenchButton>}</dd></div><div><dt>{t('workspace.info.usage')}</dt><dd>{info?formatNumber(info.usage.bytes/1_000_000,{style:'unit',unit:'megabyte',unitDisplay:'short',maximumFractionDigits:1}):'—'}</dd></div></dl>
 {info&&!info.usage.complete&&<p>{t('workspace.info.estimate')}</p>}{info&&info.pendingProjectCleanup>0&&<WorkbenchAlert tone="warning" data-text-selectable>{t('workspace.info.cleanupPending',{count:info.pendingProjectCleanup})}</WorkbenchAlert>}
 {copied&&<p role="status">{t('workspace.info.copied')}</p>}
 </div><footer className="settings-page-actions settings-workspace-actions"><WorkbenchBadge dot tone={error?'warning':settings?'success':'neutral'}>{t(error?'workspace.settings.unconfirmed':settings?'workspace.settings.instant':'workspace.settings.reading')}</WorkbenchBadge><WorkbenchButton disabled={!active} onClick={()=>{if(visible.current){readEpoch.current++;setError(null);refresh(value=>value+1);}}}>{t('agent.authorization.refresh')}</WorkbenchButton></footer></section>;
}

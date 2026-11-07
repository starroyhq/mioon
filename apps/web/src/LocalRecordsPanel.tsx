import React, {useEffect, useRef, useSyncExternalStore} from 'react';
import {Dialog} from '@mioon/ui/components/dialog';
import {WorkbenchAlert, WorkbenchBadge, WorkbenchButton, WorkbenchDialogContent} from '@mioon/ui/components/workbench-controls';
import {useI18n} from './i18n/I18nProvider.tsx';
import {createLocalRecordsClient} from './local-records-client.ts';
import {createLocalRecordsController} from './local-records-state.ts';
import type {LocalRecordsState} from './local-records-state.ts';
import {byteSize} from './project-file/format.ts';
import './local-records.css';

export default function LocalRecordsPanel({active, refreshRevision = 0}: {readonly active:boolean; readonly refreshRevision?:number}) {
  const reference = useRef<ReturnType<typeof createLocalRecordsController> | null>(null);
  if (!reference.current) reference.current = createLocalRecordsController(createLocalRecordsClient());
  const controller = reference.current;
  const state = useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  useEffect(() => {controller.activate(active);return () => controller.activate(false);},[controller,active,refreshRevision]);
  return <LocalRecordsView active={active} state={state} controller={controller}/>;
}

export function LocalRecordsView({active,state,controller}:{readonly active:boolean;readonly state:LocalRecordsState;readonly controller:Pick<ReturnType<typeof createLocalRecordsController>,'refresh'|'select'|'cancel'|'confirm'>}) {
  const {t,formatNumber} = useI18n();
  const size = (bytes:number):string => {const value=byteSize(bytes);return t(`projectFile.common.bytes.${value.unit}`,{value:formatNumber(value.value,{maximumFractionDigits:1})});};
  const sum = state.list?.records.reduce((total,item) => total+BigInt(item.sizeBytes),0n) ?? 0n;
  const total = sum <= BigInt(Number.MAX_SAFE_INTEGER) ? size(Number(sum)) : '—';
  const noticeKey = state.notice?.outcomeUnknown ? 'localRecords.unknown' : state.notice?.code === 'DELETED' ? 'localRecords.deleted'
    : state.notice?.code === 'LOCAL_RECORDS_IN_USE' ? 'localRecords.inUse' : state.notice?.code === 'LOCAL_RECORDS_SUPER_JOURNAL' ? 'localRecords.journalHelp'
    : state.notice?.code === 'LOCAL_RECORDS_NOT_FOUND' ? 'localRecords.notFound' : state.notice?.code === 'LOCAL_RECORDS_IDENTITY_CHANGED' ? 'localRecords.identityChanged' : 'localRecords.deleteError';
  return <section className="local-records-panel" aria-labelledby="local-records-heading" data-testid="local-records-panel">
    <header><h2 id="local-records-heading">{t('localRecords.title')}</h2><WorkbenchButton type="button" size="compact" disabled={!active||state.loading||state.deleting} onClick={()=>void controller.refresh()}>{t('localRecords.refresh')}</WorkbenchButton></header>
    <p data-text-selectable>{t('localRecords.help')}</p>
    {state.notice&&<WorkbenchAlert data-testid="local-records-notice" tone={state.notice.code==='DELETED'?'success':'warning'} data-text-selectable>{t(noticeKey)}</WorkbenchAlert>}
    {state.loading&&<p role="status">{t('localRecords.loading')}</p>}
    {state.readError&&<WorkbenchAlert tone="warning" data-text-selectable>{t(state.readError==='LOCAL_RECORDS_SCAN_FAILED'?'localRecords.scanFailed':'localRecords.readError')} <code>{state.readError}</code></WorkbenchAlert>}
    {!state.loading&&!state.readError&&state.list&&(state.list.records.length===0?<p role="status">{t('localRecords.empty')}</p>:<>
      <p className="local-records-summary" data-text-selectable>{t('localRecords.summary',{count:state.list.records.length,size:total})}</p>
      <ul className="local-records-list">{state.list.records.map(item=><li key={item.projectId} data-project-id={item.projectId}>
        <div className="local-records-row"><span className="local-records-file" aria-hidden="true"><svg viewBox="0 0 20 24" fill="none"><path d="M2 1h10l6 6v16H2zM12 1v6h6M5 12h10M5 16h10" stroke="currentColor"/></svg></span>
          <div className="local-records-identity"><strong data-text-selectable>{item.name??t('localRecords.unknownName')}</strong><code data-text-selectable title={item.projectFile??undefined}>{item.projectFile??t('localRecords.noLocation')}</code>
            {(item.hasSuperJournal||item.hasUnfinishedTasks)&&<div className="local-records-badges">{item.hasSuperJournal&&<WorkbenchBadge tone="warning">{t('localRecords.journalTag')}</WorkbenchBadge>}{item.hasUnfinishedTasks&&<WorkbenchBadge tone="warning">{t('localRecords.tasksTag')}</WorkbenchBadge>}</div>}
          </div><span className="local-records-size">{size(item.sizeBytes)}</span><WorkbenchButton type="button" variant="danger-ghost" disabled={!active||state.loading||state.deleting||item.hasSuperJournal||item.hasUnfinishedTasks} aria-label={t('localRecords.confirmTitle',{name:item.name??t('localRecords.unknownName')})} onClick={()=>controller.select(item.projectId)}>{t('localRecords.delete')}</WorkbenchButton>
        </div>
        {item.hasSuperJournal&&<p className="local-records-warning" data-text-selectable>{t('localRecords.journalHelp')}</p>}
        {item.hasUnfinishedTasks&&<p className="local-records-warning" data-text-selectable>{t('localRecords.tasksHelp')}</p>}
      </li>)}</ul>
    </>)}
    <Dialog open={active&&state.selected!==null} onOpenChange={open=>{if(!open)controller.cancel();}}>
      {state.selected&&<WorkbenchDialogContent size="confirm" showCloseButton={!state.deleting} title={t('localRecords.confirmTitle',{name:state.selected.name??t('localRecords.unknownName')})}
        description={t('localRecords.confirmHelp',{size:size(state.selected.sizeBytes)})}
        footer={<><WorkbenchButton type="button" disabled={state.deleting} onClick={()=>controller.cancel()}>{t('localRecords.cancel')}</WorkbenchButton><WorkbenchButton type="button" variant="danger" loading={state.deleting} onClick={()=>void controller.confirm()}>{t('localRecords.delete')}</WorkbenchButton></>}>
          {state.selected.automaticBackups.count>0&&<WorkbenchAlert tone="warning" data-testid="local-records-backup-warning" data-text-selectable>{t('localRecords.backupWarning',{count:state.selected.automaticBackups.count,size:size(state.selected.automaticBackups.sizeBytes)})}</WorkbenchAlert>}
        </WorkbenchDialogContent>}
    </Dialog>
  </section>;
}

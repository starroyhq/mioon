/** Real format-5 previs-editor harness. Mounts the production PrevisEditorHost
 * (which loads the production PrevisEditor chunk) over the real project service
 * through the production format-5 RPC adapter; only the shell around the editor
 * is a fixture. */
import React, {useCallback, useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../../../packages/ui/src/styles/globals.css';
import '../../../apps/web/src/styles.css';
import '../../../apps/web/src/previs/previs.css';
import './fixture.css';
import {DEFAULT_TIMELINE_OUTPUT_PRESET, isPrevisNodeRecord, previsFrame, timelineOutputPreset} from '@mioon/contracts';
import type {PrevisNodeRecord} from '@mioon/contracts';
import {ConfirmationProvider} from '../../../packages/ui/src/components/workbench-confirm.tsx';
import {I18nProvider, createLanguageStore, useI18n} from '../../../apps/web/src/i18n/I18nProvider.tsx';
import PrevisEditorHost from '../../../apps/web/src/previs/PrevisEditorHost.tsx';
import {createPrevisEditorRpc} from '../../../apps/web/src/previs/previs-format5-rpc.ts';
import type {PrevisEditorRpc} from '../../../apps/web/src/previs/previs-format5-rpc.ts';
import {previsSubjectChoices} from '../../../apps/web/src/previs/previs-subject.ts';
import type {PrevisSubjectChoice} from '../../../apps/web/src/previs/previs-subject.ts';

type Row = Record<string, any>;
const projectId = '7a000000-0000-4000-8000-000000000001';
const previsId = '7a000000-0000-4000-8000-000000000003';
const rpc: PrevisEditorRpc = async (operation, input) => {
  const log = (window as any).__previsWireLog as ({operation: string; input: Row; ok?: boolean; code?: string}[] | undefined) ?? [];
  (window as any).__previsWireLog = log;
  const entry: {operation: string; input: Row; ok?: boolean; code?: string} = {operation, input};
  log.push(entry);
  const response = await fetch('/rpc', {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({operation, input})});
  const body = await response.json() as {ok: boolean; data?: any; error?: {code?: string; message?: string; details?: unknown}};
  if (!body.ok) {
    entry.code = body.error?.code ?? 'RPC_FAILED';
    const error = Object.assign(new Error(body.error?.message ?? 'RPC failed'), {
      code: body.error?.code ?? 'RPC_FAILED', details: body.error?.details});
    throw error;
  }
  entry.ok = true;
  return body.data;
};
(window as any).__previsWireRpc = rpc;

function Harness(): React.ReactElement {
  const [data, setData] = useState<Row | null>(null);
  const [subjects, setSubjects] = useState<readonly PrevisSubjectChoice[]>([]);
  const [thumbnails, setThumbnails] = useState<readonly {sceneRevision: number}[]>([]);
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    void (async () => {
      try {
        const project = await rpc('project.get', {projectId}) as Row;
        const list = await rpc('subject.list', {projectId, limit: 20}) as {items?: Row[]};
        setData(project);
        setSubjects(previsSubjectChoices(Object.fromEntries((list.items ?? []).map(subject => [subject.id, subject]))));
      } catch (error) {
        (window as any).__previsWireError = String((error as Error)?.message ?? error);
        console.error('previs fixture load failed', error);
      }
    })();
  }, []);
  const editorRpc = createPrevisEditorRpc({rpc, projectId: () => projectId,
    requestId: () => crypto.randomUUID(), format5: true});
  const onThumbnail = useCallback((_nodeId: string, _framePresetId: string, sceneRevision: number) => {
    setThumbnails(current => [...current, {sceneRevision}]);
  }, []);
  const node: PrevisNodeRecord | undefined = data?.nodes?.find((item: Row) => item.id === previsId);
  const frame = previsFrame(data?.timeline ?? null);
  const framePresetId = timelineOutputPreset(data?.timeline ?? DEFAULT_TIMELINE_OUTPUT_PRESET)?.id ?? null;
  useEffect(() => {
    if (closed) (window as any).__previsWireState = {...(window as any).__previsWireState, closed: true};
  }, [closed]);
  if (!data || !isPrevisNodeRecord(node)) return <div className="previs-fixture-loading">Loading…</div>;
  (window as any).__previsWireState = {ready: true, projectId, previsId, framePresetId,
    subjectId: subjects.length ? (subjects[0] as any).id : null,
    headVersionId: subjects.length ? (subjects[0] as any).headVersionId : null,
    thumbnails: thumbnails.map(item => item.sceneRevision)};
  return <div className="previs-fixture">
    <PrevisEditorHost node={node} projectName="预演无头夹具" frame={frame} framePresetId={framePresetId}
      readOnly={false} thumbnailRevision={thumbnails.at(-1)?.sceneRevision ?? 0} rpc={editorRpc}
      requestId={() => crypto.randomUUID()} onThumbnail={onThumbnail} onClose={() => setClosed(true)}
      shots={[]} edges={[]}
      onImport={async () => ({status: 'failed' as const, code: 'FIXTURE_IMPORT'})}
      onSetFrame={async () => ({status: 'failed' as const})}
      onUndoFrame={async () => ({status: 'failed' as const})}
      subjects={subjects} />
    {closed && <p className="previs-fixture-closed" data-testid="previs-fixture-closed">closed</p>}
  </div>;
}

function Root(): React.ReactElement {
  const {t, renderMessage} = useI18n();
  return <ConfirmationProvider labels={{title: t('common.confirmTitle'), cancel: t('common.cancel'),
    continue: t('common.continue')}} renderMessage={renderMessage}>
    <Harness />
  </ConfirmationProvider>;
}
const store = createLanguageStore({systemLanguages: ['zh-Hans']});
createRoot(document.getElementById('root')!).render(<I18nProvider store={store}><Root/></I18nProvider>);

import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {WorkbenchAlert, WorkbenchButton} from '@mioon/ui/components/workbench-controls';
import {exportFileStatusSchema} from '../../../packages/contracts/src/export-file-recovery.ts';
import type {ExportFileStatus} from '../../../packages/contracts/src/export-file-recovery.ts';
import {useI18n} from './i18n/I18nProvider.tsx';
import {useWorkspaceVisibility} from './workspace-visibility.tsx';

interface Props {projectId: string; exportId: string; downloadHref: string; disabled?: boolean}
interface Owner {projectId: string; exportId: string; url: string; downloadHref: string; disabled: boolean; visible: boolean}
interface Selection {owner: Owner; status: ExportFileStatus; input: HTMLInputElement}

export default function ExportFileActions({projectId, exportId, downloadHref, disabled = false}: Props) {
  const {t} = useI18n(), visible = useWorkspaceVisibility();
  const url = `/api/export-files?projectId=${encodeURIComponent(projectId)}&exportId=${encodeURIComponent(exportId)}`;
  const owner = useMemo<Owner>(() => ({projectId, exportId, url, downloadHref, disabled, visible}), [projectId, exportId, url, downloadHref, disabled, visible]);
  const [observation, setObservation] = useState<{owner: Owner; status: ExportFileStatus} | null>(null);
  const [failure, setFailure] = useState<Owner | null>(null), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const input = useRef<HTMLInputElement>(null), live = useRef<Owner | null>(null), currentStatus = useRef<ExportFileStatus | null>(null);
  const selection = useRef<Selection | null>(null), read = useRef<object | null>(null), flight = useRef<object | null>(null);
  const status = observation?.owner === owner ? observation.status : null;
  const current = () => live.current === owner && owner.visible && !owner.disabled;

  // Commit ownership before passive reads or an operating-system file chooser
  // can deliver a retained callback. Hide/reopen creates a fresh owner, too.
  useLayoutEffect(() => {
    live.current = owner; currentStatus.current = status; selection.current = null;
    setBusy(Boolean(flight.current));
    return () => { if (live.current === owner) {live.current = null; currentStatus.current = null; selection.current = null;} };
  }, [owner, status]);

  async function checked(response: Response, expected?: ExportFileStatus) {
    const raw: unknown = await response.json();
    if (!response.ok || !raw || typeof raw !== 'object' || !('ok' in raw) || raw.ok !== true || !('data' in raw)) throw new Error('File unavailable.');
    const parsed = exportFileStatusSchema.parse(raw.data);
    if (parsed.projectId !== owner.projectId || parsed.exportId !== owner.exportId || expected &&
      (parsed.assetId !== expected.assetId || parsed.sha256 !== expected.sha256 || parsed.sizeBytes !== expected.sizeBytes)) throw new Error('File identity changed.');
    return parsed;
  }
  useEffect(() => {
    if (!current()) return;
    const ticket = {}, abort = new AbortController(); read.current = ticket;
    setObservation(null); setFailure(null);
    void fetch(owner.url, {credentials: 'same-origin', signal: abort.signal}).then(response => checked(response)).then(value => {
      if (current() && read.current === ticket) setObservation({owner, status: value});
    }).catch(() => {if (current() && read.current === ticket) setFailure(owner);});
    return () => {if (read.current === ticket) read.current = null; abort.abort();};
  }, [owner, refresh]);

  function chooseFile() {
    const element = input.current;
    if (!current() || flight.current || !status || status !== currentStatus.current || status.status !== 'missing' || !element) return;
    element.value = ''; selection.current = {owner, status, input: element}; element.click();
  }
  async function recover(file: File, chosen: Selection) {
    if (!current() || chosen.owner !== owner || chosen.status !== currentStatus.current || chosen.input !== input.current || flight.current) return;
    const operation = {}; flight.current = operation; setBusy(true); setFailure(null);
    try {
      if (file.size !== chosen.status.sizeBytes) throw new Error('Size mismatch.');
      // Once dispatched, restoration continues even if its history is hidden.
      // Only a matching visible owner may publish the response into this view.
      const result = await checked(await fetch(owner.url, {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/octet-stream'}, body: file}), chosen.status);
      if (current()) setObservation({owner, status: result});
    } catch {if (current()) setFailure(owner);}
    finally {
      if (flight.current === operation) {
        flight.current = null;
        const latest = live.current;
        if (latest) {
          setBusy(false);
          // A reopened/current scope reconciles through its own read, never
          // through the retired POST's result or immutable download URL.
          if (latest !== owner && latest.visible && !latest.disabled) setRefresh(value => value + 1);
        }
      }
    }
  }
  function fileChanged(event: React.ChangeEvent<HTMLInputElement>) {
    const element = event.currentTarget, chosen = selection.current;
    if (!current() || !chosen || chosen.owner !== owner || chosen.input !== element) return;
    selection.current = null;
    const file = element.files?.[0];
    if (file) void recover(file, chosen);
  }
  const held = busy || Boolean(flight.current);
  if (disabled) return <WorkbenchButton variant="primary" render={<a href={downloadHref} download data-testid="download-export" />}>{t('export.history.download')}</WorkbenchButton>;
  return <div className="export-file-actions" data-testid="export-file-actions">
    {status?.status === 'present' ? <WorkbenchButton variant="primary" render={<a href={downloadHref} download data-testid="download-export" />}>{t('export.history.download')}</WorkbenchButton> : status?.status === 'missing' ? <>
      <span>{t('export.file.missing')}</span><WorkbenchButton disabled={held || !visible} loading={held} onClick={chooseFile} data-testid="export-file-locate">{t('export.file.locate')}</WorkbenchButton>
      <input ref={input} hidden type="file" accept="video/mp4,.mp4" aria-label={t('export.file.locate')} disabled={held || !visible} onChange={fileChanged} /><small>{t('export.file.exact')}</small>
    </> : <WorkbenchButton disabled={held || !visible} onClick={() => {if (current() && !flight.current) setRefresh(value => value + 1);}} data-testid="export-file-check">{t('export.file.check')}</WorkbenchButton>}
    {failure === owner && <WorkbenchAlert tone="warning">{t('export.file.failed')}</WorkbenchAlert>}
  </div>;
}

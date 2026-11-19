/** Right-dock inspector for the real format-5 board: film overview, selected
 * card summary, board version choice, generation subject inputs, subject-card
 * links/deletion and the archive list. All writes are callbacks owned by the
 * workbench's unified RPC session. */
import React, {useState} from 'react';
import {useI18n} from '../i18n/I18nProvider.tsx';
import {BoardFilmOverview} from './BoardFilmComponents.tsx';
import type {BoardLive} from './live.ts';
import type {BoardBinding, BoardMountView} from './live-session.ts';

type Row = Record<string, any>;
export interface BoardInspectorProps {
  readonly board: BoardLive;
  readonly activeFilmId: string | null;
  readonly mount: BoardMountView | null;
  readonly selectedNodeId: string | null;
  readonly versions: readonly Row[];
  readonly shots: readonly Row[];
  readonly busy?: boolean;
  readonly onSelectVersion: (nodeId: string, versionId: string | null) => void;
  readonly onDelete: (nodeId: string) => void;
  readonly onOpenInEditing?: ((nodeId: string) => void) | undefined;
  readonly onRestore: (archivedId: string, name: string) => void;
  readonly onSetBindingMode: (binding: BoardBinding, mode: 'follow' | 'locked', versionId: string | null) => void;
  readonly onDetachBinding: (binding: BoardBinding) => void;
  readonly onRestoreBinding: (binding: BoardBinding) => void;
  readonly onDeleteSubjectCard: (nodeId: string, subjectId: string) => void;
}

interface DeleteRequest {readonly nodeId: string; readonly subjectId: string}

export default function BoardInspector(props: BoardInspectorProps): React.ReactElement {
  const {t, formatNumber} = useI18n();
  const [confirm, setConfirm] = useState<DeleteRequest | null>(null);
  const selected = props.selectedNodeId ? props.board.nodes.find(node => node.id === props.selectedNodeId) ?? null : null;
  const film = props.board.projection.films.find(item => item.id === props.activeFilmId) ?? props.board.projection.films[0] ?? null;
  const shotVersions = selected?.kind === 'shot' ? props.versions.filter(version => version.shotId === selected.id) : [];
  const shot = selected?.kind === 'shot' ? props.shots.find(item => item.id === selected.id) : undefined;
  const archived = props.mount?.archived ?? [];
  const subjects = props.mount?.subjects ?? [];
  const bindings = props.mount?.bindings ?? [];
  const deletable = selected !== null && selected.kind !== 'film' && selected.kind !== 'subject';
  const inSync = props.mount?.inSync ?? true;
  const subject = selected?.kind === 'subject' && selected.subjectId
    ? subjects.find(item => item.id === selected.subjectId) : undefined;
  const shotBindings = selected?.kind === 'shot'
    ? bindings.filter(binding => binding.shotId === selected.id && binding.bindingMode !== 'detached') : [];
  const shotDetached = selected?.kind === 'shot'
    ? bindings.filter(binding => binding.shotId === selected.id && binding.bindingMode === 'detached') : [];
  const subjectBindings = subject ? bindings.filter(binding => binding.subjectId === subject.id) : [];
  const subjectActive = subjectBindings.filter(binding => binding.bindingMode !== 'detached');
  const impact = confirm ? {
    cards: 1,
    bindings: bindings.filter(binding => binding.subjectId === confirm.subjectId).length,
    active: bindings.filter(binding => binding.subjectId === confirm.subjectId && binding.bindingMode !== 'detached').length,
    shots: new Set(bindings.filter(binding => binding.subjectId === confirm.subjectId).map(binding => binding.shotId)).size,
  } : null;
  const bindingRow = (binding: BoardBinding): React.ReactElement => {
    const subjectRow = subjects.find(item => item.id === binding.subjectId);
    const versions = subjectRow?.versions ?? [];
    const locked = binding.bindingMode === 'locked';
    const name = subjectRow?.name ?? binding.subjectId;
    return <li key={binding.id} data-testid={`board-binding-${binding.id}`} className="board-binding-row">
      <div className="board-binding-main"><span className="board-binding-role">{t(binding.role === 'style'
        ? 'boardUi.role.style' : 'boardUi.role.subject')}</span><strong title={name}>{name}</strong></div>
      <div className="board-binding-actions">
        <button type="button" data-testid={`board-binding-follow-${binding.id}`} disabled={props.busy}
          aria-pressed={binding.bindingMode === 'follow'} onClick={() => props.onSetBindingMode(binding, 'follow', null)}>
          {t('boardUi.inspector.follow')}</button>
        {versions.map(version => <button type="button" key={version.id}
          data-testid={`board-binding-lock-${binding.id}-${version.id}`} disabled={props.busy}
          aria-pressed={locked && binding.subjectVersionId === version.id}
          onClick={() => props.onSetBindingMode(binding, 'locked', version.id)}>
          {t('boardUi.inspector.lockVersion', {version: t('boardUi.versionNumber', {number: formatNumber(version.number)})})}
        </button>)}
        <button type="button" data-testid={`board-binding-detach-${binding.id}`} disabled={props.busy}
          onClick={() => props.onDetachBinding(binding)}>{t('boardUi.inspector.detach')}</button>
      </div>
    </li>;
  };
  const confirmDialog = confirm && impact && <div className="board-confirm-backdrop" role="dialog" aria-modal="true"
    aria-label={t('boardUi.delete.cardTitle', {name: subject?.name ?? ''})}
    data-testid="board-delete-confirm">
    <section className="board-confirm-dialog">
      <h3>{t('boardUi.delete.cardTitle', {name: subject?.name ?? ''})}</h3>
      <p data-testid="board-delete-impact">{t('boardUi.delete.impact', impact)}</p>
      <div className="board-confirm-actions">
        <button type="button" data-testid="board-delete-cancel" onClick={() => setConfirm(null)}>{t('boardUi.delete.cancel')}</button>
        <button type="button" data-testid="board-delete-confirm-button" disabled={props.busy}
          onClick={() => { props.onDeleteSubjectCard(confirm.nodeId, confirm.subjectId); setConfirm(null); }}>
          {t('boardUi.delete.confirm')}</button>
      </div>
    </section>
  </div>;
  return <aside className="inspector board-inspector" data-testid="board-inspector" aria-label={t('shell.properties')}>
    {!selected ? <BoardFilmOverview overview={props.board.projection.overview}/>
      : <section className="board-inspector-selection" data-testid="board-inspector-selection">
        <h3>{selected.name}</h3>
        {selected.kind === 'film'
          ? <p>{film ? t('boardUi.aspectDuration', {aspect: film.aspectRatio ?? t('boardUi.aspectUnknown'),
            duration: film.durationFrames === null ? t('boardUi.durationUnknown') : t('boardUi.seconds', {seconds: formatNumber((film.durationFrames ?? 0) / 30, {maximumFractionDigits: 2})})}) : ''}</p>
          : <p data-testid="board-inspector-kind">{t(`boardUi.kind.${selected.kind}`)}</p>}
        {selected.kind === 'shot' && <section data-testid="board-inspector-versions">
          <h4>{t('boardUi.inspector.versions')}</h4>
          <ul>
            {shotVersions.map(version => <li key={version.id}>
              <button type="button" data-testid={`board-inspector-version-${version.id}`} disabled={props.busy}
                aria-pressed={version.id === shot?.selectedVersionId} onClick={() => props.onSelectVersion(selected.id, version.id)}>
                {t('boardUi.versionNumber', {number: formatNumber(version.number ?? 0)})}
              </button>
            </li>)}
            <li><button type="button" data-testid="board-inspector-no-version" disabled={props.busy}
              onClick={() => props.onSelectVersion(selected.id, null)}>{t('boardUi.inspector.noVersion')}</button></li>
          </ul>
        </section>}
        {selected.kind === 'shot' && <section data-testid="board-inspector-inputs">
          <h4>{t('boardUi.inspector.inputs')}</h4>
          {shotBindings.length ? <ul className="board-binding-list">{shotBindings.map(bindingRow)}</ul>
            : <p>{t('boardUi.inspector.noSubjects')}</p>}
          {shotDetached.length ? <section data-testid="board-inspector-detached">
            <h4>{t('boardUi.inspector.detachedBindings')}</h4>
            <ul className="board-binding-list">{shotDetached.map(binding => <li key={binding.id}
              data-testid={`board-binding-detached-${binding.id}`}>
              <span>{subjects.find(item => item.id === binding.subjectId)?.name ?? binding.subjectId}</span>
              <button type="button" data-testid={`board-binding-restore-${binding.id}`} disabled={props.busy}
                onClick={() => props.onRestoreBinding(binding)}>{t('boardUi.inspector.restoreBinding')}</button>
            </li>)}</ul>
          </section> : null}
        </section>}
        {selected.kind === 'subject' && subject && <section data-testid="board-inspector-subject">
          <h4>{t('boardUi.inspector.subjects')}</h4>
          <p>{t(`boardUi.kind.${subject.kind}`)} · {t('boardUi.versionNumber', {number: formatNumber(subject.headNumber)})}</p>
          <section data-testid="board-inspector-linked-shots">
            <h4>{t('boardUi.inspector.linkedShots')}</h4>
            {subjectActive.length ? <ul>{subjectActive.map(binding => {
              const linked = props.shots.find(item => item.id === binding.shotId);
              return <li key={binding.id} data-testid={`board-subject-link-${binding.id}`}>
                <span>{linked?.title ?? binding.shotId}</span>
                <span>{t(binding.bindingMode === 'follow' ? 'boardUi.inspector.follow'
                  : 'boardUi.inspector.lockVersion', {version: t('boardUi.versionNumber', {number:
                    formatNumber(subjects.find(item => item.id === binding.subjectId)?.versions
                      .find(version => version.id === binding.subjectVersionId)?.number ?? 0)})})}</span>
              </li>;
            })}</ul> : <p>{t('boardUi.inspector.noSubjects')}</p>}
          </section>
          <div className="board-danger-actions">
            <button type="button" data-testid="board-inspector-delete-card" disabled={props.busy}
              onClick={() => setConfirm({nodeId: selected.id, subjectId: subject.id})}>
              {t('boardUi.inspector.deleteCard')}</button>
          </div>
        </section>}
        {selected.kind === 'shot' && props.onOpenInEditing &&
          <button type="button" data-testid="board-inspector-open-editing" onClick={() => props.onOpenInEditing!(selected.id)}>
            {t('boardUi.inspector.openInEditing')}</button>}
        <button type="button" data-testid="board-inspector-delete" disabled={props.busy || !deletable}
          onClick={() => { if (deletable) props.onDelete(selected.id); }}>{t('boardUi.deleteNode')}</button>
      </section>}
    <section className="board-inspector-sync" data-testid="board-inspector-sync" data-synced={inSync ? 'true' : 'false'}>
      <span>{t(inSync ? 'boardUi.synced' : 'boardUi.outOfSync')}</span>
      {props.mount && <span>{t('boardUi.inspector.syncRevision', {revision: formatNumber(props.mount.syncRevision)})}</span>}
    </section>
    <section className="board-inspector-archive" data-testid="board-inspector-archive">
      <h4>{t('boardUi.archivedTitle')}</h4>
      {archived.length ? <ul>{archived.map(item => <li key={item.id}>
        <span title={item.name}>{item.name}</span>
        <button type="button" data-testid={`board-inspector-restore-${item.id}`} disabled={props.busy}
          onClick={() => props.onRestore(item.id, item.name)}>{t('boardUi.restoreNode')}</button>
      </li>)}</ul> : <p>{t('boardUi.archiveEmpty')}</p>}
    </section>
    {confirmDialog}
  </aside>;
}

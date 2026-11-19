/** Right-dock inspector for the real format-5 board: film overview, selected
 * card summary, board version choice, delete/open-in-editing and the archive
 * list. All writes are callbacks owned by the workbench's unified RPC session. */
import React from 'react';
import {useI18n} from '../i18n/I18nProvider.tsx';
import {BoardFilmOverview} from './BoardFilmComponents.tsx';
import type {BoardLive} from './live.ts';
import type {BoardMountView} from './live-session.ts';

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
}

export default function BoardInspector(props: BoardInspectorProps): React.ReactElement {
  const {t, formatNumber} = useI18n();
  const selected = props.selectedNodeId ? props.board.nodes.find(node => node.id === props.selectedNodeId) ?? null : null;
  const film = props.board.projection.films.find(item => item.id === props.activeFilmId) ?? props.board.projection.films[0] ?? null;
  const shotVersions = selected?.kind === 'shot' ? props.versions.filter(version => version.shotId === selected.id) : [];
  const shot = selected?.kind === 'shot' ? props.shots.find(item => item.id === selected.id) : undefined;
  const archived = props.mount?.archived ?? [];
  const deletable = selected !== null && selected.kind !== 'film' && selected.kind !== 'subject';
  const inSync = props.mount?.inSync ?? true;
  return <aside className="inspector board-inspector" data-testid="board-inspector" aria-label={t('shell.properties')}>
    {!selected ? <BoardFilmOverview overview={props.board.projection.overview}/>
      : <section className="board-inspector-selection" data-testid="board-inspector-selection">
        <h3>{selected.name}</h3>
        {selected.kind === 'film'
          ? <p>{film ? t('boardUi.aspectDuration', {aspect: film.aspectRatio ?? t('boardUi.aspectUnknown'),
            duration: film.durationFrames === null ? t('boardUi.durationUnknown') : t('boardUi.seconds', {seconds: formatNumber((film.durationFrames ?? 0) / 30, {maximumFractionDigits: 2})})}) : ''}</p>
          : <p data-testid="board-inspector-kind">{t(`boardUi.kind.${selected.kind}`)}</p>}
        {selected.kind === 'subject' && <p>{t('boardUi.inspector.subjectHint')}</p>}
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
  </aside>;
}

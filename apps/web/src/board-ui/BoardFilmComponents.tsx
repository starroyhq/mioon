import React, {useId} from 'react';
import {useI18n} from '../i18n/I18nProvider.tsx';
import type {BoardUiProjection} from './projection.ts';
import './board-ui.css';

type Film = BoardUiProjection['films'][number];
type Overview = BoardUiProjection['overview'];

/** Whole seconds use the compact clock; partial seconds retain the source frame. */
export function boardFrameTime(frames: number): string {
  const seconds = Math.floor(frames / 30);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return frames % 30 ? `${clock}:${String(frames % 30).padStart(2, '0')}` : clock;
}

export function useBoardDuration() {
  const {t, formatNumber} = useI18n();
  return (frames: number | null, compact = false) => frames === null
    ? t('boardUi.durationUnknown')
    : t(compact ? 'boardUi.secondsCompact' : 'boardUi.seconds', {
      seconds: formatNumber(frames / 30, {maximumFractionDigits: 2}),
    });
}

export function BoardFilmOverview({overview}: {overview: Overview}) {
  const {t, formatNumber} = useI18n();
  const rows = [
    ['boardUi.overview.shots', overview.shotCount],
    ['redesign.board.completed', overview.completedCount],
    ['redesign.board.generating', overview.generatingCount],
    ['redesign.board.waiting', overview.pendingCount],
    ['boardUi.overview.floating', overview.floatingCount],
  ] as const;
  return <section className="board-film-overview" data-testid="board-film-overview">
    <h3>{t('redesign.board.overview')}</h3>
    <dl>{rows.map(([key, count]) => <div key={key}><dt>{t(key)}</dt><dd>{formatNumber(count)}</dd></div>)}
      <div><dt>{t('boardUi.overview.duration')}</dt><dd>{overview.durationFrames === null ? t('boardUi.durationUnknown') : boardFrameTime(overview.durationFrames)}</dd></div>
    </dl>
  </section>;
}

export function BoardFloatingLabel() {
  const {t} = useI18n();
  return <span className="board-floating-label" data-testid="board-floating-label">{t('boardUi.floating')}</span>;
}

export function BoardFilmStrip({film, open, onOpenChange, selectedNodeId, onLocateNode, onAddShot, synced = true}: {
  film: Film;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedNodeId?: string | null;
  onLocateNode: (nodeId: string) => void;
  onAddShot: () => void;
  synced?: boolean;
}) {
  const {t, formatNumber} = useI18n();
  const durationLabel = useBoardDuration();
  const listId = useId();
  return <section className="board-film-strip" data-testid="board-film-strip" aria-label={film.name}>
    <header><strong>{film.name}</strong><span>{t('boardUi.shotCount', {count: film.shotCount})}</span><span>·</span>
      <span>{durationLabel(film.durationFrames)}</span><span>·</span><span data-testid="board-film-sync" data-synced={synced ? 'true' : 'false'}>{t(synced ? 'boardUi.synced' : 'boardUi.outOfSync')}</span>
      <button type="button" className="board-strip-toggle" data-testid="board-film-strip-toggle" aria-expanded={open} aria-controls={listId}
        aria-label={t(open ? 'boardUi.collapse' : 'boardUi.expand')} title={t(open ? 'boardUi.collapse' : 'boardUi.expand')} onClick={() => onOpenChange(!open)}>
        <span aria-hidden="true">{open ? '⌄' : '⌃'}</span>
      </button>
    </header>
    <div id={listId} hidden={!open} className="board-film-strip-body">
      {film.items.length ? <ol>{film.items.map((item, index) => <li key={item.nodeId}>
        <button type="button" className={`board-film-thumbnail${selectedNodeId === item.nodeId ? ' is-selected' : ''}`} data-testid={`board-film-item-${item.nodeId}`}
          aria-label={t('boardUi.locate', {name: item.name})} aria-pressed={selectedNodeId === item.nodeId} title={item.name} onClick={() => onLocateNode(item.nodeId)}>
          {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" draggable={false}/> : <span className="board-thumbnail-placeholder" aria-hidden="true">▱</span>}
          <span className="board-film-order">{formatNumber(index + 1, {minimumIntegerDigits: 2})}</span>
          <span className="board-film-duration">{durationLabel(item.durationFrames, true)}</span>
        </button>
      </li>)}</ol> : <p className="board-film-empty">{t('boardUi.empty')}</p>}
      <button type="button" className="board-film-add" data-testid="board-film-add" aria-label={t('redesign.board.addShot')} title={t('redesign.board.addShot')} onClick={onAddShot}>+</button>
    </div>
  </section>;
}

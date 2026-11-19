/** Right-dock inspector for the real format-5 board: film overview, selected
 * card summary, board version choice, delete/open-in-editing, the archive list
 * and (RI-b) the live generation-inputs panel. All writes are callbacks owned by
 * the workbench's unified RPC session. */
import React from 'react';
import type {ChainReferenceRole, ReferenceSourceKind} from '../../../../packages/contracts/src/board-sequence.ts';
import {useI18n} from '../i18n/I18nProvider.tsx';
import {BoardFilmOverview} from './BoardFilmComponents.tsx';
import type {BoardLive} from './live.ts';
import type {BoardMountView} from './live-session.ts';
import type {SequenceGenerationInputEntryView, SequenceGenerationInputView} from './inputs.ts';
import {generationModeKeys, isPrimaryCandidate, referenceRoleKey,
  referenceRoleOptions, sourceKindIcons, unsupportedReasonKey} from './inputs.ts';
import {generationSelection} from '../generation-settings.ts';
import ProviderSettings from '../ProviderSettings.tsx';
import type {ProviderSettingsChange} from '../ProviderSettings.tsx';
import type {GenerationProvider} from '../generation-settings.ts';
import {WorkbenchSelect} from '../WorkspaceControls.tsx';
import Icon from '../icons.tsx';

type Row = Record<string, any>;
export interface BoardGenerationOptions {
  providerId?: string;
  connectionId?: string;
  modelEntryId?: string;
  model?: string;
  [key: string]: unknown;
}
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
  /** RI-b: selected service for this shot plus its live input projection. */
  readonly providers?: readonly GenerationProvider[];
  readonly generationOptions?: BoardGenerationOptions;
  readonly onGenerationOptionsChange?: (shotId: string, options: BoardGenerationOptions) => void;
  readonly inputs?: SequenceGenerationInputView | null;
  readonly onInputRoleChange?: (edgeId: string, shotId: string, role: ChainReferenceRole) => void;
  readonly onInputDetach?: (entry: SequenceGenerationInputEntryView, shotId: string) => void;
  readonly onInputPrimary?: (edgeId: string, shotId: string) => void;
}

function roleSelectValue(entry: SequenceGenerationInputEntryView): ChainReferenceRole {
  return entry.role;
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
  const providers = props.providers ?? [];
  const options = props.generationOptions ?? {};
  const selection = selected?.kind === 'shot'
    ? generationSelection(providers, options as Parameters<typeof generationSelection>[1], shot ?? {})
    : null;
  const inputs = props.inputs ?? null;
  const imageCount = (inputs?.entries ?? []).filter(entry => entry.status === 'used'
    && entry.appliedRole === 'reference_image').length;
  return <aside className="inspector board-inspector" data-testid="board-inspector" aria-label={t('shell.properties')}>
    {!selected ? <BoardFilmOverview overview={props.board.projection.overview}/>
      : <section className="board-inspector-selection" data-testid="board-inspector-selection">
        <h3>{selected.name}</h3>
        {selected.kind === 'film'
          ? <p>{film ? t('boardUi.aspectDuration', {aspect: film.aspectRatio ?? t('boardUi.aspectUnknown'),
            duration: film.durationFrames === null ? t('boardUi.durationUnknown') : t('boardUi.seconds', {seconds: formatNumber((film.durationFrames ?? 0) / 30, {maximumFractionDigits: 2})})}) : ''}</p>
          : <p data-testid="board-inspector-kind">{t(`boardUi.kind.${selected.kind}`)}</p>}
        {selected.kind === 'subject' && <p>{t('boardUi.inspector.subjectHint')}</p>}
        {selected.kind === 'shot' && <section className="board-inspector-inputs" data-testid="board-inspector-inputs">
          <h4>{t('boardUi.inputs.title')}</h4>
          {providers.length > 0 && props.onGenerationOptionsChange && <ProviderSettings providers={providers}
            provider={selection?.provider ?? null} model={selection?.model ?? ''} modelEntryId={selection?.modelEntryId}
            onChange={(change: ProviderSettingsChange) => props.onGenerationOptionsChange?.(selected.id, {...options, ...change})}/>}
          {inputs ? <>
            {inputs.entries.length
              ? <ul className="board-input-list">{inputs.entries.map(entry => {
                const key = entry.edgeId ?? entry.bindingId ?? `${entry.source}-${entry.role}-${entry.orderIndex}`;
                const material = entry.source === 'edge' && entry.edgeId !== undefined && entry.sourceKind !== 'subject';
                const optionsForRole = material ? referenceRoleOptions(entry.sourceKind as ReferenceSourceKind) : [];
                return <li key={key} className={`board-input-row${entry.status === 'unsupported' ? ' is-unsupported' : ''}`}
                  data-testid={`board-input-${key}`} data-status={entry.status}>
                  <span className="board-input-icon" aria-hidden="true"><Icon name={sourceKindIcons[entry.sourceKind]} size={14}/></span>
                  <span className="board-input-role">{t(referenceRoleKey(entry.role) as never)}</span>
                  <span className="board-input-label" title={entry.label}>{entry.label}
                    {entry.subjectVersionNumber !== undefined && t('boardUi.inputs.subjectVersionSuffix' as never, {version: formatNumber(entry.subjectVersionNumber)} as never)}
                    {entry.primary === true && <span className="board-input-primary">{t('boardUi.inputs.primary')}</span>}
                  </span>
                  {material && optionsForRole.length > 1 && <WorkbenchSelect className="board-input-role-select"
                    aria-label={t('boardUi.inputs.changeRole')} data-testid={`board-input-role-${entry.edgeId}`}
                    value={roleSelectValue(entry)} disabled={props.busy}
                    onChange={event => props.onInputRoleChange?.(entry.edgeId!, selected.id, event.target.value as ChainReferenceRole)}>
                    {optionsForRole.map(role => <option key={role} value={role}>{t(referenceRoleKey(role) as never)}</option>)}
                  </WorkbenchSelect>}
                  {entry.status === 'unsupported'
                    ? <span className="board-input-unsupported" data-testid={`board-input-unsupported-${key}`}>
                        {t(unsupportedReasonKey(entry.reason) as never)}</span>
                    : entry.primary !== true && isPrimaryCandidate(entry) && imageCount > 1 && props.onInputPrimary
                      ? <button type="button" className="board-input-action" disabled={props.busy}
                          data-testid={`board-input-primary-${entry.edgeId}`}
                          onClick={() => props.onInputPrimary?.(entry.edgeId!, selected.id)}>
                          {t('boardUi.inputs.setPrimary')}</button>
                      : null}
                  {props.onInputDetach && <button type="button" className="board-input-action" disabled={props.busy}
                    data-testid={`board-input-detach-${key}`} onClick={() => props.onInputDetach?.(entry, selected.id)}>
                    {t('boardUi.inputs.detach')}</button>}
                </li>;
              })}</ul>
              : <p className="board-input-empty" data-testid="board-input-empty">{t('boardUi.inputs.empty')}</p>}
            <footer className="board-input-footer" data-testid="board-input-footer" data-mode={inputs.mode}>
              {inputs.service
                ? [inputs.service.modelName, t(generationModeKeys[inputs.mode] as never),
                  t('boardUi.inputs.used', {count: inputs.usedCount})].join(' · ')
                : t('boardUi.inputs.serviceMissing')}
            </footer>
          </> : <p className="board-input-empty" data-testid="board-input-loading">{t('boardUi.inputs.loading')}</p>}
        </section>}
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

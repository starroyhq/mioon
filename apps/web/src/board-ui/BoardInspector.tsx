/** Right-dock inspector for the real format-5 board: film overview, selected
 * card summary, board version choice, generation subject inputs, subject-card
 * links/deletion and the archive list. All writes are callbacks owned by the
 * workbench's unified RPC session. */
import React, {useEffect, useState} from 'react';
import type {ChainReferenceRole, ReferenceSourceKind} from '../../../../packages/contracts/src/board-sequence.ts';
import {useI18n} from '../i18n/I18nProvider.tsx';
import {providerDisplayName} from '../creation-i18n.ts';
import {generationSelection} from '../generation-settings.ts';
import type {GenerationProvider} from '../generation-settings.ts';
import {BoardFilmOverview} from './BoardFilmComponents.tsx';
import type {BoardLive} from './live.ts';
import type {BoardBinding, BoardMountView} from './live-session.ts';
import type {SequenceGenerationInputEntryView, SequenceGenerationInputView} from './inputs.ts';
import {generationModeKeys, isPrimaryCandidate, referenceRoleKey, referenceRoleOptions, sourceKindIcons,
  unsupportedReasonKey} from './inputs.ts';
import ProviderSettings from '../ProviderSettings.tsx';
import type {ProviderSettingsChange} from '../ProviderSettings.tsx';
import {WorkbenchSelect} from '../WorkspaceControls.tsx';
import Icon from '../icons.tsx';

type Row = Record<string, any>;
/** Minimal per-shot generation selection owned by the workbench. */
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
  readonly nodes: readonly Row[];
  readonly busy?: boolean;
  readonly onSelectVersion: (nodeId: string, versionId: string | null) => void;
  readonly onDelete: (nodeId: string) => void;
  readonly onOpenInEditing?: ((nodeId: string) => void) | undefined;
  readonly onRestore: (archivedId: string, name: string) => void;
  readonly onSetBindingMode: (binding: BoardBinding, mode: 'follow' | 'locked', versionId: string | null) => void;
  readonly onDetachBinding: (binding: BoardBinding) => void;
  readonly onRestoreBinding: (binding: BoardBinding) => void;
  readonly onDeleteSubjectCard: (nodeId: string, subjectId: string) => void;
  readonly onUpdateNode: (nodeId: string, patch: {name?: string; text?: string}, expectedRevision: number) => void;
  /** RI-b: exact generation service of this shot plus its live input projection. */
  readonly providers?: readonly GenerationProvider[];
  readonly generationOptions?: BoardGenerationOptions;
  readonly onGenerationOptionsChange?: (shotId: string, options: BoardGenerationOptions) => void;
  readonly inputs?: SequenceGenerationInputView | null;
  readonly onInputRoleChange?: (edgeId: string, shotId: string, role: ChainReferenceRole) => void;
  readonly onInputDetach?: (entry: SequenceGenerationInputEntryView, shotId: string) => void;
  readonly onInputPrimary?: (edgeId: string, shotId: string) => void;
}

interface DeleteRequest {readonly nodeId: string; readonly subjectId: string}

export default function BoardInspector(props: BoardInspectorProps): React.ReactElement {
  const {t, formatNumber} = useI18n();
  const selected = props.selectedNodeId ? props.board.nodes.find(node => node.id === props.selectedNodeId) ?? null : null;
  const [confirm, setConfirm] = useState<DeleteRequest | null>(null);
  const [nodeName, setNodeName] = useState('');
  const [nodeText, setNodeText] = useState('');
  const editableNode = selected && (selected.kind === 'text' || selected.kind === 'image' || selected.kind === 'video'
    || selected.kind === 'audio' || selected.kind === 'previs') ? selected : null;
  const nodeRow = editableNode ? props.nodes.find(node => node.id === editableNode.id) : undefined;
  const nodeRevision = nodeRow && Number.isSafeInteger(nodeRow.revision) ? Number(nodeRow.revision) : null;
  useEffect(() => {
    if (!editableNode) {setNodeName(''); setNodeText(''); return;}
    setNodeName(editableNode.name);
    setNodeText(String((nodeRow?.text ?? '')));
  }, [editableNode?.id, nodeRow?.revision]);
  const nodeDirty = Boolean(editableNode && nodeRevision !== null
    && (nodeName !== editableNode.name || editableNode.kind === 'text' && nodeText !== String(nodeRow?.text ?? '')));
  const film = props.board.projection.films.find(item => item.id === props.activeFilmId) ?? props.board.projection.films[0] ?? null;
  const shotVersions = selected?.kind === 'shot' ? props.versions.filter(version => version.shotId === selected.id) : [];
  const shot = selected?.kind === 'shot' ? props.shots.find(item => item.id === selected.id) : undefined;
  const archived = props.mount?.archived ?? [];
  const subjects = props.mount?.subjects ?? [];
  const bindings = props.mount?.bindings ?? [];
  const deletable = selected !== null && selected.kind !== 'film' && selected.kind !== 'subject';
  const inSync = props.mount?.inSync ?? true;
  const generationProviders = props.providers ?? [];
  const generationOptions = props.generationOptions ?? {};
  const generation = selected?.kind === 'shot'
    ? generationSelection(generationProviders, generationOptions as Parameters<typeof generationSelection>[1], shot ?? {})
    : null;
  const inputs = props.inputs ?? null;
  const hasService = Boolean(inputs?.service);
  const serviceLabel = hasService
    ? (generation?.provider ? providerDisplayName(generation.provider, t) : inputs?.service?.providerId ?? '')
    : '';
  const imageCount = (inputs?.entries ?? []).filter(entry => entry.status === 'used'
    && entry.appliedRole === 'reference_image').length;
  const inputRow = (entry: SequenceGenerationInputEntryView): React.ReactElement => {
    const key = entry.edgeId ?? entry.bindingId ?? `${entry.source}-${entry.role}-${entry.orderIndex}`;
    const material = entry.source === 'edge' && entry.edgeId !== undefined && entry.sourceKind !== 'subject';
    const roleOptions = material ? referenceRoleOptions(entry.sourceKind as ReferenceSourceKind) : [];
    const unsupported = hasService && entry.status === 'unsupported';
    return <li key={key} className={`board-input-row${unsupported ? ' is-unsupported' : ''}`}
      data-testid={`board-input-${key}`} data-status={hasService ? entry.status : 'unknown'}>
      <span className="board-input-icon" aria-hidden="true"><Icon name={sourceKindIcons[entry.sourceKind]} size={14}/></span>
      <span className="board-input-role">{t(referenceRoleKey(entry.role) as never)}</span>
      <span className="board-input-label" title={entry.label}>{entry.label}
        {entry.subjectVersionNumber !== undefined && t('boardUi.inputs.subjectVersionSuffix' as never,
          {version: formatNumber(entry.subjectVersionNumber)} as never)}
        {entry.primary === true && <span className="board-input-primary">{t('boardUi.inputs.primary')}</span>}
      </span>
      {unsupported && <span className="board-input-unsupported" data-testid={`board-input-unsupported-${key}`}>
        {t(unsupportedReasonKey(entry.reason) as never)}</span>}
      <span className="board-input-actions">
        {material && roleOptions.length > 1 && <WorkbenchSelect className="board-input-role-select"
          aria-label={t('boardUi.inputs.changeRole')} data-testid={`board-input-role-${entry.edgeId}`}
          value={entry.role} disabled={props.busy}
          onChange={event => props.onInputRoleChange?.(entry.edgeId!, selected!.id, event.target.value as ChainReferenceRole)}>
          {roleOptions.map(role => <option key={role} value={role}>{t(referenceRoleKey(role) as never)}</option>)}
        </WorkbenchSelect>}
        {!unsupported && entry.primary !== true && isPrimaryCandidate(entry) && imageCount > 1 && props.onInputPrimary
          && <button type="button" className="board-input-action" disabled={props.busy}
              data-testid={`board-input-primary-${entry.edgeId}`}
              onClick={() => props.onInputPrimary?.(entry.edgeId!, selected!.id)}>
              {t('boardUi.inputs.setPrimary')}</button>}
        {props.onInputDetach && <button type="button" className="board-input-action" disabled={props.busy}
          data-testid={`board-input-detach-${key}`} onClick={() => props.onInputDetach?.(entry, selected!.id)}>
          {t('boardUi.inputs.detach')}</button>}
      </span>
    </li>;
  };
  const generationPanel = selected?.kind === 'shot' ? <section className="board-inspector-generation-inputs"
    data-testid="board-inspector-generation-inputs">
    <h4>{t('boardUi.inputs.title')}</h4>
    {generationProviders.length > 0 && props.onGenerationOptionsChange && <ProviderSettings
      providers={generationProviders} provider={generation?.provider ?? null} model={generation?.model ?? ''}
      modelEntryId={generation?.modelEntryId}
      onChange={(change: ProviderSettingsChange) => props.onGenerationOptionsChange?.(selected.id, {...generationOptions, ...change})}/>}
    {inputs ? <>
      {inputs.entries.length
        ? <ul className="board-input-list">{inputs.entries.map(inputRow)}</ul>
        : <p className="board-input-empty" data-testid="board-input-empty">{t('boardUi.inputs.empty')}</p>}
      <footer className="board-input-footer" data-testid="board-input-footer" data-mode={inputs.mode}
        data-service={hasService ? 'selected' : 'missing'}>
        {hasService
          ? [serviceLabel, t(generationModeKeys[inputs.mode] as never),
              ...(inputs.usedCount > 0 ? [t('boardUi.inputs.used', {count: inputs.usedCount})] : [])].join(' · ')
          : t('boardUi.inputs.serviceMissing')}
      </footer>
    </> : <p className="board-input-empty" data-testid="board-input-loading">{t('boardUi.inputs.loading')}</p>}
  </section> : null;
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
        {editableNode && <section data-testid="board-inspector-node-edit" className="board-inspector-node-edit">
          <h4>{t('inspector.nodeName')}</h4>
          <input aria-label={t('inspector.nodeName')} data-testid="board-node-name" maxLength={150}
            value={nodeName} disabled={props.busy || nodeRevision === null}
            onChange={event => setNodeName(event.target.value)}/>
          {editableNode.kind === 'text' && <>
            <h4>{t('inspector.textContent')}</h4>
            <textarea aria-label={t('inspector.textContent')} data-testid="board-node-text" rows={6} maxLength={5000}
              value={nodeText} disabled={props.busy || nodeRevision === null}
              onChange={event => setNodeText(event.target.value)}/>
          </>}
          <button type="button" data-testid="board-node-save" disabled={!nodeDirty || props.busy || nodeRevision === null}
            onClick={() => {
              if (!editableNode || nodeRevision === null || !nodeDirty) return;
              props.onUpdateNode(editableNode.id, {name: nodeName.trim() || editableNode.name,
                ...(editableNode.kind === 'text' ? {text: nodeText} : {})}, nodeRevision);
            }}>{t('inspector.saveNode')}</button>
        </section>}
        {selected.kind === 'shot' && generationPanel}
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
          <h4>{t('boardUi.inspector.subjectReferences')}</h4>
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

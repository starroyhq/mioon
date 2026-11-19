/** Right-dock inspector for the real format-5 board.
 *
 * GP: a selected shot follows 21-10 — properties/versions tabs are owned by the
 * right dock header; the properties page edits title, description and duration
 * through `board.shot.update`, shows RI-b generation inputs with one click menu
 * per row (21-10b), read-only dialogue lines and the generate action. Board sync
 * status and the archive list are only shown when nothing is selected. Other
 * selections keep the UI-B2/SB/FR-C editors.
 */
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
  /** The right dock header tab for the canvas workspace. */
  readonly activeTab?: 'settings' | 'versions';
  /** Dialogue lines read from subtitle cues linked to the selected shot (DL). */
  readonly dialogueLines?: readonly string[];
  readonly onSelectVersion: (nodeId: string, versionId: string | null) => void;
  readonly onDelete: (nodeId: string) => void;
  readonly onOpenInEditing?: ((nodeId: string) => void) | undefined;
  readonly onRestore: (archivedId: string, name: string) => void;
  readonly onSetBindingMode: (binding: BoardBinding, mode: 'follow' | 'locked', versionId: string | null) => void;
  readonly onDetachBinding: (binding: BoardBinding) => void;
  readonly onRestoreBinding: (binding: BoardBinding) => void;
  readonly onDeleteSubjectCard: (nodeId: string, subjectId: string) => void;
  readonly onUpdateNode: (nodeId: string, patch: {name?: string; text?: string}, expectedRevision: number) => void;
  /** FR-C shot update; the panel keeps the draft and surfaces a revision conflict. */
  readonly onUpdateShot?: (shotId: string, patch: {title?: string; prompt?: string; duration?: number},
    expectedRevision: number) => Promise<{readonly ok: boolean; readonly code?: string}>;
  readonly onGenerateShot?: (shotId: string) => void;
  readonly providers?: readonly GenerationProvider[];
  readonly generationOptions?: BoardGenerationOptions;
  readonly onGenerationOptionsChange?: (shotId: string, options: BoardGenerationOptions) => void;
  readonly inputs?: SequenceGenerationInputView | null;
  readonly onInputRoleChange?: (edgeId: string, shotId: string, role: ChainReferenceRole) => void;
  readonly onInputDetach?: (entry: SequenceGenerationInputEntryView, shotId: string) => void;
  readonly onInputPrimary?: (edgeId: string, shotId: string) => void;
}

interface DeleteRequest {readonly nodeId: string; readonly subjectId: string}
interface InputMenu {readonly key: string; readonly entry: SequenceGenerationInputEntryView}

export default function BoardInspector(props: BoardInspectorProps): React.ReactElement {
  const {t, formatNumber} = useI18n();
  const selected = props.selectedNodeId ? props.board.nodes.find(node => node.id === props.selectedNodeId) ?? null : null;
  const [confirm, setConfirm] = useState<DeleteRequest | null>(null);
  const [inputMenu, setInputMenu] = useState<InputMenu | null>(null);
  const [nodeName, setNodeName] = useState('');
  const [nodeText, setNodeText] = useState('');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [duration, setDuration] = useState(4);
  const [shotError, setShotError] = useState('');
  const [shotSaved, setShotSaved] = useState(false);
  const editableNode = selected && (selected.kind === 'text' || selected.kind === 'image' || selected.kind === 'video'
    || selected.kind === 'audio' || selected.kind === 'previs') ? selected : null;
  const nodeRow = editableNode ? props.nodes.find(node => node.id === editableNode.id) : undefined;
  const nodeRevision = nodeRow && Number.isSafeInteger(nodeRow.revision) ? Number(nodeRow.revision) : null;
  const shot = selected?.kind === 'shot' ? props.shots.find(item => item.id === selected.id) : undefined;
  const shotRevision = shot && Number.isSafeInteger(shot.revision) ? Number(shot.revision) : null;
  useEffect(() => {
    if (!editableNode) {setNodeName(''); setNodeText(''); return;}
    setNodeName(editableNode.name);
    setNodeText(String((nodeRow?.text ?? '')));
  }, [editableNode?.id, nodeRow?.revision]);
  useEffect(() => {
    setInputMenu(null);
    if (!shot) {setTitle(''); setPrompt(''); setDuration(4); setShotError(''); setShotSaved(false); return;}
    setTitle(String(shot.title ?? ''));
    setPrompt(String(shot.prompt ?? ''));
    setDuration(Number.isSafeInteger(shot.duration) ? Number(shot.duration) : 4);
    setShotError(''); setShotSaved(false);
  }, [shot?.id]);
  const nodeDirty = Boolean(editableNode && nodeRevision !== null
    && (nodeName !== editableNode.name || editableNode.kind === 'text' && nodeText !== String(nodeRow?.text ?? '')));
  const shotDirty = Boolean(shot && (title !== String(shot.title ?? '') || prompt !== String(shot.prompt ?? '')
    || duration !== Number(shot.duration ?? 4)));
  const film = props.board.projection.films.find(item => item.id === props.activeFilmId) ?? props.board.projection.films[0] ?? null;
  const shotVersions = selected?.kind === 'shot' ? props.versions.filter(version => version.shotId === selected.id) : [];
  const archived = props.mount?.archived ?? [];
  const subjects = props.mount?.subjects ?? [];
  const bindings = props.mount?.bindings ?? [];
  const deletable = selected !== null && selected.kind !== 'film' && selected.kind !== 'subject' && selected.kind !== 'shot';
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
  const shotBindings = selected?.kind === 'shot'
    ? bindings.filter(binding => binding.shotId === selected.id && binding.bindingMode !== 'detached') : [];
  const shotDetached = selected?.kind === 'shot'
    ? bindings.filter(binding => binding.shotId === selected.id && binding.bindingMode === 'detached') : [];
  const entryKey = (entry: SequenceGenerationInputEntryView): string =>
    entry.edgeId ?? entry.bindingId ?? `${entry.source}-${entry.role}-${entry.orderIndex}`;
  const openInputMenu = (event: React.MouseEvent, entry: SequenceGenerationInputEntryView): void => {
    event.stopPropagation();
    setInputMenu(current => current?.key === entryKey(entry) ? null : {key: entryKey(entry), entry});
  };
  const inputRow = (entry: SequenceGenerationInputEntryView): React.ReactElement => {
    const key = entryKey(entry);
    const material = entry.source === 'edge' && entry.edgeId !== undefined && entry.sourceKind !== 'subject';
    const roleOptions = material ? referenceRoleOptions(entry.sourceKind as ReferenceSourceKind) : [];
    const unsupported = hasService && entry.status === 'unsupported';
    const open = inputMenu?.key === key;
    return <li key={key} className={`board-input-row${unsupported ? ' is-unsupported' : ''}${open ? ' is-open' : ''}`}
      data-testid={`board-input-${key}`} data-status={hasService ? entry.status : 'unknown'}>
      <button type="button" className="board-input-button" disabled={props.busy}
        aria-expanded={open} onClick={event => openInputMenu(event, entry)}>
        <span className="board-input-icon" aria-hidden="true"><Icon name={sourceKindIcons[entry.sourceKind]} size={14}/></span>
        <span className="board-input-role">{t(referenceRoleKey(entry.role) as never)}</span>
        <span className="board-input-label" title={entry.label}>{entry.label}
          {entry.subjectVersionNumber !== undefined && t('boardUi.inputs.subjectVersionSuffix' as never,
            {version: formatNumber(entry.subjectVersionNumber)} as never)}
          {entry.primary === true && <span className="board-input-primary">{t('boardUi.inputs.primary')}</span>}
        </span>
        {unsupported && <span className="board-input-unsupported" data-testid={`board-input-unsupported-${key}`}>
          {t(unsupportedReasonKey(entry.reason) as never)}</span>}
      </button>
      {open && <div className="board-input-menu" role="menu" data-testid={`board-input-menu-${key}`}
        onMouseLeave={() => setInputMenu(null)}>
        {material && roleOptions.map(role => <button type="button" key={role} role="menuitemradio"
          aria-checked={entry.role === role} disabled={props.busy}
          data-testid={`board-input-role-${key}-${role}`}
          onClick={() => {setInputMenu(null); props.onInputRoleChange?.(entry.edgeId!, selected!.id, role);}}>
          {t(referenceRoleKey(role) as never)}
          {entry.role === role && <Icon name="check" size={12}/>}
        </button>)}
        {entry.source === 'subject' && entry.bindingId && <>
          <button type="button" role="menuitem" disabled={props.busy} data-testid={`board-input-follow-${key}`}
            onClick={() => {setInputMenu(null); const binding = shotBindings.find(item => item.id === entry.bindingId);
              if (binding) props.onSetBindingMode(binding, 'follow', null);}}>{t('boardUi.inspector.follow')}</button>
          {(subjects.find(subject => subject.id === shotBindings.find(binding => binding.id === entry.bindingId)?.subjectId)?.versions ?? []).map(version =>
            <button type="button" key={version.id} role="menuitem" disabled={props.busy}
              data-testid={`board-input-lock-${key}-${version.id}`}
              onClick={() => {setInputMenu(null); const binding = shotBindings.find(item => item.id === entry.bindingId);
                if (binding) props.onSetBindingMode(binding, 'locked', version.id);}}>
              {t('boardUi.inspector.lockVersion', {version: t('boardUi.versionNumber', {number: formatNumber(version.number)})})}
            </button>)}
        </>}
        {!unsupported && entry.primary !== true && isPrimaryCandidate(entry) && imageCount > 1 && props.onInputPrimary
          && <button type="button" role="menuitem" disabled={props.busy} data-testid={`board-input-primary-${key}`}
            onClick={() => {setInputMenu(null); props.onInputPrimary?.(entry.edgeId!, selected!.id);}}>
            <Icon name="sparkle" size={12}/>{t('boardUi.inputs.setPrimary')}</button>}
        {props.onInputDetach && <button type="button" role="menuitem" disabled={props.busy}
          data-testid={`board-input-detach-${key}`}
          onClick={() => {setInputMenu(null); props.onInputDetach?.(entry, selected!.id);}}>
          <Icon name="link" size={12}/>{t('boardUi.inputs.detach')}</button>}
      </div>}
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
      {shotDetached.length > 0 && <section className="board-detached-inputs" data-testid="board-detached-inputs">
        {shotDetached.map(binding => <div key={binding.id} className="board-input-row is-detached"
          data-testid={`board-input-detached-${binding.id}`}>
          <span className="board-input-icon"><Icon name="sparkle" size={14}/></span>
          <span className="board-input-role">{t(binding.role === 'style' ? 'boardUi.role.style' : 'boardUi.role.subject')}</span>
          <span className="board-input-label">{subjects.find(subject => subject.id === binding.subjectId)?.name ?? binding.subjectId}</span>
          <button type="button" className="board-input-action" disabled={props.busy}
            data-testid={`board-input-restore-${binding.id}`}
            onClick={() => props.onRestoreBinding(binding)}>{t('boardUi.inspector.restoreBinding')}</button>
        </div>)}
      </section>}
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
  const subjectBindings = subject ? bindings.filter(binding => binding.subjectId === subject.id) : [];
  const subjectActive = subjectBindings.filter(binding => binding.bindingMode !== 'detached');
  const impact = confirm ? {
    cards: 1,
    bindings: bindings.filter(binding => binding.subjectId === confirm.subjectId).length,
    active: bindings.filter(binding => binding.subjectId === confirm.subjectId && binding.bindingMode !== 'detached').length,
    shots: new Set(bindings.filter(binding => binding.subjectId === confirm.subjectId).map(binding => binding.shotId)).size,
  } : null;
  const confirmDialog = confirm && impact && <div className="board-confirm-backdrop" role="dialog" aria-modal="true"
    aria-label={t('boardUi.delete.cardTitle', {name: subject?.name ?? ''})} data-testid="board-delete-confirm">
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
  const saveShot = async (): Promise<void> => {
    if (!shot || shotRevision === null || !shotDirty || !props.onUpdateShot) return;
    const result = await props.onUpdateShot(shot.id, {title: title.trim() || String(shot.title ?? ''),
      prompt, duration}, shotRevision);
    if (result.ok) {setShotError(''); setShotSaved(true);} else if (result.code) setShotError(result.code);
  };
  const shotTitleRow = selected?.kind === 'shot' && <div className="board-shot-title-row">
    <h3 data-testid="board-inspector-shot-title">{shot?.title ?? selected.name}</h3>
    {props.onOpenInEditing && <button type="button" className="board-shot-open-editing"
      data-testid="board-inspector-open-editing" onClick={() => props.onOpenInEditing!(selected.id)}>
      {t('boardUi.inspector.openInEditing')}</button>}
  </div>;
  const shotProperties = selected?.kind === 'shot' ? <>
    <section className="board-shot-fields" data-testid="board-shot-fields">
      <label>{t('boardUi.inspector.shotTitle')}<input data-testid="board-shot-title" maxLength={150}
        value={title} disabled={props.busy || shotRevision === null}
        onChange={event => {setTitle(event.target.value); setShotSaved(false);}}/></label>
      <label>{t('boardUi.inspector.description')}
        <textarea data-testid="board-shot-prompt" rows={4} maxLength={5000} value={prompt}
          disabled={props.busy || shotRevision === null} placeholder={t('boardUi.inspector.descriptionPlaceholder')}
          onChange={event => {setPrompt(event.target.value); setShotSaved(false);}}/>
        <span className="board-shot-count" data-testid="board-shot-prompt-count">{formatNumber(prompt.length)} / 5000</span>
      </label>
      {(shotDirty || shotSaved || shotError) && <div className="board-shot-save" data-testid="board-shot-save-row">
        <button type="button" data-testid="board-shot-save" disabled={!shotDirty || props.busy}
          onClick={() => {void saveShot();}}>{t('boardUi.inspector.saveShot')}</button>
        <button type="button" data-testid="board-shot-discard" disabled={!shotDirty || props.busy}
          onClick={() => {if (!shot) return; setTitle(String(shot.title ?? '')); setPrompt(String(shot.prompt ?? ''));
            setDuration(Number(shot.duration ?? 4)); setShotError(''); setShotSaved(false);}}>{t('common.cancel')}</button>
        {shotSaved && <span role="status">{t('boardUi.inspector.saved')}</span>}
        {shotError && <span role="alert" data-testid="board-shot-error">{t(shotError.includes('REVISION_CONFLICT')
          ? 'boardUi.inspector.shotConflict' : 'boardUi.inspector.shotSaveFailed')}</span>}
      </div>}
      <label className="board-shot-duration">{t('boardUi.inspector.duration')}
        <WorkbenchSelect data-testid="board-shot-duration" value={String(duration)}
          disabled={props.busy || shotRevision === null}
          onChange={event => {setDuration(Number(event.target.value)); setShotSaved(false);}}>
          {Array.from({length: 20}, (_, index) => index + 1).map(seconds =>
            <option key={seconds} value={seconds}>{t('boardUi.inspector.durationSeconds', {seconds})}</option>)}
        </WorkbenchSelect>
      </label>
    </section>
    {generationPanel}
    <section className="board-shota-dialogue" data-testid="board-inspector-dialogue">
      <h4>{t('boardUi.inspector.dialogue')}</h4>
      {props.dialogueLines?.length
        ? <ul>{props.dialogueLines.map((line, index) => <li key={`${index}:${line}`} data-testid="board-dialogue-line">{line}</li>)}</ul>
        : <p data-testid="board-dialogue-empty">{t('boardUi.inspector.dialogueEmpty')}</p>}
    </section>
    <button type="button" className="board-shot-generate" data-testid="board-inspector-generate"
      disabled={props.busy || !hasService || !props.onGenerateShot}
      onClick={() => { if (shot) props.onGenerateShot?.(shot.id); }}>
      <Icon name="sparkle" size={15}/>{t('boardUi.inspector.generate')}
    </button>
  </> : null;
  return <aside className="inspector board-inspector" data-testid="board-inspector" aria-label={t('shell.properties')}>
    {!selected ? <>
      <BoardFilmOverview overview={props.board.projection.overview}/>
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
    </> : selected.kind === 'shot' ? <section className="board-inspector-selection" data-testid="board-inspector-selection">
      {shotTitleRow}
      {props.activeTab === 'versions' ? <section data-testid="board-inspector-versions">
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
      </section> : shotProperties}
    </section> : <section className="board-inspector-selection" data-testid="board-inspector-selection">
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
      <button type="button" data-testid="board-inspector-delete" disabled={props.busy || !deletable}
        onClick={() => { if (deletable) props.onDelete(selected.id); }}>{t('boardUi.deleteNode')}</button>
    </section>}
    {confirmDialog}
  </aside>;
}

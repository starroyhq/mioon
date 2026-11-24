/** Right-dock inspector for the real format-5 board.
 *
 * GP: a selected shot follows 21-10 — properties/versions tabs are owned by the
 * right dock header; the properties page edits title, description and duration
 * through `board.shot.update`, shows RI-b generation inputs with one click menu
 * per row (21-10b), read-only dialogue lines and the generate action. Board sync
 * status and the archive list are only shown when nothing is selected. Other
 * selections keep the UI-B2/SB/FR-C editors.
 */
import React, {useEffect, useRef, useState} from 'react';
import type {ChainReferenceRole, ReferenceSourceKind} from '../../../../packages/contracts/src/board-sequence.ts';
import {useI18n} from '../i18n/I18nProvider.tsx';
import {providerDisplayName, generationFailureDescriptor} from '../creation-i18n.ts';
import {generationSelection} from '../generation-settings.ts';
import type {GenerationProvider} from '../generation-settings.ts';
import {BoardFilmOverview} from './BoardFilmComponents.tsx';
import type {BoardLive} from './live.ts';
import type {BoardBinding, BoardMountView} from './live-session.ts';
import type {SequenceGenerationInputEntryView, SequenceGenerationInputView} from './inputs.ts';
import {generationModeKeys, isPrimaryCandidate, referenceRoleKey, referenceRoleOptions, sourceKindIcons,
  unsupportedReasonKey} from './inputs.ts';
import ShotDialogue from '../ShotDialogue.tsx';
import GenerationServiceMenu from '../GenerationServiceMenu.tsx';
import {reconcileShotDraft} from './shot-draft.ts';
import type {ShotDraftState} from './shot-draft.ts';
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
  /** DL-a dialogue panel inputs; the panel owns add/update/remove and cue status. */
  readonly dialogueSubjects?: Readonly<Record<string, string>>;
  readonly dialogueCueCount?: number;
  readonly onDialogueApplied?: () => unknown;
  readonly rpc?: (operation: string, input: unknown) => Promise<unknown>;
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
  /** Generation jobs for this project; the selected shot's running/failed job
   * owns the board-side cancel and retry entries. */
  readonly jobs?: readonly Row[];
  readonly onCancelJob?: (job: Row) => unknown;
  readonly onRetryJob?: (job: Row) => unknown;
  readonly onOpenTaskCenter?: (jobId: string) => unknown;
  readonly providers?: readonly GenerationProvider[];
  readonly generationOptions?: BoardGenerationOptions;
  /** Opens Generation services settings from the no-available-service menu. */
  readonly onOpenGenerationSettings?: (() => void) | undefined;
  readonly onGenerationOptionsChange?: (shotId: string, options: BoardGenerationOptions) => void;
  readonly inputs?: SequenceGenerationInputView | null;
  /** Format-5 previs selection: reuse the same PrevisInspector as formats 3/4
   * instead of the generic node card, so its keyframes and open entry are shown. */
  readonly previsInspector?: React.ReactNode;
  readonly onInputRoleChange?: (edgeId: string, shotId: string, role: ChainReferenceRole) => void;
  readonly onInputDetach?: (entry: SequenceGenerationInputEntryView, shotId: string) => void;
  readonly onInputPrimary?: (edgeId: string, shotId: string) => void;
}

interface DeleteRequest {readonly nodeId: string; readonly subjectId: string}
interface InputMenu {readonly key: string; readonly entry: SequenceGenerationInputEntryView}

export default function BoardInspector(props: BoardInspectorProps): React.ReactElement {
  const {t, formatNumber, renderMessage} = useI18n();
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
  const [titleEditing, setTitleEditing] = useState(false);
  const [serviceMenu, setServiceMenu] = useState(false);
  const [jobAction, setJobAction] = useState<string | null>(null);
  const draftRevision = useRef<number | null>(null);
  const lastShotId = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const editableNode = selected && (selected.kind === 'text' || selected.kind === 'image' || selected.kind === 'video'
    || selected.kind === 'audio' || selected.kind === 'previs') ? selected : null;
  const nodeRow = editableNode ? props.nodes.find(node => node.id === editableNode.id) : undefined;
  const nodeRevision = nodeRow && Number.isSafeInteger(nodeRow.revision) ? Number(nodeRow.revision) : null;
  const shot = selected?.kind === 'shot' ? props.shots.find(item => item.id === selected.id) : undefined;
  const shotRevision = shot && Number.isSafeInteger(shot.revision) ? Number(shot.revision) : null;
  const filmShotIds = (props.board.projection.films.find(film => film.id === props.activeFilmId)
    ?? props.board.projection.films[0])?.items.filter(item => item.kind === 'shot').map(item => item.nodeId) ?? [];
  const shotIndex = shot ? (filmShotIds.includes(shot.id) ? filmShotIds.indexOf(shot.id) : props.shots.findIndex(item => item.id === shot.id)) : -1;
  const shotNumber = shotIndex >= 0 ? String(shotIndex + 1).padStart(2, '0') : null;
  const isActiveJob = (job: Row): boolean => ['queued', 'submitting', 'running', 'downloading'].includes(String(job.status));
  const shotJobs = shot ? (props.jobs ?? []).filter(job => job.shotId === shot.id)
    .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? ''))) : [];
  // 21-10c: only the newest generation owns the bottom state. A successful
  // retry or a newer generation replaces the old failure/unknown entry.
  const latestJob = shotJobs[0] ?? null;
  const runningJob = latestJob && isActiveJob(latestJob) ? latestJob : null;
  const failedJob = latestJob?.status === 'failed' ? latestJob : null;
  const unknownJob = latestJob?.status === 'submission_unknown' ? latestJob : null;
  const jobServiceName = (job: Row): string => providerDisplayName(
    props.providers?.find(provider => provider.id === job.providerId) ?? {id: String(job.providerId ?? '')}, t);
  const retryPending = Boolean(failedJob && shotJobs.some(job => job.retryOfJobId === failedJob.id
    && (isActiveJob(job) || job.status === 'submission_unknown')));
  const cancelGeneration = async (job: Row): Promise<void> => {
    if (!props.onCancelJob || jobAction !== null) return;
    setJobAction(`cancel:${job.id}`);
    try { await props.onCancelJob(job); } finally { setJobAction(null); }
  };
  const retryGeneration = async (job: Row): Promise<void> => {
    if (!props.onRetryJob || jobAction !== null || retryPending) return;
    setJobAction(`retry:${job.id}`);
    try { await props.onRetryJob(job); } finally { setJobAction(null); }
  };
  useEffect(() => {
    if (!editableNode) {setNodeName(''); setNodeText(''); return;}
    setNodeName(editableNode.name);
    setNodeText(String((nodeRow?.text ?? '')));
  }, [editableNode?.id, nodeRow?.revision]);
  useEffect(() => {
    setInputMenu(null); setServiceMenu(false); setTitleEditing(false);
    if (!shot || shotRevision === null) {setTitle(''); setPrompt(''); setDuration(4); setShotError(''); setShotSaved(false);
      draftRevision.current = null; lastShotId.current = null; return;}
    const previous: ShotDraftState | null = lastShotId.current === null ? null : {
      shotId: lastShotId.current, revision: draftRevision.current,
      values: {title, prompt, duration}, dirty: dirtyRef.current};
    const next = reconcileShotDraft(previous, {id: shot.id, revision: shotRevision,
      title: shot.title, prompt: shot.prompt, duration: shot.duration});
    if (next.values.title !== title) setTitle(next.values.title);
    if (next.values.prompt !== prompt) setPrompt(next.values.prompt);
    if (next.values.duration !== duration) setDuration(next.values.duration);
    if (next.revision !== draftRevision.current || next.values.title !== title || next.values.prompt !== prompt
      || next.values.duration !== duration) {setShotError(''); setShotSaved(false);}
    draftRevision.current = next.revision;
    lastShotId.current = next.shotId;
  }, [shot?.id, shotRevision]);
  const nodeDirty = Boolean(editableNode && nodeRevision !== null
    && (nodeName !== editableNode.name || editableNode.kind === 'text' && nodeText !== String(nodeRow?.text ?? '')));
  const shotDirty = Boolean(shot && (title !== String(shot.title ?? '') || prompt !== String(shot.prompt ?? '')
    || duration !== Number(shot.duration ?? 4)));
  dirtyRef.current = shotDirty;
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
    const previs = entry.source === 'previs';
    const content = <>
      <span className="board-input-icon" aria-hidden="true"><Icon name={sourceKindIcons[entry.sourceKind]} size={14}/></span>
      <span className="board-input-role">{t(referenceRoleKey(entry.role) as never)}</span>
      <span className="board-input-label" title={entry.label}>{entry.label}
        {entry.subjectVersionNumber !== undefined && t('boardUi.inputs.subjectVersionSuffix' as never,
          {version: formatNumber(entry.subjectVersionNumber)} as never)}
        {entry.primary === true && <span className="board-input-primary">{t('boardUi.inputs.primary')}</span>}
      </span>
      {unsupported && <span className="board-input-unsupported" data-testid={`board-input-unsupported-${key}`}>
        {t(unsupportedReasonKey(entry.reason) as never)}</span>}
    </>;
    return <li key={key} className={`board-input-row${unsupported ? ' is-unsupported' : ''}${open ? ' is-open' : ''}${previs ? ' is-static' : ''}`}
      data-testid={`board-input-${key}`} data-status={hasService ? entry.status : 'unknown'}>
      {previs
        // G's previs scene owns the figure/prop subject inside the previs
        // editor; its generation-input row is evidence only and is not a menu.
        ? <div className="board-input-button is-static" data-testid={`board-input-static-${key}`}>{content}</div>
        : <button type="button" className="board-input-button" disabled={props.busy} aria-haspopup="menu"
            aria-expanded={open} onClick={event => openInputMenu(event, entry)}>{content}</button>}
      {!previs && open && <div className="board-input-menu" role="menu" data-testid={`board-input-menu-${key}`}>
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
  useEffect(() => {
    if (!inputMenu && !serviceMenu) return;
    const close = (event: Event): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.board-input-menu, .board-service-menu, [data-testid="board-input-footer"]')) return;
      setInputMenu(null); setServiceMenu(false);
    };
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') {setInputMenu(null); setServiceMenu(false);} };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', key);
    return () => {document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', key);};
  }, [inputMenu, serviceMenu]);
  const serviceChoice = (provider: GenerationProvider, model?: Record<string, unknown>): BoardGenerationOptions => ({
    providerId: provider.id,
    ...(provider.connectionId ? {connectionId: provider.connectionId,
      configurationRevision: provider.configurationRevision} : {}),
    ...(model ? {model: String(model.modelId ?? model.id ?? ''),
      modelEntryId: String(model.modelEntryId ?? model.id ?? '')} : {})});
  const generationPanel = selected?.kind === 'shot' ? <section className="board-inspector-generation-inputs"
    data-testid="board-inspector-generation-inputs">
    <h4>{t('boardUi.inputs.title')}</h4>
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
      <div className="board-shot-duration-row">
        <span className="board-shot-duration-label">{t('boardUi.inspector.duration')}</span>
        <WorkbenchSelect className="board-shot-duration-select" data-testid="board-shot-duration" value={String(duration)}
          disabled={props.busy || shotRevision === null}
          onChange={event => {setDuration(Number(event.target.value)); setShotSaved(false);}}>
          {Array.from({length: 20}, (_, index) => index + 1).map(seconds =>
            <option key={seconds} value={seconds}>{t('boardUi.inspector.durationSeconds', {seconds})}</option>)}
        </WorkbenchSelect>
      </div>
      <div className="board-service-picker">
        <button type="button" className="board-input-footer" data-testid="board-input-footer"
          data-mode={inputs.mode} data-service={hasService ? 'selected' : 'missing'}
          aria-haspopup="menu" aria-expanded={serviceMenu}
          disabled={props.busy || !props.onGenerationOptionsChange}
          onClick={() => setServiceMenu(open => !open)}>
          <Icon name="sparkle" size={12}/>
          <span>{hasService
            ? [serviceLabel, t(generationModeKeys[inputs.mode] as never),
                ...(inputs.usedCount > 0 ? [t('boardUi.inputs.used', {count: inputs.usedCount})] : [])].join(' · ')
            : t('boardUi.inputs.serviceMissing')}</span>
        </button>
        {serviceMenu && <GenerationServiceMenu providers={generationProviders} disabled={props.busy}
          menuClassName="board-service-menu" menuTestId="board-service-menu" itemTestIdPrefix="board-service"
          onChoose={choice => {setServiceMenu(false);
            props.onGenerationOptionsChange?.(selected.id, serviceChoice(choice.provider, choice.model));}}
          onOpenSettings={() => {setServiceMenu(false); props.onOpenGenerationSettings?.();}}/>}
      </div>
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
    if (!shot || draftRevision.current === null || !shotDirty || !props.onUpdateShot) return;
    const result = await props.onUpdateShot(shot.id, {title: title.trim() || String(shot.title ?? ''),
      prompt, duration}, draftRevision.current);
    if (result.ok) {setShotError(''); setShotSaved(true);} else if (result.code) setShotError(result.code);
  };
  const shotTitleRow = selected?.kind === 'shot' && <div className="board-shot-title-row">
    <div className="board-shot-heading">
      <Icon name="film" size={15}/>
      {titleEditing
        ? <input className="board-shot-title-input" data-testid="board-shot-title" autoFocus maxLength={150}
            value={title} disabled={props.busy || shotRevision === null}
            aria-label={t('boardUi.inspector.shotTitle')}
            onChange={event => {setTitle(event.target.value); setShotSaved(false);}}
            onBlur={() => setTitleEditing(false)}
            onKeyDown={event => {if (event.key === 'Enter' || event.key === 'Escape') {event.preventDefault();
              if (event.key === 'Escape' && shot) setTitle(String(shot.title ?? ''));
              setTitleEditing(false);}}}/>
        : <button type="button" className="board-shot-title-button" data-testid="board-inspector-shot-title"
            onClick={() => setTitleEditing(true)}>{shotNumber && shot
              ? t('boardUi.inspector.shotHeading', {number: shotNumber, title: shot.title ?? ''})
              : shot?.title ?? selected.name}</button>}
    </div>
    {props.onOpenInEditing && <button type="button" className="board-shot-open-editing"
      data-testid="board-inspector-open-editing" onClick={() => props.onOpenInEditing!(selected.id)}>
      {t('boardUi.inspector.openInEditing')}</button>}
  </div>;
  const shotProperties = selected?.kind === 'shot' ? <div className="board-shot-properties" data-testid="board-shot-properties">
    <section className="board-shot-fields" data-testid="board-shot-fields">
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
            setDuration(Number(shot.duration ?? 4)); draftRevision.current = shotRevision;
            setShotError(''); setShotSaved(false);}}>{t('common.cancel')}</button>
        {shotSaved && <span role="status">{t('boardUi.inspector.saved')}</span>}
        {shotError && <span role="alert" data-testid="board-shot-error">{t(shotError.includes('REVISION_CONFLICT')
          ? 'boardUi.inspector.shotConflict' : 'boardUi.inspector.shotSaveFailed')}</span>}
      </div>}
    </section>
    {generationPanel}
    {props.rpc && typeof shot?.projectId === 'string' && props.rpc && <ShotDialogue shot={shot as never}
      subjectNames={props.dialogueSubjects ?? {}} projectId={shot.projectId as string}
      cueCount={props.dialogueCueCount ?? 0}
      // WT-3-05: the GP shot panel shows the same live dialogue status as the
      // read-only projection (selected silent service, prompt overflow, ...).
      dialogueStatus={props.inputs && props.inputs.shotId === shot.id ? props.inputs.dialogue : null}
      disabled={props.busy || !props.onDialogueApplied}
      rpc={props.rpc} onApplied={() => props.onDialogueApplied?.()}/>}
    {runningJob ? <section className="board-shot-progress" data-testid="board-shot-job-running"
      aria-label={`${t('redesign.board.generating')} · ${jobServiceName(runningJob)}`}>
      <div className="board-shot-progress-row">
        <span className="spinner" aria-hidden="true"/>
        <span className="board-shot-progress-label">{t('redesign.board.generating')} · {jobServiceName(runningJob)}</span>
        <strong className="board-shot-progress-percent">{Math.round(Number(runningJob.progress) || 0)}%</strong>
        {props.onCancelJob && <button type="button" className="board-shot-progress-cancel" data-testid="cancel-generation"
          disabled={props.busy || jobAction !== null} onClick={() => { void cancelGeneration(runningJob); }}>
          {t('redesign.board.cancelGeneration')}
        </button>}
      </div>
      <div className="board-shot-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={Math.round(Number(runningJob.progress) || 0)}><span style={{width: `${Math.max(2, Math.min(100, Math.round(Number(runningJob.progress) || 0)))}%`}}/></div>
    </section> : <>
      {failedJob && <section className="board-shot-failure" data-testid={`failed-version-${failedJob.id}`} role="alert">
        <span className="board-shot-failure-label" data-text-selectable>{t('redesign.board.failureReason',
          {reason: renderMessage(generationFailureDescriptor(failedJob.error))})}</span>
        {props.onRetryJob && <button type="button" className="board-shot-failure-retry" data-testid={`retry-failed-version-${failedJob.id}`}
          disabled={props.busy || jobAction !== null || retryPending} onClick={() => { void retryGeneration(failedJob); }}>
          <Icon name="refresh" size={12}/>{t('redesign.board.retry')}
        </button>}
      </section>}
      {unknownJob && <button type="button" className="board-shot-unknown" data-testid={`unknown-generation-${unknownJob.id}`}
        disabled={props.busy} onClick={() => props.onOpenTaskCenter?.(String(unknownJob.id))}>
        {t('redesign.board.unknownOutcome')}
      </button>}
      <button type="button" className="board-shot-generate" data-testid="board-inspector-generate"
        disabled={props.busy || !hasService || !props.onGenerateShot || Boolean(unknownJob)}
        onClick={() => { if (shot) props.onGenerateShot?.(shot.id); }}>
        <Icon name="sparkle" size={15}/>{t('boardUi.inspector.generate')}
      </button>
    </>}
  </div> : null;
  // A previs card owns the exact same inspector as formats 3/4 (keyframe
  // thumbnails, output links and 打开预演), including its own aside wrapper.
  if (selected?.kind === 'previs' && props.previsInspector) return <>{props.previsInspector}</>;
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

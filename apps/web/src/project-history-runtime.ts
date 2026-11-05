import {createProjectHistoryClient, ProjectHistoryError} from './project-history-client.ts';
import type {ProjectHistoryClient} from './project-history-client.ts';
import type {ProjectVersionSummary} from '../../../packages/contracts/src/project-versions.ts';
import type {ProjectVersionDifference, ProjectVersionPreviewResponse, ProjectVersionRestoreInput, ProjectVersionRestoreResponse, ProjectVersionSaveInput} from '../../../packages/contracts/src/project-version-operations.ts';
import {projectBackupSchemas} from '../../../packages/contracts/src/project-backups.ts';
import type {ProjectBackupSummary, ProjectBackupInspection, ProjectBackupStatus, ProjectBackupRestoreInput, ProjectBackupRestoreResponse} from '../../../packages/contracts/src/project-backups.ts';

export type HistoryView<T> = {kind: 'loading'} | {kind: 'error'; code: string; retryable: boolean} | {kind: 'ready'; value: T};
export interface HistoryPreview extends Omit<ProjectVersionPreviewResponse, 'changes'> {changes: ProjectVersionDifference[]}
export type HistoryMutation =
  | {kind: 'save'; input: ProjectVersionSaveInput; result?: undefined}
  | {kind: 'version'; input: ProjectVersionRestoreInput; result?: ProjectVersionRestoreResponse}
  | {kind: 'backup'; input: ProjectBackupRestoreInput; result?: ProjectBackupRestoreResponse};
export type HistoryAttempt = HistoryMutation & {phase: 'working' | 'unknown' | 'rejected' | 'complete'; code?: string};
export interface ProjectHistoryState {
  tab: 'versions' | 'backups'; versions: HistoryView<ProjectVersionSummary[]>; versionCursor: string | null;
  selected: string; preview: HistoryView<HistoryPreview>; backups: HistoryView<ProjectBackupSummary[]>;
  status: HistoryView<ProjectBackupStatus>; inspection: HistoryView<ProjectBackupInspection> | null;
  backupSelection: string | null; attempt: HistoryAttempt | null; choosing: boolean; paging: boolean;
}
const failure = (error: unknown): {code: string; retryable: boolean} => ({code: error instanceof ProjectHistoryError ? error.code : 'BACKEND_UNAVAILABLE',
  retryable: !(error instanceof ProjectHistoryError && error.definitive)});
export function createProjectHistoryRuntime(projectId: string, client: ProjectHistoryClient = createProjectHistoryClient(), newId = () => crypto.randomUUID()) {
  let state: ProjectHistoryState = {tab: 'versions', versions: {kind: 'loading'}, versionCursor: null, selected: 'current', preview: {kind: 'loading'},
    backups: {kind: 'loading'}, status: {kind: 'loading'}, inspection: null, backupSelection: null, attempt: null, choosing: false, paging: false};
  const listeners = new Set<() => void>(); let active = false, epoch = 0, selection = 0, listSerial = 0, backupSerial = 0, poll: ReturnType<typeof setTimeout> | undefined;
  const publish = (patch: Partial<ProjectHistoryState>) => {state = {...state, ...patch}; for (const listener of listeners) listener();};
  const locked = () => state.choosing || state.attempt?.phase === 'working' || state.attempt?.phase === 'unknown';
  const current = (owner: number) => active && epoch === owner;
  const laterStatus = (owner: number) => {clearTimeout(poll); if (current(owner) && state.tab === 'backups'
    && state.status.kind === 'ready' && ['running', 'slow'].includes(state.status.value.state)) poll = setTimeout(() => {void loadBackups(false);}, 2_000);};
  async function loadVersions(more = false) {
    if (!active || more && (state.paging || !state.versionCursor || state.versions.kind !== 'ready')) return;
    const owner = epoch, serial = ++listSerial, previous = state.versions.kind === 'ready' ? state.versions.value : [], cursor = more ? state.versionCursor : null;
    publish(more ? {paging: true} : {versions: {kind: 'loading'}, versionCursor: null});
    try {const page = await client.list({projectId, limit: 100, ...(cursor ? {cursor} : {})});
      if (!current(owner) || serial !== listSerial) return;
      const versions = more ? [...previous, ...page.versions] : page.versions;
      if (new Set(versions.map(item => item.id)).size !== versions.length || page.nextCursor && page.nextCursor === cursor) throw new ProjectHistoryError('BACKEND_PROTOCOL_ERROR');
      publish({versions: {kind: 'ready', value: versions}, versionCursor: page.nextCursor, paging: false});
    } catch (error) {if (current(owner) && serial === listSerial) publish({versions: {kind: 'error', ...failure(error)}, paging: false});}
  }
  async function select(id: string, more = false) {
    if (!active || locked() || more && (state.paging || state.preview.kind !== 'ready' || !state.preview.value.nextCursor)) return;
    const owner = epoch, serial = ++selection, old = state.preview.kind === 'ready' ? state.preview.value : null;
    const cursor = more ? old?.nextCursor : null;
    publish(more ? {paging: true} : {selected: id, preview: {kind: 'loading'}});
    if (id === 'current') return;
    try {const page = await client.preview({projectId, versionId: id, limit: 100, ...(cursor ? {cursor} : {})});
      if (!current(owner) || serial !== selection) return;
      if (more && (!old || old.version.id !== id || old.previewDigest !== page.previewDigest || old.contentToken !== page.contentToken
        || old.contentSequence !== page.contentSequence || old.totalChanges !== page.totalChanges || old.keptCurrentCount !== page.keptCurrentCount
        || page.nextCursor && page.nextCursor === cursor)) throw new ProjectHistoryError('PROJECT_VERSION_PREVIEW_CHANGED', true);
      const changes = more && old ? [...old.changes, ...page.changes] : page.changes;
      if (new Set(changes.map(item => JSON.stringify([item.table, item.key]))).size !== changes.length || changes.length > page.totalChanges) throw new ProjectHistoryError('BACKEND_PROTOCOL_ERROR');
      publish({preview: {kind: 'ready', value: {...page, changes}}, paging: false});
    } catch (error) {if (current(owner) && serial === selection) publish({preview: {kind: 'error', ...failure(error)}, paging: false});}
  }
  async function loadBackups(showLoading = true) {
    if (!active) return; const owner = epoch, serial = ++backupSerial;
    if (showLoading) publish({backups: {kind: 'loading'}, status: {kind: 'loading'}});
    await Promise.all([client.backups({projectId}).then(page => {if (current(owner) && serial === backupSerial) publish({backups: {kind: 'ready', value: page.backups}});})
      .catch(error => {if (current(owner) && serial === backupSerial) publish({backups: {kind: 'error', ...failure(error)}});}),
    client.status({projectId}).then(value => {if (current(owner) && serial === backupSerial) {publish({status: {kind: 'ready', value}}); laterStatus(owner);}})
      .catch(error => {if (current(owner) && serial === backupSerial) publish({status: {kind: 'error', ...failure(error)}});})]);
  }
  async function inspect(backupId: string) {
    if (!active || locked()) return; const owner = epoch, serial = ++selection;
    publish({backupSelection: backupId, inspection: {kind: 'loading'}});
    try {const value = await client.inspect({projectId, backupId}); if (current(owner) && serial === selection) publish({inspection: {kind: 'ready', value}});}
    catch (error) {if (current(owner) && serial === selection) publish({inspection: {kind: 'error', ...failure(error)}});}
  }
  async function execute(attempt: HistoryMutation) {
    if (state.attempt?.phase === 'working' || state.choosing) return;
    const pending: HistoryAttempt = {...attempt, phase: 'working'}; publish({attempt: pending});
    try {
      const result = attempt.kind === 'save' ? await client.save(attempt.input) : attempt.kind === 'version' ? await client.restore(attempt.input) : await client.restoreBackup(attempt.input);
      if (state.attempt !== pending) return;
      if (attempt.kind === 'version') publish({attempt: {...attempt, phase: 'complete', result: result as ProjectVersionRestoreResponse}});
      else if (attempt.kind === 'backup') publish({attempt: {...attempt, phase: 'complete', result: result as ProjectBackupRestoreResponse}});
      else publish({attempt: {...attempt, phase: 'complete'}});
      if (active && attempt.kind !== 'backup') {publish({selected: 'current'}); void loadVersions();}
    } catch (error) {if (state.attempt === pending) publish({attempt: {...attempt, phase: error instanceof ProjectHistoryError && error.definitive ? 'rejected' : 'unknown', code: failure(error).code}});}
  }
  return Object.freeze({projectId, snapshot: () => state, subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
    open(tab: ProjectHistoryState['tab'] = state.tab) {active = true; epoch++; publish({tab, paging: false});
      if (tab === 'versions') {void loadVersions(); if (!locked() && state.selected !== 'current') void select(state.selected);} else void loadBackups();},
    close() {active = false; epoch++; selection++; clearTimeout(poll);
      const pending = state.attempt?.phase === 'working' || state.attempt?.phase === 'unknown' ? state.attempt : null;
      // Read pages can include large plans. Closing retains only the exact
      // unresolved write, never a cache of every project the user visited.
      publish({versions: {kind: 'loading'}, versionCursor: null, selected: 'current', preview: {kind: 'loading'}, backups: {kind: 'loading'},
        status: {kind: 'loading'}, inspection: null, backupSelection: null, attempt: pending, choosing: false, paging: false});},
    tab(tab: ProjectHistoryState['tab']) {if (locked()) return; selection++; publish({tab, inspection: null, backupSelection: null, paging: false}); clearTimeout(poll);
      if (tab === 'versions') {void loadVersions(); if (state.selected !== 'current') void select(state.selected);} else void loadBackups();},
    loadVersions, select, loadBackups, inspect,
    save(name: string) {if (!active || locked()) return; return execute({kind: 'save', input: {projectId, requestId: newId(), ...(name.trim() ? {name: name.trim()} : {})}});},
    restoreVersion() {if (!active || locked() || state.preview.kind !== 'ready' || !state.preview.value.restoreAvailable || state.selected === 'current') return;
      const value = state.preview.value; return execute({kind: 'version', input: {projectId, versionId: value.version.id, requestId: newId(), expectedContentSequence: value.contentSequence,
        expectedContentToken: value.contentToken, previewDigest: value.previewDigest}});},
    async chooseBackup(choose: (input: {projectId: string; backupId: string; requestId: string}) => Promise<ProjectBackupRestoreInput | null>) {
      if (!active || locked() || !state.backupSelection) return; const owner = epoch, backupId = state.backupSelection, requestId = newId(); publish({choosing: true});
      try {const input = await choose({projectId, backupId, requestId}); if (!current(owner)) return;
        publish({choosing: false}); if (input === null) return;
        const parsed = projectBackupSchemas['project.backup.restore'].safeParse(input);
        if (!parsed.success || input.projectId !== projectId || input.backupId !== backupId || input.requestId !== requestId) throw new ProjectHistoryError('BACKEND_PROTOCOL_ERROR', true);
        await execute({kind: 'backup', input: parsed.data});
      } catch (error) {if (current(owner)) {publish({choosing: false}); throw error;}}
    },
    retry() {const attempt = state.attempt; if (attempt?.phase === 'unknown' && active) return execute(attempt);},
    dismissAttempt() {if (!locked()) publish({attempt: null});},
    closeInspection() {if (!locked()) {selection++; publish({inspection: null, backupSelection: null});}},
  });
}
export type ProjectHistoryRuntime = ReturnType<typeof createProjectHistoryRuntime>;
// Only uncertain/in-flight identities survive closing a view. They are scoped
// to this loaded backend document; no browser persistence or cross-tab replay.
const retained = new Map<string, ProjectHistoryRuntime>();
export function projectHistoryRuntime(projectId: string): ProjectHistoryRuntime {
  const pending = retained.get(projectId); if (pending) return pending;
  const runtime = createProjectHistoryRuntime(projectId);
  runtime.subscribe(() => {
    const phase = runtime.snapshot().attempt?.phase;
    if (phase === 'working' || phase === 'unknown') retained.set(projectId, runtime);
    else if (retained.get(projectId) === runtime) retained.delete(projectId);
  });
  return runtime;
}

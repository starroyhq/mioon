import type {AssetMediaState} from '../../../packages/contracts/src/asset-media.ts';
import {assetMediaStatusListResponseSchema, assetMediaDtoSchema} from '../../../packages/contracts/src/asset-media.ts';
import {projectIdSchema} from '../../../packages/contracts/src/project-file.ts';
import type {MediaRelinkResult, MediaRelinkRow} from './project-file/MediaRelinkDialog.tsx';
import type {ViewState, ActionState} from './project-file/types.ts';
import {mediaStatusDisplay} from './project-file/media-status.ts';
import type {MediaStatusUi} from './project-file/media-status.ts';
import {createProjectMediaClient, mediaLocationPageSchema, mediaRelinkPreviewSchema, ProjectMediaError} from './project-media-client.ts';
import type {ProjectMediaClient, MediaLocationPage, MediaRelinkPreview} from './project-media-client.ts';

export interface ProjectMediaOwner {readonly appLibraryScope: string; readonly instanceId: string; readonly projectId: string; readonly epoch: number; readonly session: string}
export interface ProjectMediaAsset {readonly id: string; readonly projectId: string; readonly name: string; readonly mimeType: string; readonly referenceRevision: number}
export interface MediaRelinkSelection {readonly preview: MediaRelinkPreview; readonly displayPaths: readonly {readonly assetId: string; readonly displayPath: string}[]}
export type ChooseMediaPreview = (input: {readonly projectId: string; readonly assetId: string; readonly expectedReferenceRevision: number; readonly signal: AbortSignal}) => Promise<MediaRelinkSelection | null>;
export interface ProjectMediaState {
  readonly owner: ProjectMediaOwner | null;
  readonly status: ViewState<Readonly<Record<string, AssetMediaState>>>;
  readonly locations: ViewState<MediaLocationPage>;
  readonly outsideOpen: boolean;
  readonly outsideAction: ActionState<'allow' | 'open'>;
  readonly rulesUntrusted: boolean;
  readonly relinkOpen: boolean;
  readonly relink: ViewState<MediaRelinkResult>;
  readonly applyAction: ActionState<'apply'>;
  readonly changedSelected: readonly string[];
  readonly newAdded: number;
  readonly canChoose: boolean;
  readonly canChangeSelection: boolean;
  readonly canApply: boolean;
  readonly lastError: string | null;
}
export const sameMediaOwner = (a: ProjectMediaOwner | null, b: ProjectMediaOwner | null): boolean => a === b || Boolean(a && b && a.appLibraryScope === b.appLibraryScope && a.instanceId === b.instanceId && a.projectId === b.projectId && a.epoch === b.epoch && a.session === b.session);
const initial = (owner: ProjectMediaOwner | null, canChoose: boolean): ProjectMediaState => ({owner, status: {kind: 'loading'}, locations: {kind: 'loading'}, outsideOpen: false, outsideAction: {kind: 'idle'}, rulesUntrusted: false,
  relinkOpen: false, relink: {kind: 'loading'}, applyAction: {kind: 'idle'}, changedSelected: [], newAdded: 0, canChoose, canChangeSelection: true, canApply: false, lastError: null});
function invalid(code = 'BACKEND_PROTOCOL_ERROR'): never {throw new ProjectMediaError(code);}
const basisKey = (assets: readonly ProjectMediaAsset[]): string => JSON.stringify(assets.map(asset => [asset.id, asset.referenceRevision]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
type Preview = {readonly value: MediaRelinkPreview; readonly paths: ReadonlyMap<string, string>; readonly revisions: ReadonlyMap<string, number>};
interface ApplyStep {readonly kind: 'relink' | 'changed'; readonly input: {projectId: string; requestId: string; previewToken?: string; assetId?: string; expectedReferenceRevision?: number}; readonly revisions: ReadonlyMap<string, number>; readonly existingIds: ReadonlySet<string>}
interface ApplyIntent {readonly steps: readonly ApplyStep[]; index: number; added: number}
interface PermissionIntent {readonly steps: readonly {directory: string; locationToken: string; requestId: string}[]; readonly assetKey: string; index: number}

/** A view owner for S1 capabilities. File selection is an optional trusted
 * port; this controller never manufactures paths, imports or permission. */
export function createProjectMediaController({client = createProjectMediaClient(), readOwner, readAssets, choosePreview, onChange = () => {}, onApplied = () => {}, autoOpenOutside = true, newRequestId = () => crypto.randomUUID()}: {
  client?: ProjectMediaClient; readOwner: () => ProjectMediaOwner | null; readAssets: () => readonly ProjectMediaAsset[]; choosePreview?: ChooseMediaPreview;
  onChange?: (state: ProjectMediaState) => void; onApplied?: (owner: ProjectMediaOwner) => unknown | Promise<unknown>; autoOpenOutside?: boolean; newRequestId?: () => string;
}) {
  let active = false, generation = 0, statusSerial = 0, locationSerial = 0, rulesSerial = 0, selectionSerial = 0;
  let state = initial(null, Boolean(choosePreview)), assetKey = '', dismissedOutside = false;
  const requests = new Map<AbortController, string>();
  const selectedRevisions = new Map<string, number>();
  let preview: Preview | null = null, selected = new Set<string>(), intent: ApplyIntent | null = null, permissionIntent: PermissionIntent | null = null;
  const ownerCurrent = (owner: ProjectMediaOwner | null, lifetime = generation): owner is ProjectMediaOwner => Boolean(active && owner && lifetime === generation && sameMediaOwner(owner, state.owner) && sameMediaOwner(owner, readOwner()));
  function publish(patch: Partial<ProjectMediaState> = {}): void {
    const next = {...state, ...patch};
    const canChangeSelection = !intent && next.applyAction.kind !== 'working';
    state = Object.freeze({...next, canChoose: Boolean(choosePreview) && canChangeSelection, canChangeSelection, changedSelected: Object.freeze([...selected]), canApply: Boolean(intent || preview?.value.chosen.matches || selected.size) && next.applyAction.kind !== 'working'});
    if (active) onChange(state);
  }
  const errorCode = (error: unknown): string => error instanceof ProjectMediaError ? error.code : 'BACKEND_UNAVAILABLE';
  function assets(owner: ProjectMediaOwner): readonly ProjectMediaAsset[] {
    const values = readAssets();
    if (values.length > 20_000 || new Set(values.map(asset => asset.id)).size !== values.length || values.some(asset => asset.projectId !== owner.projectId || !projectIdSchema.safeParse(asset.id).success || !Number.isSafeInteger(asset.referenceRevision) || asset.referenceRevision < 1)) invalid('MEDIA_REFERENCE_INVALID');
    return values;
  }
  function revisionsCurrent(owner: ProjectMediaOwner, revisions: ReadonlyMap<string, number>): boolean {
    const current = new Map(assets(owner).map(asset => [asset.id, asset.referenceRevision]));
    return [...revisions].every(([id, revision]) => current.get(id) === revision);
  }
  function abortChannel(channel: string): void {for (const [abort, value] of requests) if (value === channel) abort.abort();}
  async function request<T>(action: (signal: AbortSignal) => Promise<T>, channel = 'action'): Promise<T> {
    const abort = new AbortController(); requests.set(abort, channel);
    let rejectAbort: (error: ProjectMediaError) => void = () => {};
    const stopped = new Promise<never>((_resolve, reject) => {rejectAbort = reject;});
    const stop = (): void => rejectAbort(new ProjectMediaError('INTERRUPTED'));
    abort.signal.addEventListener('abort', stop, {once: true});
    try {return await Promise.race([action(abort.signal), stopped]);}
    finally {abort.signal.removeEventListener('abort', stop); requests.delete(abort);}
  }
  function rows(): MediaRelinkResult {
    if (!state.owner) return {rows: [], foundBy: null};
    const locations = state.locations.kind === 'ready' ? new Map(state.locations.value.assets.map(asset => [asset.assetId, asset])) : new Map();
    const statuses = state.status.kind === 'ready' ? state.status.value : {};
    const found = new Set(preview?.value.found.map(asset => asset.assetId) ?? []);
    const mismatched = new Set(preview?.value.mismatched.map(asset => asset.assetId) ?? []);
    const values: MediaRelinkRow[] = assets(state.owner).flatMap(asset => {
      const status = statuses[asset.id], picked = preview?.value.chosen.assetId === asset.id;
      if (status?.status === 'online' && status.readable && !picked && !found.has(asset.id) && !mismatched.has(asset.id)) return [];
      const outcome = picked && preview?.value.chosen.matches ? 'picked' : found.has(asset.id) ? 'auto' : status?.status === 'changed' && status.reason !== 'unverified' || mismatched.has(asset.id) || picked ? 'changed' : 'missing';
      return [{assetId: asset.id, name: asset.name, mediaKind: asset.mimeType.startsWith('video/') ? 'video' : asset.mimeType.startsWith('audio/') ? 'audio' : 'image',
        from: locations.get(asset.id)?.displayPath ?? asset.name, to: preview?.paths.get(asset.id) ?? null, outcome}];
    });
    const chosen = assets(state.owner).find(asset => asset.id === preview?.value.chosen.assetId);
    return {rows: values, foundBy: chosen && found.size ? {name: chosen.name, count: found.size} : null};
  }
  function renderRelink(): void {if (state.relinkOpen) publish({relink: state.status.kind === 'ready' && state.locations.kind === 'ready' ? {kind: 'ready', value: rows()} : state.status.kind === 'error' || state.locations.kind === 'error' ? {kind: 'error', retryable: true} : {kind: 'loading'}});}
  async function refreshStatus(): Promise<boolean> {
    const owner = state.owner, lifetime = generation, serial = ++statusSerial;
    if (!ownerCurrent(owner, lifetime)) return false;
    abortChannel('status');
    publish({status: {kind: 'loading'}, lastError: null});
    const items: Record<string, AssetMediaState> = {}; let cursor: string | undefined;
    try {
      const basis = assets(owner), key = basisKey(basis), expected = new Map(basis.map(asset => [asset.id, asset.referenceRevision]));
      if (basis.length) for (let pages = 0; ; pages++) {
        if (!ownerCurrent(owner, lifetime) || serial !== statusSerial || key !== basisKey(assets(owner))) return false;
        if (pages >= 200) invalid('INSPECTION_BUDGET_EXCEEDED');
        const raw = await request(signal => client.status({projectId: owner.projectId, ...(cursor ? {cursor} : {}), limit: 100}, {signal}), 'status');
        if (!ownerCurrent(owner, lifetime) || serial !== statusSerial || key !== basisKey(assets(owner))) return false;
        const page = assetMediaStatusListResponseSchema.parse(raw); let last = cursor;
        for (const item of page.items) {
          if (last && item.assetId <= last || items[item.assetId] || expected.get(item.assetId) !== item.referenceRevision) invalid('REVISION_CONFLICT');
          items[item.assetId] = Object.freeze(item); last = item.assetId;
        }
        if (Object.keys(items).length > 20_000 || page.nextCursor !== null && (page.items.length === 0 || page.nextCursor !== last || cursor !== undefined && page.nextCursor <= cursor)) invalid();
        if (page.nextCursor === null) break; cursor = page.nextCursor;
      }
      if (Object.keys(items).length !== expected.size) invalid('REVISION_CONFLICT');
      if (!ownerCurrent(owner, lifetime) || serial !== statusSerial) return false;
      publish({status: {kind: 'ready', value: Object.freeze(items)}}); renderRelink(); return true;
    } catch (error) {if (ownerCurrent(owner, lifetime) && serial === statusSerial) {publish({status: {kind: 'error', retryable: true}, lastError: errorCode(error)}); renderRelink();} return false;}
  }
  async function refreshLocations(): Promise<boolean> {
    const owner = state.owner, lifetime = generation, serial = ++locationSerial;
    if (!ownerCurrent(owner, lifetime)) return false;
    abortChannel('locations');
    publish({locations: {kind: 'loading'}});
    let cursor: string | undefined, groups: MediaLocationPage['locations'] = []; const located: MediaLocationPage['assets'] = [], seen = new Set<string>();
    try {
      const key = basisKey(assets(owner)), expected = new Set(assets(owner).map(asset => asset.id));
      for (let pages = 0; ; pages++) {
        if (!ownerCurrent(owner, lifetime) || serial !== locationSerial || key !== basisKey(assets(owner))) return false;
        if (pages >= 200) invalid('INSPECTION_BUDGET_EXCEEDED');
        const page = mediaLocationPageSchema.parse(await request(signal => client.locations({projectId: owner.projectId, ...(cursor ? {cursor} : {}), limit: 100}, {signal}), 'locations'));
        if (!ownerCurrent(owner, lifetime) || serial !== locationSerial || key !== basisKey(assets(owner))) return false;
        let last = cursor;
        for (const asset of page.assets) {if (!expected.has(asset.assetId) || seen.has(asset.assetId) || last && asset.assetId <= last) invalid('REVISION_CONFLICT'); seen.add(asset.assetId); located.push(asset); last = asset.assetId;}
        // S1 repeats the complete grouping on every asset page and signs new
        // tokens. Keep one final grouping; never append duplicate permissions.
        if (pages && JSON.stringify(groups.map(({locationToken: _token, ...value}) => value)) !== JSON.stringify(page.locations.map(({locationToken: _token, ...value}) => value))) invalid('REVISION_CONFLICT');
        groups = page.locations;
        if (page.nextCursor !== null && (page.assets.length === 0 || page.nextCursor !== last || cursor !== undefined && page.nextCursor <= cursor)) invalid();
        if (page.nextCursor === null) break; cursor = page.nextCursor;
      }
      if (seen.size !== expected.size) invalid('REVISION_CONFLICT');
      if (permissionIntent && permissionIntent.steps.every(step => groups.some(group => group.directory === step.directory && group.confirmed))) permissionIntent = null;
      const pending = groups.some(group => !group.confirmed);
      publish({locations: {kind: 'ready', value: {assets: located, locations: groups, nextCursor: null}}, ...(autoOpenOutside && pending && !dismissedOutside ? {outsideOpen: true} : {})}); renderRelink(); return true;
    } catch (error) {if (ownerCurrent(owner, lifetime) && serial === locationSerial) {publish({locations: {kind: 'error', retryable: true}, lastError: errorCode(error)}); renderRelink();} return false;}
  }
  async function refreshRules(): Promise<void> {
    const owner = state.owner, lifetime = generation, serial = ++rulesSerial;
    if (!ownerCurrent(owner, lifetime)) return;
    abortChannel('rules');
    try {const rules = await request(signal => client.rules(owner.projectId, {signal}), 'rules'); if (ownerCurrent(owner, lifetime) && serial === rulesSerial) publish({rulesUntrusted: rules.projectId === owner.projectId && rules.trust === 'untrusted'});}
    catch {if (ownerCurrent(owner, lifetime) && serial === rulesSerial) publish({rulesUntrusted: false});}
  }
  async function refresh(): Promise<void> {await Promise.all([refreshStatus(), refreshLocations(), refreshRules()]);}
  async function observeApplied(owner: ProjectMediaOwner, lifetime: number): Promise<void> {
    if (!ownerCurrent(owner, lifetime)) return;
    publish({status: {kind: 'loading'}});
    try {await onApplied(owner); if (ownerCurrent(owner, lifetime)) await refresh();}
    catch (error) {if (ownerCurrent(owner, lifetime)) publish({status: {kind: 'error', retryable: true}, lastError: errorCode(error)});}
  }
  async function choose(assetId: string): Promise<void> {
    const owner = state.owner, lifetime = generation, serial = ++selectionSerial;
    if (!choosePreview || !ownerCurrent(owner, lifetime) || state.applyAction.kind === 'working' || intent) return;
    abortChannel('choose');
    const basis = new Map(assets(owner).map(asset => [asset.id, asset.referenceRevision])), revision = basis.get(assetId);
    if (!revision) return;
    preview = null; selected.clear(); selectedRevisions.clear(); publish({relink: {kind: 'loading'}, applyAction: {kind: 'idle'}});
    try {
      const result = await request(signal => choosePreview({projectId: owner.projectId, assetId, expectedReferenceRevision: revision, signal}), 'choose');
      if (!ownerCurrent(owner, lifetime) || serial !== selectionSerial || !revisionsCurrent(owner, basis)) return;
      if (result === null) {renderRelink(); return;}
      const value = mediaRelinkPreviewSchema.parse(result.preview), paths = new Map<string, string>();
      if (value.chosen.assetId !== assetId || !Array.isArray(result.displayPaths)) invalid();
      for (const item of result.displayPaths) {if (!basis.has(item.assetId) || paths.has(item.assetId) || typeof item.displayPath !== 'string' || !item.displayPath || item.displayPath.length > 4096) invalid(); paths.set(item.assetId, item.displayPath);}
      const changes = [value.chosen.assetId, ...value.found.map(asset => asset.assetId)];
      if (changes.some(id => !paths.has(id)) || [...changes, ...value.mismatched.map(asset => asset.assetId), ...value.unverified.map(asset => asset.assetId)].some(id => !basis.has(id))) invalid();
      preview = {value, paths, revisions: new Map(changes.map(id => [id, basis.get(id)!]))}; publish(); renderRelink();
    } catch (error) {if (ownerCurrent(owner, lifetime) && serial === selectionSerial) publish({relink: {kind: 'error', retryable: true}, lastError: errorCode(error)});}
  }
  function toggleChanged(assetId: string): void {
    const owner = state.owner;
    if (!ownerCurrent(owner) || state.applyAction.kind === 'working' || intent || state.status.kind !== 'ready') return;
    const row = state.status.value[assetId];
    if (!row || row.status !== 'changed' || !row.readable || row.reason === 'unverified' || assets(owner).find(asset => asset.id === assetId)?.referenceRevision !== row.referenceRevision) return;
    if (selected.has(assetId)) {selected.delete(assetId); selectedRevisions.delete(assetId);} else {selected.add(assetId); selectedRevisions.set(assetId, row.referenceRevision);}
    publish(); renderRelink();
  }
  async function apply(): Promise<boolean> {
    const owner = state.owner, lifetime = generation;
    if (!ownerCurrent(owner, lifetime) || state.applyAction.kind === 'working') return false;
    if (!intent) {
      const basis = new Map(assets(owner).map(asset => [asset.id, asset.referenceRevision])), steps: ApplyStep[] = [];
      if (preview?.value.chosen.matches) steps.push({kind: 'relink', input: {projectId: owner.projectId, requestId: newRequestId(), previewToken: preview.value.previewToken}, revisions: preview.revisions, existingIds: new Set(basis.keys())});
      for (const id of selected) {const revision = selectedRevisions.get(id); if (!revision || basis.get(id) !== revision) {publish({applyAction: {kind: 'error', action: 'apply'}, lastError: 'REVISION_CONFLICT'}); return false;} steps.push({kind: 'changed', input: {projectId: owner.projectId, requestId: newRequestId(), assetId: id, expectedReferenceRevision: revision}, revisions: new Map([[id, revision]]), existingIds: new Set(basis.keys())});}
      if (!steps.length) return false; intent = {steps, index: 0, added: 0};
    }
    const exact = intent; let dispatched = false;
    publish({applyAction: {kind: 'working', action: 'apply'}});
    try {
      while (exact.index < exact.steps.length) {
        const step = exact.steps[exact.index];
        if (!ownerCurrent(owner, lifetime) || intent !== exact || !revisionsCurrent(owner, step.revisions)) invalid('REVISION_CONFLICT');
        if (step.kind === 'relink') {
          dispatched = true;
          const result = await request(signal => client.apply(step.input, {signal}));
          if (!ownerCurrent(owner, lifetime) || intent !== exact) return false;
          if (!revisionsCurrent(owner, step.revisions) || result.assets.length !== step.revisions.size || new Set(result.assets.map(asset => asset.id)).size !== step.revisions.size || result.assets.some(raw => {const asset = assetMediaDtoSchema.parse(raw); return asset.projectId !== owner.projectId || asset.referenceRevision !== (step.revisions.get(asset.id) ?? -1) + 1;})) throw new ProjectMediaError('BACKEND_PROTOCOL_ERROR', {outcomeUnknown: true});
          preview = null;
        } else {
          dispatched = true;
          const result = await request(signal => client.acceptChanged(step.input, {signal}));
          if (!ownerCurrent(owner, lifetime) || intent !== exact) return false;
          const asset = assetMediaDtoSchema.parse(result.asset);
          if (!revisionsCurrent(owner, step.revisions) || result.replacesAssetId !== step.input.assetId || asset.id === step.input.assetId || step.existingIds.has(asset.id) || asset.projectId !== owner.projectId || asset.referenceRevision !== 1) throw new ProjectMediaError('BACKEND_PROTOCOL_ERROR', {outcomeUnknown: true});
          selected.delete(result.replacesAssetId); selectedRevisions.delete(result.replacesAssetId); exact.added++;
        }
        exact.index++;
        dispatched = false;
      }
      intent = null; publish({applyAction: {kind: 'idle'}, newAdded: state.newAdded + exact.added});
      await observeApplied(owner, lifetime);
      return true;
    } catch (error) {
      if (ownerCurrent(owner, lifetime)) {
        // Only an explicit retry reuses this exact request sequence. Unknown
        // acknowledgements never mint another key or accept another file.
        if (error instanceof ProjectMediaError && !error.outcomeUnknown || !dispatched) {intent = null; preview = null; selected.clear(); selectedRevisions.clear();}
        const added = exact.added; exact.added = 0;
        publish({applyAction: {kind: 'error', action: 'apply'}, newAdded: state.newAdded + added, lastError: errorCode(error)}); renderRelink();
        // A later failure cannot hide the prefix whose acknowledgements were
        // verified. Reconcile that known work without resending any mutation.
        if (exact.index > 0) await observeApplied(owner, lifetime);
      }
      return false;
    }
  }
  async function allowOutside(): Promise<boolean> {
    const owner = state.owner, lifetime = generation;
    if (!ownerCurrent(owner, lifetime) || state.outsideAction.kind === 'working' || state.locations.kind !== 'ready') return false;
    const groups = state.locations.value.locations.filter(location => location.available && !location.confirmed);
    if (!permissionIntent) {
      if (!groups.length) return false;
      permissionIntent = {steps: groups.map(group => ({directory: group.directory, locationToken: group.locationToken, requestId: newRequestId()})), assetKey: basisKey(assets(owner)), index: 0};
    }
    const exact = permissionIntent;
    const basis = new Map(assets(owner).map(asset => [asset.id, asset.referenceRevision]));
    publish({outsideAction: {kind: 'working', action: 'allow'}});
    try {
      while (exact.index < exact.steps.length) {
        const group = exact.steps[exact.index];
        if (!ownerCurrent(owner, lifetime) || exact.assetKey !== basisKey(assets(owner)) || !revisionsCurrent(owner, basis)) invalid('REVISION_CONFLICT');
        const result = await request(signal => client.confirm({projectId: owner.projectId, requestId: group.requestId, locationToken: group.locationToken}, {signal}));
        if (!ownerCurrent(owner, lifetime)) return false;
        if (result.confirmedDirectories.length !== 1 || result.confirmedDirectories[0] !== group.directory || result.revokedDirectories.length) throw new ProjectMediaError('BACKEND_PROTOCOL_ERROR', {outcomeUnknown: true});
        exact.index++;
      }
      permissionIntent = null; dismissedOutside = true; publish({outsideOpen: false, outsideAction: {kind: 'idle'}}); await refresh(); return true;
    } catch (error) {if (ownerCurrent(owner, lifetime)) {if (error instanceof ProjectMediaError && !error.outcomeUnknown) permissionIntent = null; publish({outsideAction: {kind: 'error', action: 'allow'}, lastError: errorCode(error)}); await Promise.all([refreshLocations(), refreshStatus()]);} return false;}
  }
  function statusFor(asset: ProjectMediaAsset | string): MediaStatusUi {
    const owner = state.owner;
    if (!ownerCurrent(owner)) return {kind: 'checking'};
    let catalog: readonly ProjectMediaAsset[];
    try {catalog = assets(owner);} catch {return {kind: 'check-failed'};}
    const current = typeof asset === 'string' ? catalog.find(value => value.id === asset) : asset;
    const admitted = current && catalog.find(value => value.id === current.id);
    if (!current || !admitted || admitted.referenceRevision !== current.referenceRevision || current.projectId !== owner.projectId || state.status.kind === 'loading') return {kind: 'checking'};
    if (state.status.kind === 'error') return {kind: 'check-failed'};
    const status = state.status.value[current.id];
    if (status?.status === 'online' && !status.readable && !status.outside) return {kind: 'check-failed'};
    return status && status.referenceRevision === current.referenceRevision ? mediaStatusDisplay(status) : {kind: 'checking'};
  }
  function cancelRelink(): void {if (state.applyAction.kind === 'working') return; selectionSerial++; abortChannel('choose'); if (!intent) {preview = null; selected.clear(); selectedRevisions.clear();} publish({relinkOpen: false, ...(intent ? {} : {applyAction: {kind: 'idle'} as const})});}
  return {
    getState: (): ProjectMediaState => state,
    activate() {active = true;},
    dispose() {active = false; generation++; statusSerial++; locationSerial++; selectionSerial++; for (const [abort] of requests) abort.abort(); requests.clear(); preview = null; intent = null; permissionIntent = null; selected.clear(); selectedRevisions.clear(); state = initial(null, Boolean(choosePreview));},
    update(owner: ProjectMediaOwner | null) {
      let key: string;
      try {key = owner ? basisKey(assets(owner)) : '';}
      catch (error) {generation++; for (const [abort] of requests) abort.abort(); requests.clear(); preview = null; intent = null; permissionIntent = null; selected.clear(); selectedRevisions.clear(); state = initial(owner, Boolean(choosePreview)); publish({status: {kind: 'error', retryable: true}, locations: {kind: 'error', retryable: true}, lastError: errorCode(error)}); return;}
      if (!sameMediaOwner(owner, state.owner)) {generation++; for (const [abort] of requests) abort.abort(); requests.clear(); preview = null; intent = null; permissionIntent = null; selected.clear(); selectedRevisions.clear(); dismissedOutside = false; state = initial(owner ? Object.freeze({...owner}) : null, Boolean(choosePreview)); assetKey = key; publish();}
      else if (key !== assetKey) {assetKey = key; statusSerial++; locationSerial++; selectionSerial++; abortChannel('status'); abortChannel('locations'); abortChannel('choose'); if (!intent) {preview = null; selected.clear(); selectedRevisions.clear();} publish({status: {kind: 'loading'}, locations: {kind: 'loading'}});}
    },
    refresh, refreshStatus, refreshLocations,
    openOutside() {if (!ownerCurrent(state.owner)) return; publish({outsideOpen: true}); void refreshLocations(); void refreshRules();},
    openOnly() {if (state.outsideAction.kind === 'working') return; dismissedOutside = true; publish({outsideOpen: false});},
    openRelink() {if (!ownerCurrent(state.owner)) return; publish({relinkOpen: true}); renderRelink(); if (state.locations.kind !== 'ready') void refreshLocations();},
    cancelRelink, choose, toggleChanged, apply, allowOutside, statusFor,
    canRead(asset: ProjectMediaAsset | string): boolean {const assetId = typeof asset === 'string' ? asset : asset.id; return statusFor(asset).kind === 'online' && state.status.kind === 'ready' && state.status.value[assetId]?.readable === true;},
  };
}
export type ProjectMediaController = ReturnType<typeof createProjectMediaController>;

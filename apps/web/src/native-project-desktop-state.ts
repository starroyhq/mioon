import type {ProjectEntriesDesktopBridge, ProjectDesktopCapabilities, ProjectDesktopOpenResult, ProjectDesktopSelection, ProjectLocationFacts} from '../../../packages/contracts/src/project-entry-desktop.ts';
import {projectEntryDesktopRequestSchema} from '../../../packages/contracts/src/project-entry-desktop.ts';
import {projectCopyResponseSchema} from '../../../packages/contracts/src/project-copies.ts';
import {projectEntryOpenFailure, projectEntryOpenFailureSchema} from '../../../packages/contracts/src/project-entry-open-failure.ts';
import type {ProjectEntryIdentityOwner} from './project-entry-identity.ts';
import {readProjectEntryIdentity} from './project-entry-identity.ts';
import type {NewProjectFileValues, NewProjectFileState} from './project-file/NewProjectFileDialog.tsx';
import {DEFAULT_TIMELINE_OUTPUT_PRESET} from '../../../packages/contracts/src/timeline-output-geometry.ts';
import type {ProjectOpenIssue} from './project-file/project-open-issue.ts';
import type {ProjectOpenFailureAction, ProjectOpenFailureActionState} from './project-file/ProjectOpenFailureDialog.tsx';
import type {ProjectLocationRisk, OpenedProjectLocationRisk} from './project-file/ProjectLocationRisk.tsx';

export function projectLocationRisks(facts: ProjectLocationFacts): readonly ProjectLocationRisk[] {
  return [...(!facts.isLocal ? [{kind: 'network'} as const] : []),
    ...(['known-icloud', 'known-file-provider'].includes(facts.cloud) ? [{kind: 'cloud', ...(facts.cloud === 'known-icloud' ? {serviceName: 'iCloud'} : {})} as const] : []),
    ...(!facts.permissionBits ? [{kind: 'permissions', fileSystem: facts.fileSystem} as const] : [])];
}
interface Failure {readonly issue: ProjectOpenIssue; readonly name: string | null; readonly token?: string; readonly projectId?: string; readonly reselect?: 'duplicate' | 'open-file'; readonly entryExpired?: true}
export interface NativeProjectDesktopState {
  readonly capabilities: ProjectDesktopCapabilities | null; readonly busy: boolean; readonly blocked: boolean;
  readonly createOpen: boolean; readonly values: NewProjectFileValues; readonly selection: ProjectDesktopSelection | null; readonly selectionInvalid: boolean; readonly createState: NewProjectFileState;
  readonly failure: Failure | null; readonly action: ProjectOpenFailureActionState;
  readonly risks: readonly OpenedProjectLocationRisk[];
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** The host owns selections and filesystem observations. This owner retains
 * only public DTOs and exact in-flight inputs, never arbitrary path authority. */
export function createNativeProjectDesktopController({client, identity, beforeAction, openCreated, message, isCurrent = () => true, canStart = () => true, onOpened = () => {}, onChange = () => {}, newId = () => globalThis.crypto.randomUUID(), now = () => Date.now()} : {
  client: ProjectEntriesDesktopBridge; identity: ProjectEntryIdentityOwner;
  beforeAction: (preserveDraft: boolean) => Promise<boolean | (() => boolean)>; openCreated: (id: string, permit?: () => boolean) => Promise<boolean>;
  message: () => string; isCurrent?: () => boolean; canStart?: () => boolean; onOpened?: () => void; onChange?: () => void; newId?: () => string; now?: () => number;
}) {
  let active = false, generation = 0, dismissedRisk = false, draftVersion = 0;
  let retiredForQuit = false;
  let initialization: {generation: number; promise: Promise<void>} | null = null;
  let pendingEditor: boolean | null = null, pendingHint = 1, consumedHint = 0;
  let pendingTake: {generation: number; promise: Promise<void>} | null = null;
  let pendingPresentation: {generation: number; valid: () => boolean; value: ProjectDesktopOpenResult} | null = null;
  let releasePending: (() => void) | null = null;
  let retry: (() => Promise<boolean>) | null = null, knownCreated: string | null = null;
  let pendingOpen: {generation: number; resume: () => Promise<void>} | null = null;
  type Mutation = 'createAtSelection' | 'duplicate' | 'copyTo' | 'adoptCopy';
  interface WriteIntent {readonly action: ProjectOpenFailureAction; readonly resume: () => Promise<boolean>; acknowledged: boolean; retired: boolean}
  const dispatchedWrites = new Set<WriteIntent>(), retiredWrites = new Set<WriteIntent>();
  let retryIntent: WriteIntent | null = null;
  let state: NativeProjectDesktopState = {capabilities: null, busy: false, blocked: false, createOpen: false,
    values: {name: '', description: '', presetId: DEFAULT_TIMELINE_OUTPUT_PRESET, createFolder: true}, selection: null, selectionInvalid: false, createState: {kind: 'editing'}, failure: null, action: {kind: 'idle'}, risks: []};
  const listeners = new Set<() => void>();
  const emit = (patch: Partial<NativeProjectDesktopState>) => {state = Object.freeze({...state, ...patch}); onChange(); for (const listener of listeners) listener();};
  const current = (serial = generation) => active && serial === generation && isCurrent() && !identity.getState().identityBlocked && !state.blocked;
  const startable = () => current() && canStart() && !pendingOpen;
  const editable = () => startable() && state.createOpen && !state.busy && !retry && !knownCreated;
  const expiredTicket = (error: unknown) => object(error) && error.code === 'PROJECT_ENTRY_TICKET_EXPIRED' && error.status === 409;
  const unavailableSelection = (error: unknown, mutation?: Mutation) => object(error) && error.status === 409 &&
    (error.code === 'PROJECT_ENTRY_UNAVAILABLE' && (mutation === 'createAtSelection' || mutation === 'duplicate' || mutation === 'copyTo') ||
      expiredTicket(error) && (mutation === 'createAtSelection' || mutation === 'duplicate'));
  const rejected = (error: unknown, action: ProjectOpenFailureAction, mutation?: Mutation) => object(error) && typeof error.code === 'string' &&
    (['VALIDATION_ERROR', 'PROJECT_FILE_EXISTS', 'PROJECT_ACCESS_DENIED', 'PROJECT_LOCATION_REJECTED', 'PROJECT_COPY_SOURCE_CHANGED', 'PROJECT_INVALID', 'PROJECT_COPY_INVALID'].includes(error.code) ||
      error.code === 'PROJECT_ENTRY_BUSY' && (error.status === 409 || error.status === 503) || action === 'copyTo' && error.code === 'PROJECT_HOST_BUSY' && error.status === 409 || unavailableSelection(error, mutation) || expiredTicket(error));
  function retireWrites(): boolean {
    const pending = [...dispatchedWrites, ...(retryIntent ? [retryIntent] : [])].filter(intent => !intent.acknowledged && !intent.retired);
    for (const intent of pending) {intent.retired = true; retiredWrites.add(intent);}
    if (pending.length) {
      const action = pending[pending.length - 1].action;
      // Keep the exact work/input closure, but never give it to a replacement
      // generation's retry button. A late ACK cannot retire this close risk.
      retry = null; retryIntent = null;
      emit({blocked: true, busy: false, capabilities: null, risks: [], action: {kind: 'unknown', action},
        ...(action === 'chooseLocation' ? {createState: {kind: 'unknown'} as const} : {})});
    }
    return retiredWrites.size > 0;
  }
  function retireOwner(cause: 'quit' | 'lost' = 'lost') {
    if (cause === 'lost') retiredForQuit = false;
    else if (!state.blocked) retiredForQuit = true;
    const blocked = state.blocked; retireWrites();
    if (!blocked) {
      generation++; initialization = null; pendingOpen = null; pendingTake = null; pendingPresentation = null; pendingEditor = null;
      releasePending?.(); releasePending = null;
      emit({blocked: true, busy: false, capabilities: null, risks: [],
        ...(!retiredWrites.size ? {action: {kind: 'idle'} as const, ...(state.createState.kind === 'creating' ? {createState: {kind: 'editing'} as const} : {})} : {})});
    }
  }
  function subscribePending() {
    const serial = generation;
    releasePending = client.subscribePendingOpen?.(() => {if (current(serial)) {pendingHint++; void drainPendingOpen(serial);}}) ?? null;
  }
  function recoverAfterQuit() {
    if (!active || !retiredForQuit || !isCurrent() || identity.getState().identityBlocked || retiredWrites.size) return false;
    retiredForQuit = false;
    generation++;
    pendingHint = 1;
    consumedHint = 0;
    // Draft text and a known create receipt can survive. Picker tickets and
    // failure actions belong to the retired generation.
    emit({blocked: false, selection: null, selectionInvalid: false, failure: null});
    subscribePending();
    return true;
  }
  function fail(error: unknown, context: 'open' | 'create' = 'open', projectId?: string) {
    if (!current()) return;
    const registered = identity.getState().snapshot?.registered.find(row => row.project.projectId === projectId)?.project;
    const projectFile = registered?.projectFile ?? null;
    const parsed = projectEntryOpenFailureSchema.safeParse(error);
    const known = parsed.success ? parsed.data : projectEntryOpenFailure(error, projectId);
    const issue: ProjectOpenIssue = {...(known ?? {code: 'OPEN_UNAVAILABLE'}), projectFile, projectId: projectId ?? null,
      ...(known?.code === 'PROJECT_ACCESS_DENIED' ? {context} : {})};
    emit({failure: {issue, name: registered?.name ?? (context === 'create' ? state.values.name : null), ...(projectId ? {projectId} : {})}});
  }
  function result(value: ProjectDesktopOpenResult, serial = generation): boolean {
    if (!current(serial)) return false;
    if (value.status === 'cancelled') return false;
    if (value.status === 'opened') {emit({failure: null, action: {kind: 'idle'}}); onOpened(); return true;}
    if (value.expiresAt !== undefined && now() >= value.expiresAt) return false;
    const issue: ProjectOpenIssue = value.status === 'copy'
      ? {code: 'PROJECT_FILE_COPY', projectFile: null, projectId: null, originalProjectFile: value.original?.displayPath ?? null, originalProjectId: null}
      : value.reason === 'network' ? {code: 'NETWORK_LOCATION', projectFile: value.displayPath, projectId: null}
        : {code: 'PROJECT_INVALID', projectFile: value.displayPath, projectId: null, reason: 'read-only'};
    emit({failure: {issue, name: value.name, token: value.token}, selectionInvalid: false, action: {kind: 'idle'}}); return false;
  }
  async function run(action: ProjectOpenFailureAction, work: (dispatched: () => void) => Promise<boolean>, {write = false, preserveDraft = false, replay = false, projectId, mutation, after}: {write?: boolean | (() => boolean); preserveDraft?: boolean; replay?: boolean; projectId?: string; mutation?: Mutation; after?: (permit?: () => boolean) => Promise<void>} = {}): Promise<boolean> {
    if (!startable() || state.busy || retry && !replay) return false;
    const serial = generation, previousRetry = retry, previousIntent = retryIntent;
    const resume = () => run(action, work, {write, preserveDraft: true, replay: true, projectId, mutation, after});
    let intent: WriteIntent | null = null;
    const dispatched = () => {if (!intent) {intent = {action, resume, acknowledged: false, retired: false}; dispatchedWrites.add(intent);}};
    let completed = false, grant: (() => boolean) | undefined; emit({busy: true, action: {kind: 'working', action}});
    try {
      const approved = await beforeAction(preserveDraft);
      if (!current(serial)) return false;
      if (!canStart()) {emit({action: previousIntent ? {kind: 'unknown', action} : {kind: 'idle'}}); return false;}
      if (!approved) {emit({action: previousIntent ? {kind: 'unknown', action} : {kind: 'idle'}}); return false;}
      grant = typeof approved === 'function' ? approved : undefined;
      if (grant && !grant()) {emit({action: previousIntent ? {kind: 'unknown', action} : {kind: 'idle'}}); return false;}
      const scope = identity.getVerifiedScope(), instance = identity.getState().instanceId;
      if (!scope || !instance) {emit({action: previousIntent ? {kind: 'unknown', action} : {kind: 'idle'}}); return false;}
      const value = await work(dispatched);
      if (!current(serial) || !scope || identity.getVerifiedScope() !== scope || identity.getState().instanceId !== instance) return false;
      for (const recorded of [...dispatchedWrites, ...(previousIntent ? [previousIntent] : [])]) if (!recorded.retired) recorded.acknowledged = true;
      retry = null; retryIntent = null; completed = value; emit({action: {kind: 'idle'}}); return value;
    } catch (error) {
      if (!current(serial)) return false;
      const recorded = [...dispatchedWrites].find(value => value === intent);
      if (previousIntent) {
        // A replay may be refused before main reaches its operation cache.
        // That refusal cannot settle the earlier write's unknown outcome.
        retry = previousRetry; retryIntent = previousIntent;
        emit({action: {kind: 'unknown', action}, ...(action === 'chooseLocation' ? {createState: {kind: 'unknown'} as const} : {})});
      } else if (recorded && !rejected(error, action, mutation)) {
        retry = resume; retryIntent = recorded;
        emit({action: {kind: 'unknown', action}, ...(action === 'chooseLocation' ? {createState: {kind: 'unknown'} as const} : {})});
        if (!state.failure && action !== 'chooseLocation') fail(error, 'open', projectId);
      } else {
        if (recorded) recorded.acknowledged = true;
        retry = null; retryIntent = null;
        const invalidSelection = unavailableSelection(error, mutation);
        emit({action: {kind: 'error', action}, ...(invalidSelection ? {selectionInvalid: true, ...(mutation === 'createAtSelection' ? {selection: null} : {})} : {})});
        if (expiredTicket(error) && !invalidSelection && state.failure) {
          // The host proved this token was rejected before a backend dispatch.
          // Keep the opening issue, but stop offering its dead authority.
          const {token: _token, ...failure} = state.failure;
          emit({failure: {...failure, entryExpired: true}, selectionInvalid: false});
        } else if (invalidSelection && mutation === 'createAtSelection') emit({failure: null});
        else if (invalidSelection && mutation === 'copyTo') emit({failure: {issue: {code: 'OPEN_UNAVAILABLE', projectId: null, projectFile: null}, name: state.failure?.name ?? null, reselect: 'open-file'}});
        else {
          fail(error, state.createOpen ? 'create' : 'open', projectId);
          if (invalidSelection && mutation === 'duplicate' && state.failure) emit({failure: {...state.failure, reselect: 'duplicate'}});
        }
      }
      return false;
    } finally {
      if (serial === generation && !current(serial)) retireWrites();
      const recorded = [...dispatchedWrites].find(value => value === intent);
      if (recorded) dispatchedWrites.delete(recorded);
      if (active && serial === generation) {
        if (retiredWrites.size) emit({busy: false});
        else {
          emit({busy: false, ...(!current(serial) ? {action: {kind: 'idle'} as const} : {})});
          if (completed && current(serial) && after) {
            // Hiding suspends presentation, not the admitted write. Retain its
            // exact receipt and consent; reveal may finish opening, never replay.
            if (canStart()) await after(grant);
            else pendingOpen = {generation: serial, resume: () => after(grant)};
          }
          void drainPendingOpen(serial);
        }
      }
    }
  }
  function presentPendingOpen() {
    const pending = pendingPresentation;
    if (!pending) return;
    if (!pending.valid()) {pendingPresentation = null; return;}
    if (!current(pending.generation) || pendingEditor !== false || !canStart() || state.busy || retry || state.createOpen || pendingOpen) return;
    pendingPresentation = null; result(pending.value, pending.generation);
  }
  function drainPendingOpen(serial = generation): Promise<void> {
    presentPendingOpen();
    const ready = () => current(serial) && pendingEditor === false && canStart() && Boolean(state.capabilities?.ready && state.capabilities.open) &&
      !state.busy && !retry && !state.createOpen && !pendingOpen && !pendingPresentation && pendingHint > consumedHint;
    if (!ready()) return Promise.resolve();
    if (pendingTake?.generation === serial) return pendingTake.promise;
    const flight = {generation: serial, promise: Promise.resolve()}; let taken = false;
    // Subscribe before boot, then coalesce hints from the same turn. A hint
    // received during a take remains newer than this flight's captured hint.
    flight.promise = Promise.resolve().then(async () => {
      if (!ready()) return;
      const hint = pendingHint;
      await run('retry', async () => {
        const scope = identity.getVerifiedScope(), instance = identity.getState().instanceId;
        const pending = await client.takePendingOpen();
        const valid = () => current(serial) && identity.getVerifiedScope() === scope && identity.getState().instanceId === instance;
        if (!valid()) return false;
        consumedHint = hint; taken = true;
        // Taking is a read, not a write intent. If presentation was hidden while
        // IPC was in flight, retain only this DTO and its original expiry.
        if (pending !== null && !canStart()) {pendingPresentation = {generation: serial, valid, value: pending}; return false;}
        return pending !== null ? result(pending, serial) : false;
      });
    }).finally(() => {
      if (pendingTake !== flight) return;
      pendingTake = null;
      // A declined departure or failed read must wait for an explicit resume
      // or another notification, rather than reopening consent in a loop.
      if (taken && pendingHint > consumedHint) void drainPendingOpen(serial);
    });
    pendingTake = flight; return flight.promise;
  }
  async function initializeOwner(editor: boolean, serial: number, owns: () => boolean) {
    if (!owns()) return;
    try {
      await readProjectEntryIdentity(identity);
      if (!owns()) return;
      const capabilities = await client.capabilities();
      if (!owns()) return;
      emit({capabilities: {...capabilities, saveAs: false}});
      if (editor && capabilities.ready && capabilities.locationFacts) {
        const location = await client.currentLocation();
        if (owns() && !dismissedRisk) emit({risks: projectLocationRisks(location.facts).filter((risk): risk is OpenedProjectLocationRisk => risk.kind !== 'network')});
      }
      if (!editor && capabilities.ready && capabilities.open) await drainPendingOpen(serial);
    } catch {if (owns()) emit({capabilities: null});}
  }
  function initialize(editor: boolean): Promise<void> {
    if (!current()) return Promise.resolve();
    pendingEditor = editor;
    if (initialization?.generation === generation) return initialization.promise;
    const flight = {generation, promise: Promise.resolve()};
    const owns = () => initialization === flight && current(flight.generation);
    // Boot, reveal and explicit refresh share this one owner. In particular a
    // disposed StrictMode boot cannot supersede the next mount's discovery.
    flight.promise = Promise.resolve().then(() => initializeOwner(editor, flight.generation, owns)).finally(() => {if (initialization === flight) initialization = null;});
    initialization = flight; return flight.promise;
  }
  async function openFile() {
    const serial = generation;
    if (!state.capabilities?.ready || !state.capabilities.open) return false;
    return run('retry', async () => {
      // A retained failure dialog must not cover the selected project's
      // pending open and its cancellation action.
      const previous = state.failure;
      if (previous) emit({failure: null});
      const opened = await client.openSelectedFile();
      if (opened.status === 'cancelled' && previous && current(serial)) emit({failure: previous});
      return result(opened, serial);
    });
  }
  async function chooseLocation() {
    if (!editable() || !state.capabilities?.ready || !state.capabilities.create) return false;
    const serial = generation;
    return run('chooseLocation', async () => {
      const selection = await client.chooseLocation({purpose: 'create', suggestedName: state.values.name.trim() || 'Mioon', message: message()});
      if (!selection || !current(serial)) return false; emit({selection, selectionInvalid: false, failure: null}); return true;
    }, {preserveDraft: true});
  }
  async function create() {
    if (!editable() || !state.capabilities?.ready || !state.capabilities.create || !state.selection || !state.selection.facts.isLocal || state.selection.facts.volumeReadOnly) return false;
    const selection = state.selection, values = state.values, serial = generation;
    const input = {token: selection.token, name: values.name.trim(), description: values.description, timelinePresetId: values.presetId, createFolder: values.createFolder};
    if (!projectEntryDesktopRequestSchema.safeParse({action: 'createAtSelection', ...input}).success || values.description.length > 500) return false;
    emit({createState: {kind: 'creating'}});
    const success = await run('chooseLocation', async dispatched => {
      dispatched();
      const created = await client.createAtSelection(input);
      if (!current(serial)) return false; knownCreated = created.project.projectId;
      emit({createState: {kind: 'created', projectName: created.project.name}}); return true;
    }, {write: true, mutation: 'createAtSelection', preserveDraft: true, after: async grant => {if (knownCreated) {const opened = await openCreated(knownCreated, grant); if (opened && current(serial)) emit({createOpen: false});}}});
    if (!success && !retry && current(serial)) emit({createState: {kind: 'error', code: 'unknown'}});
    return success;
  }
  async function copy(kind: 'duplicate' | 'copy-to', projectId?: string) {
    if (!state.capabilities?.ready || kind === 'duplicate' && !state.capabilities.duplicate || kind === 'copy-to' && !state.capabilities.copyTo) return false;
    const failure = state.failure, sourceToken = failure?.token, serial = generation;
    if (kind === 'copy-to' && (!sourceToken || !(failure?.issue.code === 'NETWORK_LOCATION' || failure?.issue.code === 'PROJECT_INVALID' && failure.issue.reason === 'read-only'))) return false;
    let exact: {token: string; requestId: string; name?: string} | null = null;
    let copiedId: string | null = null;
    let dispatched = false;
    const success = await run('copyTo', async markDispatched => {
      if (!exact) {
        const name = kind === 'copy-to' ? failure?.name : identity.getState().snapshot?.registered.find(row => row.project.projectId === projectId)?.project.name;
        if (!name) return false;
        const selection = await client.chooseLocation({purpose: kind, suggestedName: name, message: message()});
        if (!selection || !current(serial)) return false;
        exact = {token: selection.token, requestId: newId()}; emit({selectionInvalid: false});
      }
      dispatched = true;
      markDispatched();
      const copied = projectCopyResponseSchema.parse(kind === 'copy-to' ? await client.copyTo({...exact, sourceToken: sourceToken!}) : await client.duplicate({...exact, projectId: projectId!}));
      if (!current(serial)) return false;
      if (copied.requestId !== exact.requestId || kind === 'duplicate' && copied.sourceProjectId !== projectId) throw new Error('Invalid copy acknowledgement');
      copiedId = copied.project.projectId; emit({failure: null}); return true;
    }, {write: () => dispatched, mutation: kind === 'duplicate' ? 'duplicate' : 'copyTo', projectId, after: async grant => {if (copiedId && !await openCreated(copiedId, grant) && current(serial)) emit({failure: {issue: {code: 'OPEN_UNAVAILABLE', projectId: copiedId, projectFile: null}, name: null, projectId: copiedId}});}});
    return success;
  }
  let release: (() => void) | null = null;
  const tokenAction = (kind: 'openOriginal' | 'adoptCopy') => {
    const token = state.failure?.token, serial = generation;
    if (!token || !state.capabilities?.ready || !state.capabilities[kind] || state.failure?.issue.code !== 'PROJECT_FILE_COPY' || kind === 'openOriginal' && !state.failure.issue.originalProjectFile) return Promise.resolve(false);
    return run(kind, async dispatched => {if (kind === 'adoptCopy') dispatched(); return result(await client[kind]({token}), serial);}, {write: kind === 'adoptCopy', ...(kind === 'adoptCopy' ? {mutation: 'adoptCopy'} : {})});
  };
  return {
    activate() {if (!active) {
      active = true; generation++; pendingEditor = null; pendingHint = 1; consumedHint = 0;
      release = identity.subscribe(() => {if (identity.getState().identityBlocked && !state.blocked) retireOwner();});
      subscribePending();
    }},
    dispose() {const retired = retireWrites(); if (!retired) emit({busy: false, action: {kind: 'idle'}, ...(state.createState.kind === 'creating' ? {createState: {kind: 'editing'} as const} : {})}); active = false; generation++; initialization = null; pendingOpen = null; pendingTake = null; pendingPresentation = null; pendingEditor = null; releasePending?.(); releasePending = null; release?.(); release = null;},
    retireOwner, recoverAfterQuit,
    observeAvailability() {if (active && !isCurrent() && (dispatchedWrites.size || retryIntent)) retireOwner();},
    initialize, getState: () => state, subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
    showCreate() {if (!startable() || state.busy || retry || !state.capabilities?.ready || !state.capabilities.create) return false;
      if (knownCreated && !state.createOpen) {knownCreated = null; draftVersion++; emit({values: {name: '', description: '', presetId: DEFAULT_TIMELINE_OUTPUT_PRESET, createFolder: true}, selection: null, selectionInvalid: false, createState: {kind: 'editing'}});}
      emit({createOpen: true}); return true;},
    change(patch: Partial<NewProjectFileValues>) {if (editable()) {draftVersion++; emit({values: {...state.values, ...patch}});}},
    closeCreate() {if (startable() && !state.busy && !retry) {emit({createOpen: false}); void drainPendingOpen();}},
    closeFailure() {if (startable() && !state.busy && !retry) {emit({failure: null, action: {kind: 'idle'}, ...(!state.createOpen ? {selectionInvalid: false} : {})}); void drainPendingOpen();}},
    openFile, chooseLocation, create, duplicate: (id: string) => copy('duplicate', id), copyTo: () => copy('copy-to'),
    retryFailure: async () => {const failure = state.failure; if (!startable() || state.busy || retry) return false;
      if (failure?.reselect === 'open-file') return openFile();
      if (failure?.reselect === 'duplicate') return copy('duplicate', failure.projectId);
      if (!failure?.projectId) return openFile();
      const opened = await openCreated(failure.projectId); if (opened && current() && state.failure === failure) emit({failure: null}); return opened;},
    retryOpen: async () => {if (!knownCreated || !startable() || state.busy) return false; const serial = generation; const opened = await openCreated(knownCreated); if (opened && current(serial)) emit({createOpen: false}); return opened;},
    resumeKnownOpen: async (editor = false) => {
      if (!current() || !canStart()) return;
      const serial = generation;
      // Hidden boot keeps its first hint; later OS notifications use the same
      // serial drain without rereading or replaying an unknown write.
      if (!editor) {pendingEditor = false; if (!state.capabilities) await initialize(false); else await drainPendingOpen();}
      const pending = pendingOpen; if (!pending || pending.generation !== serial || !current(serial) || !canStart()) return; pendingOpen = null; await pending.resume(); void drainPendingOpen(serial);
    },
    getDraftVersion: () => draftVersion,
    recheck: async () => retry ? retry() : false,
    openPrivacySettings: () => state.capabilities?.ready && state.capabilities.help ? run('systemSettings', async () => {await client.openPrivacySettings(); return true;}, {preserveDraft: true}) : Promise.resolve(false),
    reveal: (id?: string) => state.capabilities?.ready && state.capabilities.reveal && (id || state.failure?.token) ? run('reveal', async () => {await client.reveal(id ? {projectId: id} : {token: state.failure!.token!}); return true;}, {preserveDraft: true, projectId: id}) : Promise.resolve(false),
    openOriginal: () => tokenAction('openOriginal'), adoptCopy: () => tokenAction('adoptCopy'),
    observeError: fail,
    dismissRisk() {dismissedRisk = true; emit({risks: []});},
    bridge: client,
    readCloseSnapshot() {return {dirty: !knownCreated && Boolean(state.values.name || state.values.description), busy: state.busy, unknown: Boolean(retry) || retiredWrites.size > 0, identity: [generation, state.createOpen, state.values, state.selection?.token, knownCreated, state.action, retiredWrites.size]};},
  };
}
export type NativeProjectDesktopController = ReturnType<typeof createNativeProjectDesktopController>;

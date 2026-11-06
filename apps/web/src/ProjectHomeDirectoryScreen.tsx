import React, {useEffect, useRef, useState} from 'react';
import type {ReactElement} from 'react';
import {useConfirmation} from '@mioon/ui/components/workbench-confirm';
import ProjectHome from './ProjectHome.tsx';
import type {ProjectHomeProps, ProjectHomeCreateState} from './ProjectHome.tsx';
import {RecentProjectsView} from './project-file/RecentProjects.tsx';
import {waitingProjects} from './project-file/recent-project-view.ts';
import type {WaitingProject} from './project-file/recent-project-view.ts';
import type {ViewState} from './project-file/types.ts';
import {createProjectEntryDirectoryController} from './project-entry-directory-state.ts';
import type {ProjectEntryDirectoryReadPort} from './project-entry-directory-state.ts';
import {createProjectHomeBackgroundController} from './project-home-background-state.ts';
import type {HomeBackgroundReadInput} from './project-home-background-state.ts';
import type {ProjectHomeNativeActions, ProjectHomeNativeActionMetadata} from './project-home-native-actions-state.ts';
import {createProjectHomeNativeActionsController} from './project-home-native-actions-state.ts';
import {ProjectHomeNativeActionsView} from './project-home-native-actions.tsx';
import {createProjectHomeBackgroundClient} from './project-home-background-client.ts';
import {useUiPreferences} from './UiPreferencesProvider.tsx';
import {useI18n} from './i18n/I18nProvider.tsx';
import './project-home-redesign.css';

export interface ProjectHomeDirectoryScreenProps extends Omit<ProjectHomeProps, 'onOpen' | 'onRetry' | 'onRefresh'> {
  readonly summaryEnabled?: boolean;
  readonly summaryScope?: string;
  readonly openingProjectId?: string | null;
  readonly presentation?: 'page' | 'embedded';
  /** Native entry owns both departure consent and the fresh directory check. */
  readonly parentGuardsDeparture?: boolean;
  readonly catalogReady?: boolean;
  readonly onOpen: (projectId: string) => void | Promise<boolean>;
  readonly onRetry: () => void | Promise<boolean>;
  readonly onRefresh: () => void | Promise<unknown>;
  readonly onUnauthorized?: () => void;
  readonly onOpenFile?: () => void;
  readonly onHelpAccess?: () => void;
  readonly onCopy?: (projectId: string) => void;
  readonly onReveal?: (projectId: string) => void;
  readonly nativeActions?: ProjectHomeNativeActions;
  readonly onNativeActionStateChange?: (state: ProjectHomeNativeActionMetadata) => void;
  /** Consent is acquired before the action reports its own busy latch; the
   * returned predicate rechecks that same retained native input owner. */
  readonly onPrepareNativeAction?: () => Promise<(() => boolean) | null>;
  /** A renewed, explicit consent for this exact retained home unknown version.
   * The parent keeps every other native/identity/lease guard in force. */
  readonly onPrepareNativeRecheck?: (expectedHomeVersion: number) => Promise<(() => boolean) | null>;
  readonly onOpenNativeResult?: (projectId: string, permit: () => boolean) => Promise<boolean>;
  readonly openedProjectIds?: readonly string[];
  /** Alternate read ports are capabilities, not user-selectable URL/path modes. */
  readonly readDirectory?: ProjectEntryDirectoryReadPort;
  readonly readBackgroundPage?: (input: HomeBackgroundReadInput) => Promise<unknown>;
}

const verifiedScope = (value: string | undefined): string | null => value && /^[a-f0-9]{64}$/u.test(value) ? value : null;

/** The trusted server channel determines directory scope: web's configured
 * root or desktop's complete recent registrations. Navigation keeps its owner. */
export default function ProjectHomeDirectoryScreen(props: ProjectHomeDirectoryScreenProps): ReactElement {
  const {t} = useI18n(), preferences = useUiPreferences(), confirm = useConfirmation();
  const [, rerender] = useState(0), [query, setQuery] = useState(''), [createIntent, setCreateIntent] = useState(0);
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const current = useRef(props), mounted = useRef(false), visibility = useRef(visible), lifetime = useRef(0), reads = useRef(0);
  const opening = useRef<object | null>(null), [openingBusy, setOpeningBusy] = useState(false);
  const preparingNative = useRef(false);
  const form = useRef<ProjectHomeCreateState>({dirty: false, busy: false, version: 0});
  const forwardedCreateIntent = useRef(0);
  current.current = props;
  const reportCreate = useRef((next: ProjectHomeCreateState): void => {
    form.current = next; current.current.onCreateStateChange?.(next);
  }).current;
  const active = (): boolean => mounted.current && visibility.current && current.current.active !== false &&
    current.current.summaryEnabled !== false && current.current.page === 'projects';
  const [backgroundClient] = useState(() => createProjectHomeBackgroundClient());
  const [directory] = useState(() => createProjectEntryDirectoryController({
    ...(props.readDirectory ? {read: input => current.current.readDirectory!(input)} : {}),
    expectedScope: () => verifiedScope(current.current.summaryScope),
    onChange: () => {if (mounted.current) rerender(value => value + 1);},
  }));
  const [background] = useState(() => createProjectHomeBackgroundController({
    readPage: async input => {
      try {return await (current.current.readBackgroundPage ?? backgroundClient.list)(input);}
      catch (error) {
        if (!input.signal.aborted && active() && ready() && (error as {status?: number})?.status === 401) current.current.onUnauthorized?.();
        throw error;
      }
    },
    onChange: () => {if (mounted.current) rerender(value => value + 1);},
  }));
  const [native] = useState(() => createProjectHomeNativeActionsController({
    ports: () => current.current.nativeActions,
    owner: () => {
      const state = ready();
      return active() && current.current.catalogReady !== false && state?.snapshot ? {appLibraryScope: state.snapshot.appLibraryScope, instanceId: state.snapshot.instanceId, epoch: state.epoch} : null;
    },
    canStart: () => baseCanAct(),
    readDirectory: async () => {
      reads.current++; background.invalidate();
      if (!await directory.refresh()) {
        if (active() && directory.getState().error?.status === 401) current.current.onUnauthorized?.();
        throw Error('Unable to verify application directory');
      }
      const snapshot = ready()?.snapshot;
      if (!snapshot) throw Error('Application directory identity changed');
      return snapshot;
    },
    onChange: (_state, metadata) => {
      current.current.onNativeActionStateChange?.(metadata);
      if (mounted.current) rerender(value => value + 1);
    },
    onRefresh: async () => {
      if (!active()) return;
      reads.current++; background.invalidate();
      if (!await directory.refresh() || !active()) return;
      const state = ready();
      if (state?.snapshot) await background.refresh({...state.snapshot, epoch: state.epoch});
      if (active()) await current.current.onRefresh();
    },
    onOpenCreated: async projectId => (await current.current.onOpen(projectId)) !== false,
    onOpenNativeResult: (projectId, permit) => current.current.onOpenNativeResult?.(projectId, permit) ?? Promise.resolve(false),
  }));
  function ready() {
    const state = directory.getState(), expected = verifiedScope(current.current.summaryScope);
    return state.phase === 'ready' && state.snapshot && (expected === null || expected === state.snapshot.appLibraryScope) ? state : null;
  }
  const baseCanAct = (): boolean => active() && !opening.current && !form.current.busy && !current.current.busy && current.current.phase !== 'opening' &&
    current.current.catalogReady !== false && current.current.canMutateEntry?.() !== false && ready() !== null;
  const canAct = (): boolean => baseCanAct() && !preparingNative.current && (native.getState().kind === 'idle' || native.getMetadata().allowOpen === true);
  async function reload(notifyParent = false): Promise<void> {
    if (!active() || opening.current || form.current.busy || current.current.busy || current.current.phase === 'opening' || directory.getState().phase === 'loading') return;
    const owner = lifetime.current, serial = ++reads.current;
    background.invalidate();
    if (!await directory.refresh() || !active() || owner !== lifetime.current || serial !== reads.current) {
      if (active() && owner === lifetime.current && serial === reads.current && directory.getState().error?.status === 401) current.current.onUnauthorized?.();
      return;
    }
    if (notifyParent) {
      await current.current.onRefresh();
      if (!active() || owner !== lifetime.current || serial !== reads.current) return;
    }
    const verified = ready();
    if (verified?.snapshot) await background.refresh({...verified.snapshot, epoch: verified.epoch});
  }
  const reloadRef = useRef(reload); reloadRef.current = reload;
  useEffect(() => {
    const changed = (): void => {
      visibility.current = document.visibilityState !== 'hidden';
      if (!visibility.current) {lifetime.current++; reads.current++; background.invalidate(); directory.dispose();}
      setVisible(visibility.current);
    };
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, [directory, background]);
  const enabled = visible && props.active !== false && props.summaryEnabled !== false && props.page === 'projects';
  useEffect(() => {
    if (!enabled) return;
    mounted.current = true; lifetime.current++; directory.activate(); background.activate(); native.activate();
    opening.current = null; setOpeningBusy(false);
    void reloadRef.current();
    const focus = (): void => {void reloadRef.current();};
    window.addEventListener('focus', focus);
    return () => {
      mounted.current = false; lifetime.current++; reads.current++; opening.current = null;
      native.dispose(); directory.dispose(); background.dispose(); window.removeEventListener('focus', focus);
    };
  }, [enabled, props.summaryScope, directory, background, native]);
  async function nativeAction(action: 'trash' | 'example' | 'recheck', projectId?: string): Promise<void> {
    const recheck = action === 'recheck';
    if (recheck && !native.canRecheckTrash()) return;
    if (!recheck && native.getState().kind !== 'idle') return;
    if (preparingNative.current || (recheck ? !active() || Boolean(opening.current) || form.current.busy || current.current.phase === 'opening' : !canAct())) return;
    const owner = lifetime.current, observedForm = form.current, formVersion = form.current.version;
    preparingNative.current = true; setOpeningBusy(true);
    try {
      // This is the original dispatched intent, not a new departure. Its live
      // authority still checks the page, parent input, owner and lease.
      if (recheck && native.canRecheckRetained()) {await native.recheckRetained(); return;}
      const prepare = current.current.onPrepareNativeAction;
      const parentPermit = recheck ? await current.current.onPrepareNativeRecheck?.(native.getMetadata().version) ?? null
        : prepare ? await prepare() : observedForm.dirty && !await confirm(t('projects.keepCreateOpen')) ? null : () => true;
      if (!parentPermit) return;
      const permit = (): boolean => active() && owner === lifetime.current && form.current.version === formVersion && !form.current.busy && current.current.phase !== 'opening' && parentPermit();
      if (!permit()) return;
      if (action === 'trash' && projectId) await native.prepareTrash(projectId, permit);
      else if (action === 'example') await native.startExample(t('projectHomeNative.example.storage'), t('projectHomeNative.example.name'), permit, prepare ? parentPermit : undefined);
      else if (recheck) await native.recheck(permit);
    } catch {
      if (active() && owner === lifetime.current) native.rejectPreparation(action === 'example');
    } finally {
      preparingNative.current = false;
      if (mounted.current && owner === lifetime.current) setOpeningBusy(false);
    }
  }
  async function open(projectId: string, retry = false): Promise<boolean> {
    if (!canAct()) return false;
    const flight = {}, owner = lifetime.current, observedForm = form.current;
    opening.current = flight; setOpeningBusy(true);
    try {
      if (!current.current.parentGuardsDeparture && observedForm.dirty && !await confirm(t('projects.keepCreateOpen'))) return false;
      if (!active() || owner !== lifetime.current || opening.current !== flight || form.current.version !== observedForm.version || form.current.busy) return false;
      if (current.current.parentGuardsDeparture) {
        // The native owner confirms first, then rereads its strictly pinned
        // directory before dispatch; a second local check would precede consent.
        const result = retry ? await current.current.onRetry() : await current.current.onOpen(projectId);
        return result !== false;
      }
      reads.current++; background.invalidate();
      // Revalidate the directory before dispatch. A stale card cannot borrow a
      // replacement application's project with the same UUID or its cache.
      const refreshed = await directory.refresh();
      if (!active() || owner !== lifetime.current || opening.current !== flight) return false;
      if (!refreshed) {if (directory.getState().error?.status === 401) current.current.onUnauthorized?.(); return false;}
      const verified = ready();
      if (!verified?.snapshot?.registered.some(entry => entry.project.projectId === projectId) ||
        current.current.busy || current.current.phase === 'opening' || current.current.canMutateEntry?.() === false) return false;
      void background.refresh({...verified.snapshot, epoch: verified.epoch});
      const result = retry ? await current.current.onRetry() : await current.current.onOpen(projectId);
      return result !== false;
    } finally {
      if (opening.current === flight) {opening.current = null; if (mounted.current && owner === lifetime.current) setOpeningBusy(false);}
    }
  }
  const state = directory.getState(), verified = ready(), snapshot = props.catalogReady === false ? null : verified?.snapshot ?? null;
  const expected = verifiedScope(props.summaryScope);
  const blocked = state.phase === 'blocked' || state.phase === 'ready' && state.snapshot && expected !== null && expected !== state.snapshot.appLibraryScope;
  useEffect(() => {
    const intent = props.createIntentVersion ?? 0;
    if (!Number.isSafeInteger(intent) || intent <= forwardedCreateIntent.current || !canAct()) return;
    forwardedCreateIntent.current = intent;
    setCreateIntent(value => value + 1);
  }, [enabled, props.createIntentVersion, snapshot, openingBusy, props.busy, props.phase]);
  const view = snapshot ? {kind: 'ready' as const, value: snapshot.registered}
    : blocked || state.phase === 'error' || props.catalogReady === false && props.listError ? {kind: 'error' as const, retryable: !blocked} : {kind: 'loading' as const};
  const taskState = background.getState();
  const sameIdentity = snapshot && taskState.identity && taskState.identity.appLibraryScope === snapshot.appLibraryScope &&
    taskState.identity.instanceId === snapshot.instanceId && taskState.identity.epoch === verified?.epoch;
  const waiting: ViewState<readonly WaitingProject[]> = sameIdentity && taskState.kind === 'ready'
    ? {kind: 'ready', value: waitingProjects(snapshot!.registered, taskState.tasks)}
    : sameIdentity && taskState.kind === 'error' ? {kind: 'error', retryable: true} : {kind: 'loading'};
  const nativeState = native.getState();
  const closedExampleUnknown = nativeState.kind === 'example-unknown' && nativeState.dialogHidden;
  const busy = props.busy || openingBusy || props.phase === 'opening' || nativeState.kind !== 'idle' && !closedExampleUnknown;
  const choose = (patch: Partial<typeof preferences.preferences>): void => {
    if (!canAct() || preferences.phase !== 'ready' || preferences.pending || preferences.dirty) return;
    preferences.edit(patch); void preferences.save();
  };
  const presentation = props.presentation ?? 'page';
  const exampleAvailable = props.nativeActions?.example?.bridge.instantiateTemplate && props.nativeActions.example.templates.some(template => template.id === 'timeline-basics' && template.version === 1);
  return <div className={`project-home-screen project-home-${presentation}`} data-presentation={presentation} data-view={preferences.preferences.homeView}><ProjectHome {...props} active={enabled} projects={props.projects} totalProjects={snapshot?.registered.length ?? 0}
    notice={closedExampleUnknown ? t('projectHomeNative.example.pendingWrites') : props.notice}
    busy={busy} query={query} onQuery={value => {if (canAct()) setQuery(value);}}
    onOpen={projectId => {void open(projectId);}}
    onRetry={() => {if (props.openingProjectId) void open(props.openingProjectId, true);}}
    onRefresh={() => {void reload(true);}} canMutateEntry={canAct}
    onCreateStateChange={reportCreate}
    onStartExample={closedExampleUnknown ? undefined : exampleAvailable ? snapshot ? () => {void nativeAction('example');} : undefined : props.onStartExample}
    createIntentVersion={createIntent}
    createDisabledReason={closedExampleUnknown ? t('projectHomeNative.example.pendingWrites') : props.createDisabledReason || (!snapshot ? t('projects.listUnavailable') : '')}
    catalog={<RecentProjectsView state={view} query={query} waiting={waiting} busy={busy || !enabled}
      sort={preferences.preferences.homeSort} view={preferences.preferences.homeView} now={new Date()}
      onSortChange={sort => choose({homeSort: sort})} onViewChange={homeView => choose({homeView})}
      onOpen={projectId => {void open(projectId);}} onRetry={() => {void reload(true);}}
      onOpenFile={!closedExampleUnknown && props.onOpenFile ? () => {if (canAct()) current.current.onOpenFile?.();} : undefined}
      onAccessHelp={!closedExampleUnknown && props.onHelpAccess ? () => {if (canAct()) current.current.onHelpAccess?.();} : undefined}
      onCopy={!closedExampleUnknown && props.onCopy ? projectId => {if (canAct()) current.current.onCopy?.(projectId);} : undefined}
      onReveal={!closedExampleUnknown && props.onReveal ? projectId => {if (canAct()) current.current.onReveal?.(projectId);} : undefined}
      onTrash={!closedExampleUnknown && props.nativeActions?.trash ? projectId => {void nativeAction('trash', projectId);} : undefined}
      openedProjectIds={props.openedProjectIds}
      onRetryWaiting={() => {void reload(true);}}
      onCreate={() => {if (canAct()) setCreateIntent(value => value + 1);}} />} />
    <ProjectHomeNativeActionsView state={nativeState} openedProjectIds={props.openedProjectIds}
      onClose={() => {native.close();}} onConfirmTrash={() => {void native.confirmTrash();}} onRecheck={() => {void nativeAction('recheck');}}
      onRefresh={() => {void native.refreshExample();}}
      onRetryOpen={() => {void native.retryOpen();}} onDismissNotice={() => native.dismissNotice()}
      onHelpAccess={props.onHelpAccess}
      onOpenProject={projectId => {if (native.close()) void open(projectId);}} />
  </div>;
}

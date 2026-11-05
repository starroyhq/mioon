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
import {createProjectHomeBackgroundClient} from './project-home-background-client.ts';
import {useUiPreferences} from './UiPreferencesProvider.tsx';
import {useI18n} from './i18n/I18nProvider.tsx';
import './project-home-redesign.css';

export interface ProjectHomeDirectoryScreenProps extends Omit<ProjectHomeProps, 'onOpen' | 'onRetry'> {
  readonly summaryEnabled?: boolean;
  readonly summaryScope?: string;
  readonly openingProjectId?: string | null;
  readonly onOpen: (projectId: string) => void | Promise<boolean>;
  readonly onRetry: () => void | Promise<boolean>;
  readonly onUnauthorized?: () => void;
  /** Alternate read ports are capabilities, not user-selectable URL/path modes. */
  readonly readDirectory?: ProjectEntryDirectoryReadPort;
  readonly readBackgroundPage?: (input: HomeBackgroundReadInput) => Promise<unknown>;
}

const verifiedScope = (value: string | undefined): string | null => value && /^[a-f0-9]{64}$/u.test(value) ? value : null;

/** Web's root-filtered directory. The native launcher keeps its existing
 * entry owner until the all-recent S6-B capability has actually shipped. */
export default function ProjectHomeDirectoryScreen(props: ProjectHomeDirectoryScreenProps): ReactElement {
  const {t} = useI18n(), preferences = useUiPreferences(), confirm = useConfirmation();
  const [, rerender] = useState(0), [query, setQuery] = useState(''), [createIntent, setCreateIntent] = useState(0);
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const current = useRef(props), mounted = useRef(false), visibility = useRef(visible), lifetime = useRef(0), reads = useRef(0);
  const opening = useRef<object | null>(null), [openingBusy, setOpeningBusy] = useState(false);
  const form = useRef<ProjectHomeCreateState>({dirty: false, busy: false, version: 0});
  const reportedProjects = useRef(props.projects);
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
  function ready() {
    const state = directory.getState(), expected = verifiedScope(current.current.summaryScope);
    return state.phase === 'ready' && state.snapshot && (expected === null || expected === state.snapshot.appLibraryScope) ? state : null;
  }
  const canAct = (): boolean => active() && !opening.current && !form.current.busy && !current.current.busy && current.current.phase !== 'opening' &&
    current.current.canMutateEntry?.() !== false && ready() !== null;
  async function reload(): Promise<void> {
    if (!active() || opening.current || form.current.busy || current.current.busy || current.current.phase === 'opening' || directory.getState().phase === 'loading') return;
    const owner = lifetime.current, serial = ++reads.current;
    background.invalidate();
    if (!await directory.refresh() || !active() || owner !== lifetime.current || serial !== reads.current) {
      if (active() && owner === lifetime.current && serial === reads.current && directory.getState().error?.status === 401) current.current.onUnauthorized?.();
      return;
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
    mounted.current = true; lifetime.current++; directory.activate(); background.activate();
    opening.current = null; setOpeningBusy(false);
    void reloadRef.current();
    const focus = (): void => {void reloadRef.current();};
    window.addEventListener('focus', focus);
    return () => {
      mounted.current = false; lifetime.current++; reads.current++; opening.current = null;
      directory.dispose(); background.dispose(); window.removeEventListener('focus', focus);
    };
  }, [enabled, props.summaryScope, directory, background]);
  useEffect(() => {
    if (reportedProjects.current === props.projects) return;
    reportedProjects.current = props.projects;
    if (enabled) void reloadRef.current();
  }, [props.projects]);

  async function open(projectId: string, retry = false): Promise<boolean> {
    if (!canAct()) return false;
    const flight = {}, owner = lifetime.current, observedForm = form.current;
    opening.current = flight; setOpeningBusy(true);
    try {
      if (observedForm.dirty && !await confirm(t('projects.keepCreateOpen'))) return false;
      if (!active() || owner !== lifetime.current || opening.current !== flight || form.current.version !== observedForm.version || form.current.busy) return false;
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
  const state = directory.getState(), verified = ready(), snapshot = verified?.snapshot ?? null;
  const blocked = state.phase === 'blocked' || state.phase === 'ready' && !snapshot;
  const view = snapshot ? {kind: 'ready' as const, value: snapshot.registered}
    : blocked || state.phase === 'error' ? {kind: 'error' as const, retryable: !blocked} : {kind: 'loading' as const};
  const taskState = background.getState();
  const sameIdentity = snapshot && taskState.identity && taskState.identity.appLibraryScope === snapshot.appLibraryScope &&
    taskState.identity.instanceId === snapshot.instanceId && taskState.identity.epoch === verified?.epoch;
  const waiting: ViewState<readonly WaitingProject[]> = sameIdentity && taskState.kind === 'ready'
    ? {kind: 'ready', value: waitingProjects(snapshot!.registered, taskState.tasks)}
    : sameIdentity && taskState.kind === 'error' ? {kind: 'error', retryable: true} : {kind: 'loading'};
  const busy = props.busy || openingBusy || props.phase === 'opening';
  const choose = (patch: Partial<typeof preferences.preferences>): void => {
    if (!canAct() || preferences.phase !== 'ready' || preferences.pending || preferences.dirty) return;
    preferences.edit(patch); void preferences.save();
  };
  return <div className="project-home-screen project-home-page" data-presentation="page" data-view={preferences.preferences.homeView}><ProjectHome {...props} active={enabled} projects={props.projects} totalProjects={snapshot?.registered.length ?? 0}
    busy={busy} query={query} onQuery={value => {if (canAct()) setQuery(value);}}
    onOpen={projectId => {void open(projectId);}}
    onRetry={() => {if (props.openingProjectId) void open(props.openingProjectId, true);}}
    onRefresh={() => {void reload();}} canMutateEntry={canAct}
    onCreateStateChange={reportCreate}
    createIntentVersion={createIntent}
    createDisabledReason={props.createDisabledReason || (!snapshot ? t('projects.listUnavailable') : '')}
    catalog={<RecentProjectsView state={view} query={query} waiting={waiting} busy={busy || !enabled}
      sort={preferences.preferences.homeSort} view={preferences.preferences.homeView} now={new Date()}
      onSortChange={sort => choose({homeSort: sort})} onViewChange={homeView => choose({homeView})}
      onOpen={projectId => {void open(projectId);}} onRetry={() => {void reload();}}
      onRetryWaiting={() => {void reload();}}
      onCreate={() => {if (canAct()) setCreateIntent(value => value + 1);}} />} /></div>;
}

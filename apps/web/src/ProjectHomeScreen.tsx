import React, { useCallback, useEffect, useRef, useState } from 'react';
import { WorkbenchIcon } from '@mioon/ui/components/workbench-icons';
import { Dialog } from '@mioon/ui/components/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@mioon/ui/components/dropdown-menu';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchAlert, WorkbenchButton, WorkbenchDialogContent, WorkbenchTabs } from '@mioon/ui/components/workbench-controls';
import { projectSummaryListSchema } from '../../../packages/contracts/src/project-home.ts';
import type { ProjectSummary } from '../../../packages/contracts/src/project-home.ts';
import { projectDeleteInputSchema, projectDeleteResponseSchema, projectRenameInputSchema } from '../../../packages/contracts/src/project-lifecycle.ts';
import type { ProjectDeleteInput, ProjectRenameInput } from '../../../packages/contracts/src/project-lifecycle.ts';
import ProjectHome from './ProjectHome.tsx';
import type { ProjectHomeCreateState, ProjectHomeProject, ProjectHomeProps } from './ProjectHome.tsx';
import { useUiPreferences } from './UiPreferencesProvider.tsx';
import { useI18n } from './i18n/I18nProvider.tsx';
import { browserRpc, BrowserRpcError } from './browser-rpc.ts';
import { parseLauncherProject } from './launcher-state.ts';
import { orderedHomeProjects } from './project-home-presentation.ts';
import { readWorkspaceInfo, revealWorkspaceLocation } from './workspace-info-client.ts';
import { WorkbenchSelect } from '@mioon/ui/components/workbench-select';
import ProjectPackageLayer, { useProjectPackageState } from './ProjectPackageLayer.tsx';
import { projectPackageFlow } from './project-package-flow.ts';
import type { DragEvent } from 'react';
import './project-home-redesign.css';

type Action = { kind: 'rename' | 'delete'; project: ProjectHomeProject; name: string; phase: 'editing' | 'busy' | 'unknown' | 'rejected' | 'cleanup'; input: ProjectRenameInput | ProjectDeleteInput | null };
export default function ProjectHomeScreen(props: ProjectHomeProps & { summaryEnabled?: boolean; active?: boolean; summaryScope?: string; presentation?: 'page' | 'embedded' }) {
  const { t, locale } = useI18n(), prefs = useUiPreferences();
  const [summaries, setSummaries] = useState<readonly ProjectSummary[]>([]), [summaryError, setSummaryError] = useState(false), [refresh, setRefresh] = useState(0), [query, setQuery] = useState(''), [loadedScope, setLoadedScope] = useState('');
  const [action, setAction] = useState<Action | null>(null), [location, setLocation] = useState(''), [locationError, setLocationError] = useState(false), [cleanupCount, setCleanupCount] = useState(0);
  const live = useRef(true), actionRef = useRef<Action | null>(action), current = useRef(props), form = useRef<ProjectHomeCreateState>({dirty:false,busy:false,version:0}), serial = useRef(0);
  actionRef.current = action; current.current = props;
  const packages = projectPackageFlow(), packageState = useProjectPackageState(packages), dragDepth = useRef(0), [dropping, setDropping] = useState(false);
  // Project files need the ordinary workspace, like rename and delete.
  const packagesAvailable = () => props.summaryEnabled !== false && !props.createDisabledReason && props.page === 'projects';
  const chooseFile = () => { if (canAct() && packagesAvailable()) packages.chooseImportFile(); };
  const importFile = (file: File | undefined) => { if (file && canAct() && packagesAvailable()) packages.openImport(file); };
  const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types || []).includes('Files');
  const drag = {
    onDragEnter: (event: DragEvent) => { if (!carriesFiles(event) || !packagesAvailable()) return; event.preventDefault(); dragDepth.current++; setDropping(true); },
    onDragOver: (event: DragEvent) => { if (!carriesFiles(event) || !packagesAvailable()) return; event.preventDefault(); event.dataTransfer.dropEffect = canAct() ? 'copy' : 'none'; },
    onDragLeave: (event: DragEvent) => { if (!carriesFiles(event)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDropping(false); },
    onDrop: (event: DragEvent) => { if (!carriesFiles(event)) return; event.preventDefault(); dragDepth.current = 0; setDropping(false); importFile(event.dataTransfer.files[0]); },
  };
  const canAct = () => live.current && current.current.active !== false && current.current.canMutateEntry?.() !== false && !current.current.busy && current.current.phase !== 'opening';
  const report = useCallback((state: ProjectHomeCreateState) => { form.current = state; current.current.onCreateStateChange?.({dirty:state.dirty, busy:state.busy || Boolean(actionRef.current && ['busy','unknown','cleanup'].includes(actionRef.current.phase)), version:++serial.current}); }, []);
  const publish = (next: Action | null) => { actionRef.current = next; setAction(next); report(form.current); };
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    if (props.summaryEnabled === false || props.active === false) return;
    let active = true; const abort = new AbortController(); setSummaryError(false);
    void browserRpc('project.summary.list', {}, {signal:abort.signal}).then((value: unknown) => { const parsed = projectSummaryListSchema.parse(value); if (active) { setSummaries(parsed); setLoadedScope(props.summaryScope || 'ordinary'); } }).catch(() => { if (active) setSummaryError(true); });
    return () => { active = false; abort.abort(); };
  }, [props.projects, props.summaryEnabled, props.active, props.summaryScope, refresh]);
  useEffect(() => { if (props.active === false || props.summaryEnabled === false) return; let active = true; const abort = new AbortController(); void readWorkspaceInfo(abort.signal).then(value => { if (active) setCleanupCount(value.pendingProjectCleanup); }).catch(() => {}); return () => { active = false; abort.abort(); }; }, [props.active, props.summaryEnabled, refresh]);
  const metadata = new Map((props.summaryEnabled !== false && loadedScope === (props.summaryScope || 'ordinary') ? summaries : []).map(project => [project.id, project]));
  const projects = props.projects.map(project => { const summary = metadata.get(project.id); if (!summary) return project; return {...summary, ...((project.revision || 0) >= summary.revision ? project : {}), updatedAt: summary.updatedAt > project.updatedAt ? summary.updatedAt : project.updatedAt}; });
  const ordered = orderedHomeProjects(projects, query, prefs.preferences.homeSort, locale);
  const locked = Boolean(action && ['busy','unknown','cleanup'].includes(action.phase));
  const refreshList = () => { setRefresh(value => value + 1); props.onRefresh(); };
  const choose = (patch: Partial<typeof prefs.preferences>) => { if (!canAct() || prefs.phase !== 'ready' || prefs.pending || prefs.dirty) return; prefs.edit(patch); void prefs.save(); };
  const openAction = (kind: Action['kind'], project: ProjectHomeProject) => { if (canAct() && !actionRef.current && props.summaryEnabled !== false && Number.isSafeInteger(project.revision) && (project.revision || 0) > 0) publish({kind,project,name:project.name,phase:'editing',input:null}); };
  async function submit() {
    const original = actionRef.current;
    if (!original || !canAct() || original.phase === 'busy' || original.phase === 'rejected') return;
    let input: ProjectRenameInput | ProjectDeleteInput;
    try { input = original.input ?? (original.kind === 'delete' ? projectDeleteInputSchema.parse({projectId:original.project.id,expectedRevision:original.project.revision,requestId:crypto.randomUUID(),confirmPermanentDeletion:true}) : projectRenameInputSchema.parse({projectId:original.project.id,expectedRevision:original.project.revision,requestId:crypto.randomUUID(),name:original.name.trim()})); } catch { publish({...original,phase:'rejected'}); return; }
    const attempt: Action = {...original,input,phase:'busy'}; publish(attempt);
    try {
      const response: unknown = await browserRpc(original.kind === 'delete' ? 'project.delete' : 'project.rename', input);
      if (original.kind === 'delete') { const next = projectDeleteResponseSchema.parse(response); if (next.projectId !== input.projectId || next.requestId !== input.requestId) throw new TypeError('Mismatched project operation.'); if (live.current && actionRef.current === attempt) { if (next.cleanup === 'pending') publish({...attempt,phase:'cleanup'}); else publish(null); refreshList(); } }
      else { const next = parseLauncherProject(response); if (!('name' in input) || next.id !== input.projectId || next.name !== input.name || next.revision !== input.expectedRevision + 1) throw new TypeError('Mismatched project operation.'); if (live.current && actionRef.current === attempt) { publish(null); refreshList(); } }
    } catch (error) { if (live.current && actionRef.current === attempt) publish({...attempt,phase:error instanceof BrowserRpcError && error.definitive ? 'rejected' : 'unknown'}); }
  }
  const menu = (project: ProjectHomeProject) => <DropdownMenu><DropdownMenuTrigger render={<WorkbenchButton variant="icon" aria-label={t('redesign.projects.more')} data-testid={`project-home-more-${project.id}`} disabled={props.busy || locked || props.phase === 'opening'} />}><WorkbenchIcon name="more" /></DropdownMenuTrigger><DropdownMenuContent>
    <DropdownMenuItem disabled={props.summaryEnabled === false || !project.revision} onClick={() => openAction('rename', project)}>{t('redesign.projects.rename')}</DropdownMenuItem>
    <DropdownMenuItem data-testid={`project-home-duplicate-${project.id}`} disabled={!packagesAvailable()} onClick={() => { if (canAct() && packagesAvailable()) packages.openDuplicate({id:project.id,name:project.name}, t('projectPackage.duplicate.defaultName', {name:project.name})); }}>{t('projectPackage.menu.duplicate')}</DropdownMenuItem>
    <DropdownMenuItem data-testid={`project-home-export-${project.id}`} disabled={!packagesAvailable()} onClick={() => { if (canAct() && packagesAvailable()) packages.openExport({id:project.id,name:project.name}); }}>{t('projectPackage.menu.export')}</DropdownMenuItem>
    <DropdownMenuItem onClick={() => { if (canAct()) void revealWorkspaceLocation().then(path => { if (live.current) { setLocation(path || ''); setLocationError(false); } }).catch(() => { if (live.current) setLocationError(true); }); }}>{t('redesign.projects.location')}</DropdownMenuItem>
    <DropdownMenuSeparator /><DropdownMenuItem className="project-home-delete" disabled={props.summaryEnabled === false || !project.revision} onClick={() => openAction('delete', project)}>{t('redesign.projects.delete')}</DropdownMenuItem>
  </DropdownMenuContent></DropdownMenu>;
  const toolbar = <><Label className="sr-only" htmlFor="project-home-sort">{t('redesign.projects.sort')}</Label><WorkbenchSelect id="project-home-sort" data-testid="project-home-sort" value={prefs.preferences.homeSort} visible={props.active !== false && props.page === 'projects' && !action} disabled={prefs.phase !== 'ready' || prefs.pending || prefs.dirty || props.busy || locked} onChange={(event: {target:{value:string}}) => { if (['recent','updated','name'].includes(event.target.value)) choose({homeSort:event.target.value as 'recent'|'updated'|'name'}); }}><option value="recent">{t('redesign.projects.recent')}</option><option value="updated">{t('redesign.projects.updated')}</option><option value="name">{t('redesign.projects.name')}</option></WorkbenchSelect><WorkbenchTabs value={prefs.preferences.homeView} label={t('redesign.projects.grid')} options={[{value:'grid',label:<span title={t('redesign.projects.grid')} aria-label={t('redesign.projects.grid')}><WorkbenchIcon name="grid" /></span>,testId:'project-home-view-grid',disabled:prefs.pending || prefs.dirty || prefs.phase !== 'ready' || props.busy || locked},{value:'list',label:<span title={t('redesign.projects.list')} aria-label={t('redesign.projects.list')}><WorkbenchIcon name="list" /></span>,testId:'project-home-view-list',disabled:prefs.pending || prefs.dirty || prefs.phase !== 'ready' || props.busy || locked}]} onValueChange={value => { if(value === 'grid' || value === 'list') choose({homeView:value}); }} /></>;
  return <div className={`project-home-screen project-home-${props.presentation || 'page'}`} data-presentation={props.presentation || 'page'} data-view={prefs.preferences.homeView} data-dropping={dropping || undefined} {...drag}>
    {dropping && <div className="project-home-drop-overlay" data-testid="project-home-drop-overlay" aria-hidden="true"><span><WorkbenchIcon name="upload" size={20} /></span><strong>{t('projectPackage.drop.title')}</strong><p>{t('projectPackage.drop.hint')}</p></div>}
    <ProjectPackageLayer place="home" onOpenProject={id => { if (live.current) current.current.onOpen(id); }} onShowAssets={id => { if (live.current) current.current.onOpen(id); }} onProjectsChanged={refreshList} />
    <ProjectHome {...props} onImport={packagesAvailable() ? chooseFile : undefined} justImported={packageState.recentImports} projects={ordered} totalProjects={props.projects.length} query={query} onQuery={setQuery} toolbar={toolbar} projectMenu={menu} busy={props.busy || locked} onCreateStateChange={report} onRefresh={refreshList} notice={props.notice || (summaryError ? t('redesign.projects.summaryFailed') : '')} />
    {cleanupCount > 0 && <div className="project-home-cleanup-status"><WorkbenchAlert tone="warning">{t('workspace.info.cleanupPending', {count:cleanupCount})}</WorkbenchAlert></div>}
    {(prefs.pending || prefs.phase === 'error' || prefs.phase === 'conflict') && <div className="project-home-preference-status"><WorkbenchAlert tone="warning" actions={<WorkbenchButton disabled={prefs.phase === 'saving'} onClick={() => void prefs.save()}>{t('appearance.save')}</WorkbenchButton>}>{t('redesign.projects.preferenceFailed')}</WorkbenchAlert></div>}
    {locationError && <div className="project-home-preference-status" role="status">{t('redesign.projects.locationFailed')}</div>}
    {location && <Dialog open onOpenChange={open => {if(!open)setLocation('');}}><WorkbenchDialogContent title={t('redesign.projects.location')}><Input readOnly value={location} aria-label={t('redesign.projects.location')} onFocus={event => event.target.select()} /><WorkbenchButton onClick={() => {void navigator.clipboard.writeText(location).catch(() => setLocationError(true));}}>{t('workspace.info.copy')}</WorkbenchButton></WorkbenchDialogContent></Dialog>}
    {action && <Dialog open onOpenChange={open => {if(!open && ['editing','rejected'].includes(actionRef.current?.phase || ''))publish(null);}}><WorkbenchDialogContent title={t(action.kind === 'delete' ? 'redesign.projects.delete' : 'redesign.projects.rename')} size="confirm" data-testid="project-home-action-dialog"><strong>{action.project.name}</strong>
      {action.kind === 'delete' ? <p>{t('redesign.projects.deleteHelp')}</p> : <Input data-testid="project-home-rename" value={action.name} maxLength={150} autoFocus disabled={action.phase !== 'editing'} aria-label={t('projects.name')} onChange={event => {if(actionRef.current?.phase === 'editing')publish({...actionRef.current,name:event.target.value});}} />}
      {action.phase !== 'editing' && action.phase !== 'busy' && <WorkbenchAlert tone="warning">{t(action.phase === 'unknown' ? 'redesign.projects.unknown' : action.phase === 'cleanup' ? 'redesign.projects.cleanupPending' : 'redesign.projects.rejected')}</WorkbenchAlert>}
      <footer className="project-home-action-buttons"><WorkbenchButton variant="ghost" disabled={!['editing','rejected'].includes(action.phase)} onClick={() => publish(null)}>{t('common.cancel')}</WorkbenchButton><WorkbenchButton variant={action.kind === 'delete' ? 'danger' : 'primary'} loading={action.phase === 'busy'} disabled={action.phase === 'busy' || action.phase === 'rejected' || action.kind === 'rename' && !action.name.trim()} onClick={() => void submit()} data-testid="project-home-action-submit">{t(action.input ? 'redesign.projects.retryOriginal' : action.kind === 'delete' ? 'redesign.projects.delete' : 'redesign.projects.rename')}</WorkbenchButton></footer>
    </WorkbenchDialogContent></Dialog>}
  </div>;
}

import React from 'react';
import type { ReactElement } from 'react';
import { RecentProjectsView } from '../../../apps/web/src/project-file/RecentProjects.tsx';
import type { InboxEntry, RecentProjectItem, RecentProjectsViewProps } from '../../../apps/web/src/project-file/RecentProjects.tsx';
import { NEW_PROJECT_FILE_DEFAULTS, NewProjectFileDialog } from '../../../apps/web/src/project-file/NewProjectFileDialog.tsx';
import type { NewProjectFileDialogProps } from '../../../apps/web/src/project-file/NewProjectFileDialog.tsx';
import { ProjectOpenFailureDialog } from '../../../apps/web/src/project-file/ProjectOpenFailureDialog.tsx';
import type { ProjectOpenFailureDialogProps } from '../../../apps/web/src/project-file/ProjectOpenFailureDialog.tsx';
import type { ProjectAvailabilityView } from '../../../apps/web/src/project-file/types.ts';
import { COVER_URLS, HOME, INBOX_ITEMS, NOW, OPEN_FAILURES, PROJECT_IDS, RECENT_PROJECTS } from './fixtures.ts';

/** One state of one U1 component, after a 12-xx preview. The gallery renders
 * scenes for the screenshots; the SSR tests render the same scenes in CI. */
export type SceneGroup = 'home' | 'media' | 'versions-pack' | 'rules';
export interface Scene {
  readonly id: string;
  readonly group: SceneGroup;
  /** Preview number, e.g. `12-03b`. */
  readonly design: string;
  /** ready, empty, loading, error, working or a component-specific state. */
  readonly state: string;
  /** page: the whole viewport; dialog: the dialog with a 24px margin; frame: `[data-scene-frame]` at 2x. */
  readonly capture: 'page' | 'dialog' | 'frame';
  /** Width of the frame for `frame` captures. */
  readonly frameWidth?: number;
  render(): ReactElement;
}
type SceneInput = Omit<Scene, 'group' | 'capture'> & { readonly capture?: Scene['capture'] };
function group(name: SceneGroup, list: readonly SceneInput[]): readonly Scene[] {
  return list.map(scene => ({ capture: 'page', ...scene, group: name }));
}
const none = (): void => undefined;

// ---------------------------------------------------------------------------
// Group 1: home, new project, cannot open (12-01 to 12-03d)
const missing: ProjectAvailabilityView = { state: 'missing' };
function items(overrides: Readonly<Record<string, ProjectAvailabilityView>> = {}): readonly RecentProjectItem[] {
  return RECENT_PROJECTS.map(project => ({ project, coverUrl: COVER_URLS[project.projectId] ?? null,
    availability: overrides[project.projectId] ?? (project.projectId === PROJECT_IDS.interview ? missing : { state: 'available' }) }));
}
const inbox: readonly InboxEntry[] = [{ projectId: PROJECT_IDS.interview, projectName: '访谈剪辑样片', count: INBOX_ITEMS.filter(item => item.projectId === PROJECT_IDS.interview).length, availability: missing }];
function home(patch: Partial<RecentProjectsViewProps> = {}): ReactElement {
  return <RecentProjectsView state={{ kind: 'ready', value: items() }} sort="recent" onSortChange={none} view="grid" onViewChange={none} now={NOW} homeDirectory={HOME} inbox={inbox}
    onOpen={none} onLocate={none} onRetry={none} onCreate={none} onOpenFile={none} {...patch} />;
}
function create(patch: Partial<NewProjectFileDialogProps> = {}, values: Partial<NewProjectFileDialogProps['values']> = {}): ReactElement {
  return <>{home()}<NewProjectFileDialog open values={{ name: '未命名项目', ...NEW_PROJECT_FILE_DEFAULTS, ...values }} onChange={none}
    location={{ display: '~/Movies/Mioon' }} onChooseLocation={none} state={{ kind: 'editing' }} onSubmit={none} onClose={none} {...patch} /></>;
}
function cannotOpen(patch: Partial<ProjectOpenFailureDialogProps> & Pick<ProjectOpenFailureDialogProps, 'failure'>, behind = false): ReactElement {
  const dialog = <ProjectOpenFailureDialog open projectName={null} action={{ kind: 'idle' }} platform="mac" onLocate={none} onRemove={none} onClose={none} {...patch} />;
  return behind ? <>{home()}{dialog}</> : dialog;
}
const homeScenes = group('home', [
  { id: '12-01', design: '12-01', state: 'ready', render: () => home() },
  { id: '12-01-list', design: '12-01', state: 'ready', render: () => home({ view: 'list', inbox: [], state: { kind: 'ready', value: items({
    [PROJECT_IDS.city]: { state: 'locked' }, [PROJECT_IDS.product]: { state: 'invalid', reason: 'read-only' }, [PROJECT_IDS.season]: { state: 'invalid', reason: 'corrupt' } }) } }) },
  { id: '12-01-empty', design: '12-01', state: 'empty', render: () => home({ state: { kind: 'ready', value: [] }, inbox: [] }) },
  { id: '12-01-loading', design: '12-01', state: 'loading', render: () => home({ state: { kind: 'loading' }, inbox: [] }) },
  { id: '12-01-error', design: '12-01', state: 'error', render: () => home({ state: { kind: 'error', retryable: true }, inbox: [] }) },
  { id: '12-01-inbox-none', design: '12-01', state: 'ready', render: () => home({ inbox: [] }) },
  { id: '12-02', design: '12-02', state: 'ready', render: () => create() },
  { id: '12-02-no-folder', design: '12-02', state: 'ready', render: () => create({}, { createFolder: false, presetId: 'landscape_1080', description: '雨夜城市，霓虹倒影，冷色调，节奏舒缓' }) },
  { id: '12-02-empty-name', design: '12-02', state: 'empty', render: () => create({}, { name: '' }) },
  { id: '12-02-invalid-name', design: '12-02', state: 'error', render: () => create({}, { name: '访谈:第一版' }) },
  { id: '12-02-creating', design: '12-02', state: 'working', render: () => create({ state: { kind: 'creating' } }) },
  { id: '12-02-exists', design: '12-02', state: 'error', render: () => create({ state: { kind: 'error', code: 'PROJECT_FILE_EXISTS' } }) },
  { id: '12-02-web', design: '12-02', state: 'ready', render: () => create({ onChooseLocation: undefined, location: { display: '/srv/mioon/projects' } }) },
  { id: '12-03', design: '12-03', state: 'ready', render: () => cannotOpen({ failure: OPEN_FAILURES.missing, projectName: '访谈剪辑样片', inboxCount: 2 }, true) },
  { id: '12-03-no-inbox', design: '12-03', state: 'ready', render: () => cannotOpen({ failure: OPEN_FAILURES.missing, projectName: '访谈剪辑样片', inboxCount: 0 }, true) },
  { id: '12-03-locating', design: '12-03', state: 'working', render: () => cannotOpen({ failure: OPEN_FAILURES.missing, projectName: '访谈剪辑样片', inboxCount: 2, action: { kind: 'working', action: 'locate' } }, true) },
  { id: '12-03-error', design: '12-03', state: 'error', render: () => cannotOpen({ failure: OPEN_FAILURES.missing, projectName: '访谈剪辑样片', inboxCount: 2, action: { kind: 'error', action: 'locate' } }, true) },
  { id: '12-03b', design: '12-03b', state: 'ready', capture: 'dialog', render: () => cannotOpen({ failure: OPEN_FAILURES.locked, projectName: '城市夜景短片' }) },
  { id: '12-03c', design: '12-03c', state: 'ready', capture: 'dialog', render: () => cannotOpen({ failure: OPEN_FAILURES.newer, onCheckUpdate: none }) },
  { id: '12-03c-history', design: '12-03c', state: 'ready', capture: 'dialog', render: () => cannotOpen({ failure: OPEN_FAILURES.newerHistory }) },
  { id: '12-03d', design: '12-03d', state: 'ready', capture: 'dialog', render: () => cannotOpen({ failure: OPEN_FAILURES.corrupt, onRestoreBackup: none }) },
  { id: '12-03d-restoring', design: '12-03d', state: 'working', capture: 'dialog', render: () => cannotOpen({ failure: OPEN_FAILURES.corrupt, onRestoreBackup: none, action: { kind: 'working', action: 'restore' } }) },
  { id: '12-03d-read-only', design: '12-03d', state: 'ready', capture: 'dialog', render: () => cannotOpen({ failure: OPEN_FAILURES.readOnly, onReveal: none }) },
]);

export const scenes: readonly Scene[] = [...homeScenes];
const seen = new Set<string>();
for (const scene of scenes) {
  if (seen.has(scene.id)) throw new Error(`Duplicate scene: ${scene.id}`);
  seen.add(scene.id);
}

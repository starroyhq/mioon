import React from 'react';
import type { ReactElement } from 'react';
import { RecentProjectsView } from '../../../apps/web/src/project-file/RecentProjects.tsx';
import type { InboxEntry, RecentProjectItem, RecentProjectsViewProps } from '../../../apps/web/src/project-file/RecentProjects.tsx';
import { NEW_PROJECT_FILE_DEFAULTS, NewProjectFileDialog } from '../../../apps/web/src/project-file/NewProjectFileDialog.tsx';
import type { NewProjectFileDialogProps } from '../../../apps/web/src/project-file/NewProjectFileDialog.tsx';
import { ProjectOpenFailureDialog } from '../../../apps/web/src/project-file/ProjectOpenFailureDialog.tsx';
import type { ProjectOpenFailureDialogProps } from '../../../apps/web/src/project-file/ProjectOpenFailureDialog.tsx';
import { MediaAttentionBanner, MediaStatusBadge, MediaStatusNote, mediaStatusTone } from '../../../apps/web/src/project-file/MediaStatus.tsx';
import type { MediaAttentionBannerProps } from '../../../apps/web/src/project-file/MediaStatus.tsx';
import { mediaStatusDisplay } from '../../../apps/web/src/project-file/media-status.ts';
import type { MediaStatusReason, MediaStatusUi } from '../../../apps/web/src/project-file/media-status.ts';
import { MediaRelinkDialog } from '../../../apps/web/src/project-file/MediaRelinkDialog.tsx';
import type { MediaRelinkDialogProps } from '../../../apps/web/src/project-file/MediaRelinkDialog.tsx';
import { OutsideLocationsDialog } from '../../../apps/web/src/project-file/OutsideLocationsDialog.tsx';
import type { OutsideLocationsDialogProps } from '../../../apps/web/src/project-file/OutsideLocationsDialog.tsx';
import { ProjectFileMenu } from '../../../apps/web/src/project-file/ProjectFileMenu.tsx';
import type { ProjectFileMenuProps } from '../../../apps/web/src/project-file/ProjectFileMenu.tsx';
import { CURRENT_VERSION, VersionHistoryDialog } from '../../../apps/web/src/project-file/VersionHistoryDialog.tsx';
import type { VersionHistoryDialogProps } from '../../../apps/web/src/project-file/VersionHistoryDialog.tsx';
import { RestoreVersionDialog } from '../../../apps/web/src/project-file/RestoreVersionDialog.tsx';
import type { RestoreVersionDialogProps } from '../../../apps/web/src/project-file/RestoreVersionDialog.tsx';
import { PackCompleteDialog, PackProjectDialog } from '../../../apps/web/src/project-file/PackProjectDialog.tsx';
import type { PackCompleteDialogProps, PackProjectDialogProps } from '../../../apps/web/src/project-file/PackProjectDialog.tsx';
import type { ProjectAvailabilityView } from '../../../apps/web/src/project-file/types.ts';
import type { MediaStatus } from '../../../packages/contracts/src/media-reference.ts';
import { COMPARISON, COVER_URLS, HOME, INBOX_ITEMS, MEDIA_THUMBS, NOW, OLDER_VERSIONS, OPEN_FAILURES, OUTSIDE_LOCATIONS, PACK_MANIFEST, PACK_RESULT, PROJECT_IDS, RECENT_PROJECTS, RELINK_MISSING_ROW, RELINK_ROWS,
  RESTORE_PREVIEW, RESTORE_PREVIEW_MORE, VERSIONS } from './fixtures.ts';

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

// ---------------------------------------------------------------------------
// Group 2: media status, relink, outside locations (12-04 to 12-06)
/** L1's status through the U1 mapping, as S6 will call it. */
const l1 = (status: MediaStatus, reason: MediaStatusReason, outside: boolean, readable: boolean): MediaStatusUi => mediaStatusDisplay({ status, reason, outside, readable });
/** One card per badge. The card frame stands in for the media library's own
 * card (AssetLibrary), which U2 and S6 wire up; the badge, note and tone are U1. */
const MEDIA_CARDS: readonly { readonly name: string; readonly thumb: string; readonly status: MediaStatusUi }[] = [
  { name: 'scene-a.mp4', thumb: MEDIA_THUMBS.a, status: l1('online', 'same-stats', false, true) },
  { name: 'scene-c.mp4', thumb: MEDIA_THUMBS.c, status: l1('missing', 'not-found', false, false) },
  { name: 'scene-d.mp4', thumb: MEDIA_THUMBS.d, status: l1('changed', 'content', false, true) },
  { name: 'scene-e.mp4', thumb: MEDIA_THUMBS.e, status: l1('online', 'same-stats', true, false) },
  { name: 'scene-f.mp4', thumb: MEDIA_THUMBS.f, status: l1('changed', 'unverified', true, false) },
  { name: 'scene-g.mp4', thumb: MEDIA_THUMBS.g, status: { kind: 'checking' } },
  { name: 'scene-h.mp4', thumb: MEDIA_THUMBS.h, status: { kind: 'check-failed' } },
];
function mediaCards(): ReactElement {
  return <div className="fixture-media-grid">{MEDIA_CARDS.map(card => <div key={card.name} className="fixture-media-card" data-tone={mediaStatusTone(card.status) ?? undefined} data-status={card.status.kind} data-testid={`fixture-media-${card.status.kind}`}>
    <span className="fixture-media-thumb"><img src={card.thumb} alt="" /><MediaStatusBadge status={card.status} className="fixture-media-badge" /></span>
    <span className="fixture-media-name">{card.name}</span>
    <MediaStatusNote status={card.status} />
  </div>)}</div>;
}
function banner(state: MediaAttentionBannerProps['state']): ReactElement {
  return <MediaAttentionBanner state={state} onRelink={none} onRetry={none} />;
}
function relink(patch: Partial<MediaRelinkDialogProps> = {}): ReactElement {
  return <MediaRelinkDialog open projectName="UI 走查项目" homeDirectory={HOME} state={{ kind: 'ready', value: { rows: RELINK_ROWS, foundBy: { name: 'scene-c.mp4', count: 1 } } }}
    apply={{ kind: 'idle' }} onChooseFile={none} onUseNewFile={none} onApply={none} onRetry={none} onClose={none} {...patch} />;
}
function outside(patch: Partial<OutsideLocationsDialogProps> = {}): ReactElement {
  return <>{home()}<OutsideLocationsDialog open projectName="访谈剪辑样片" fromAnotherComputer state={{ kind: 'ready', value: OUTSIDE_LOCATIONS }} rulesUntrusted action={{ kind: 'idle' }}
    homeDirectory={HOME} onOpenOnly={none} onAllow={none} onRetry={none} onClose={none} {...patch} /></>;
}
const mediaScenes = group('media', [
  { id: '12-04-badges', design: '12-04', state: 'ready', capture: 'frame', frameWidth: 260, render: mediaCards },
  { id: '12-04-banner', design: '12-04', state: 'ready', capture: 'frame', frameWidth: 260, render: () => banner({ kind: 'ready', value: 3 }) },
  // Empty: no media need attention and the file is online, so neither the banner nor a badge renders.
  { id: '12-04-none', design: '12-04', state: 'empty', capture: 'frame', frameWidth: 260, render: () => <>{banner({ kind: 'ready', value: 0 })}<MediaStatusBadge status={l1('online', 'same-content', false, true)} /></> },
  { id: '12-04-banner-checking', design: '12-04', state: 'loading', capture: 'frame', frameWidth: 260, render: () => banner({ kind: 'loading' }) },
  { id: '12-04-banner-error', design: '12-04', state: 'error', capture: 'frame', frameWidth: 260, render: () => banner({ kind: 'error', retryable: true }) },
  { id: '12-05', design: '12-05', state: 'ready', render: () => relink() },
  { id: '12-05-missing', design: '12-05', state: 'ready', render: () => relink({ state: { kind: 'ready', value: { rows: [...RELINK_ROWS, RELINK_MISSING_ROW], foundBy: { name: 'scene-c.mp4', count: 1 } } } }) },
  { id: '12-05-searching', design: '12-05', state: 'loading', render: () => relink({ state: { kind: 'loading' } }) },
  { id: '12-05-empty', design: '12-05', state: 'empty', render: () => relink({ state: { kind: 'ready', value: { rows: [], foundBy: null } } }) },
  { id: '12-05-error', design: '12-05', state: 'error', render: () => relink({ state: { kind: 'error', retryable: true } }) },
  { id: '12-05-applying', design: '12-05', state: 'working', render: () => relink({ apply: { kind: 'working', action: 'apply' } }) },
  { id: '12-05-apply-error', design: '12-05', state: 'error', render: () => relink({ apply: { kind: 'error', action: 'apply' } }) },
  { id: '12-06', design: '12-06', state: 'ready', render: () => outside() },
  { id: '12-06-loading', design: '12-06', state: 'loading', render: () => outside({ state: { kind: 'loading' } }) },
  { id: '12-06-empty', design: '12-06', state: 'empty', render: () => outside({ state: { kind: 'ready', value: [] }, rulesUntrusted: false }) },
  { id: '12-06-error', design: '12-06', state: 'error', render: () => outside({ state: { kind: 'error', retryable: true } }) },
  { id: '12-06-no-rules-note', design: '12-06', state: 'ready', render: () => outside({ rulesUntrusted: false }) },
  { id: '12-06-allowing', design: '12-06', state: 'working', render: () => outside({ action: { kind: 'working', action: 'allow' } }) },
]);

// ---------------------------------------------------------------------------
// Group 3: project menu, versions, packing (12-07 to 12-11)
const recentMenu = RECENT_PROJECTS.slice(0, 5).map(project => ({ projectId: project.projectId, name: project.name }));
/** The menu opened from the project name in the top bar, placed where the top bar has it. */
function menu(patch: Partial<ProjectFileMenuProps> = {}): ReactElement {
  return <div style={{ padding: '8px 0 0 140px' }}><ProjectFileMenu projectName="UI 走查项目" open platform="mac" recent={{ kind: 'ready', value: recentMenu }}
    onNewProject={none} onOpen={none} onOpenRecent={none} onRetryRecent={none} onSaveVersion={none} onVersionHistory={none} onSaveAs={none} onPack={none} onReveal={none} onRules={none}
    onExportStoryboard={none} viewItems={null} {...patch} /></div>;
}
function history(patch: Partial<VersionHistoryDialogProps> = {}): ReactElement {
  return <VersionHistoryDialog open projectName="UI 走查项目" now={NOW} versions={{ kind: 'ready', value: VERSIONS }} selected={VERSIONS[0].summary.id} onSelect={none}
    comparison={{ kind: 'ready', value: COMPARISON }} retention={{ recent: 20, days: 7 }} onSaveVersion={none} onCompare={none} onRestore={none} onRetry={none} onRetryComparison={none} onClose={none} {...patch} />;
}
/** As in 12-09, the confirmation opens over the version history. */
function restore(patch: Partial<RestoreVersionDialogProps> = {}): ReactElement {
  return <>{history()}<RestoreVersionDialog open version={VERSIONS[0]} now={NOW} preview={{ kind: 'ready', value: RESTORE_PREVIEW }} restore={{ kind: 'idle' }} onRestore={none} onRetry={none} onClose={none} {...patch} /></>;
}
function pack(patch: Partial<PackProjectDialogProps> = {}): ReactElement {
  return <PackProjectDialog open projectName="UI 走查项目" homeDirectory={HOME} manifest={{ kind: 'ready', value: PACK_MANIFEST }} pack={{ kind: 'idle' }} onChooseDestination={none} onRelink={none}
    onPack={none} onRetry={none} onClose={none} {...patch} />;
}
function packed(patch: Partial<PackCompleteDialogProps> = {}): ReactElement {
  return <PackCompleteDialog open result={PACK_RESULT} missingNames={['scene-c.mp4', 'scene-f.mp4']} platform="mac" homeDirectory={HOME} onReveal={none} onClose={none} {...patch} />;
}
const versionsPackScenes = group('versions-pack', [
  { id: '12-07', design: '12-07', state: 'ready', render: () => menu() },
  { id: '12-07-recent', design: '12-07', state: 'ready', render: () => menu({ recentOpen: true }) },
  { id: '12-07-recent-loading', design: '12-07', state: 'loading', render: () => menu({ recentOpen: true, recent: { kind: 'loading' } }) },
  { id: '12-07-recent-empty', design: '12-07', state: 'empty', render: () => menu({ recentOpen: true, recent: { kind: 'ready', value: [] } }) },
  { id: '12-07-recent-error', design: '12-07', state: 'error', render: () => menu({ recentOpen: true, recent: { kind: 'error', retryable: true } }) },
  { id: '12-07-disabled', design: '12-07', state: 'ready', render: () => menu({ disabledItems: new Set(['saveVersion', 'saveAs', 'rules'] as const) }) },
  { id: '12-07-web', design: '12-07', state: 'ready', render: () => menu({ platform: 'web', onReveal: undefined, onSaveAs: undefined }) },
  { id: '12-07-windows', design: '12-07', state: 'ready', render: () => menu({ platform: 'windows' }) },
  { id: '12-08', design: '12-08', state: 'ready', render: () => history() },
  { id: '12-08-current', design: '12-08', state: 'ready', render: () => history({ selected: CURRENT_VERSION }) },
  { id: '12-08-older', design: '12-08', state: 'ready', render: () => history({ versions: { kind: 'ready', value: OLDER_VERSIONS }, selected: OLDER_VERSIONS[1].summary.id, comparison: { kind: 'ready', value: [] } }) },
  { id: '12-08-loading', design: '12-08', state: 'loading', render: () => history({ versions: { kind: 'loading' } }) },
  { id: '12-08-empty', design: '12-08', state: 'empty', render: () => history({ versions: { kind: 'ready', value: [] }, selected: CURRENT_VERSION }) },
  { id: '12-08-error', design: '12-08', state: 'error', render: () => history({ versions: { kind: 'error', retryable: true } }) },
  { id: '12-08-detail-loading', design: '12-08', state: 'loading', render: () => history({ comparison: { kind: 'loading' } }) },
  { id: '12-08-detail-error', design: '12-08', state: 'error', render: () => history({ comparison: { kind: 'error', retryable: true } }) },
  { id: '12-09', design: '12-09', state: 'ready', render: () => restore() },
  { id: '12-09-more', design: '12-09', state: 'ready', render: () => restore({ preview: { kind: 'ready', value: RESTORE_PREVIEW_MORE } }) },
  { id: '12-09-loading', design: '12-09', state: 'loading', render: () => restore({ preview: { kind: 'loading' } }) },
  { id: '12-09-empty', design: '12-09', state: 'empty', render: () => restore({ preview: { kind: 'ready', value: { ...RESTORE_PREVIEW, manualChanges: [], manualChangeCount: 0, supersededMioChanges: 0 } } }) },
  { id: '12-09-error', design: '12-09', state: 'error', render: () => restore({ preview: { kind: 'error', retryable: true } }) },
  { id: '12-09-restoring', design: '12-09', state: 'working', render: () => restore({ restore: { kind: 'working', action: 'restore' } }) },
  { id: '12-09-restore-error', design: '12-09', state: 'error', render: () => restore({ restore: { kind: 'error', action: 'restore' } }) },
  { id: '12-10', design: '12-10', state: 'ready', render: () => pack() },
  { id: '12-10-loading', design: '12-10', state: 'loading', render: () => pack({ manifest: { kind: 'loading' } }) },
  { id: '12-10-empty', design: '12-10', state: 'empty', render: () => pack({ manifest: { kind: 'ready', value: { ...PACK_MANIFEST, assets: { count: 0, sizeBytes: 0, outsideCount: 0 }, rulesFile: false, missing: 0 } } }) },
  { id: '12-10-read-error', design: '12-10', state: 'error', render: () => pack({ manifest: { kind: 'error', retryable: true } }) },
  { id: '12-10-packing', design: '12-10', state: 'working', render: () => pack({ pack: { kind: 'packing', progress: 42 } }) },
  { id: '12-10-error', design: '12-10', state: 'error', render: () => pack({ pack: { kind: 'error' } }) },
  { id: '12-11', design: '12-11', state: 'ready', render: () => packed() },
  { id: '12-11-all-copied', design: '12-11', state: 'ready', render: () => packed({ result: { ...PACK_RESULT, missingAssetIds: [] }, missingNames: [] }) },
]);

export const scenes: readonly Scene[] = [...homeScenes, ...mediaScenes, ...versionsPackScenes];
const seen = new Set<string>();
for (const scene of scenes) {
  if (seen.has(scene.id)) throw new Error(`Duplicate scene: ${scene.id}`);
  seen.add(scene.id);
}

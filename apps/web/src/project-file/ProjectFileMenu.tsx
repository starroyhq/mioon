import React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@mioon/ui/components/dropdown-menu';
import { WorkbenchButton } from '@mioon/ui/components/workbench-controls';
import { ChevronDown, Clock, FolderOpen, Grid2X2, Plus } from '@mioon/ui/components/workbench-icons';
import { useI18n } from '../i18n/I18nProvider.tsx';
import Icon from '../icons.tsx';
import { revealLabelKey, shortcutLabel } from './format.ts';
import { ProjectFileIcon } from './project-file-icons.tsx';
import type { HostPlatform, ViewState } from './types.ts';
import './project-file-common.css';
import './project-file-versions.css';

/** Accelerators shown beside the items (12-07). The desktop menu registers them
 * (S6); the browser keeps ⌘N and the like for itself, so the web shows none. */
export const PROJECT_FILE_MENU_ACCELERATORS = Object.freeze({
  newProject: 'CmdOrCtrl+N', open: 'CmdOrCtrl+O', saveVersion: 'Alt+CmdOrCtrl+S', saveAs: 'Shift+CmdOrCtrl+S', exportStoryboard: 'Shift+CmdOrCtrl+E',
} as const);
export type ProjectFileMenuItem = 'newProject' | 'open' | 'recent' | 'saveVersion' | 'versionHistory' | 'saveAs' | 'pack' | 'reveal' | 'rules' | 'exportStoryboard' | 'view';
export interface RecentMenuProject {
  readonly projectId: string;
  readonly name: string;
}
export interface ProjectFileMenuItemsProps {
  readonly platform: HostPlatform;
  readonly recent: ViewState<readonly RecentMenuProject[]>;
  readonly onNewProject?: () => void;
  readonly onOpen?: () => void;
  readonly onOpenRecent?: (projectId: string) => void;
  readonly onRetryRecent?: () => void;
  readonly onSaveVersion?: () => void;
  readonly onVersionHistory?: () => void;
  readonly onSaveAs?: () => void;
  readonly onPack?: () => void;
  readonly onReveal?: () => void;
  readonly onRules?: () => void;
  readonly onExportStoryboard?: () => void;
  /** Items of the View submenu; without them there is no View submenu. */
  readonly viewItems?: ReactNode;
  /** Shown but not available now, e.g. in a restored read-only copy. */
  readonly disabledItems?: ReadonlySet<ProjectFileMenuItem>;
  /** Opens the Recent projects submenu with the menu. */
  readonly recentOpen?: boolean;
}

/** The project menu's items (12-07), for the caller's own DropdownMenuContent.
 * An item whose callback is missing is left out. */
export function ProjectFileMenuItems(props: ProjectFileMenuItemsProps): ReactElement {
  const { t } = useI18n();
  const { platform, recent } = props;
  const disabled = (id: ProjectFileMenuItem) => props.disabledItems?.has(id) ?? false;
  const item = (id: ProjectFileMenuItem, icon: ReactElement, label: string, onClick: (() => void) | undefined, accelerator?: string) => onClick &&
    <DropdownMenuItem key={id} data-testid={`pf-menu-${id}`} disabled={disabled(id)} onClick={onClick}>
      {icon}<span className="pf-menu-label">{label}</span>
      {accelerator && platform !== 'web' && <DropdownMenuShortcut className="pf-menu-shortcut">{shortcutLabel(accelerator, platform)}</DropdownMenuShortcut>}
    </DropdownMenuItem>;
  const recentProjects = props.onOpenRecent && <DropdownMenuSub key="recent" defaultOpen={props.recentOpen}>
    <DropdownMenuSubTrigger data-testid="pf-menu-recent" disabled={disabled('recent')}><Clock size={16} aria-hidden="true" /><span className="pf-menu-label">{t('projectFile.menu.recent')}</span></DropdownMenuSubTrigger>
    <DropdownMenuSubContent className="pf-menu pf-menu-sub" data-testid="pf-menu-recent-list">
      {recent.kind === 'loading' && <div className="pf-menu-state" role="status"><span className="wb-spinner" aria-hidden="true" />{t('projectFile.common.loading')}</div>}
      {recent.kind === 'error' && <>
        <div className="pf-menu-state" role="alert">{t('projectFile.home.error')}</div>
        {recent.retryable && props.onRetryRecent && <DropdownMenuItem data-testid="pf-menu-recent-retry" onClick={props.onRetryRecent}><span className="pf-menu-label">{t('projectFile.common.retry')}</span></DropdownMenuItem>}
      </>}
      {recent.kind === 'ready' && recent.value.length === 0 && <div className="pf-menu-state">{t('projectFile.menu.recentEmpty')}</div>}
      {recent.kind === 'ready' && recent.value.map(project => <DropdownMenuItem key={project.projectId} data-testid={`pf-menu-recent-${project.projectId}`} onClick={() => props.onOpenRecent?.(project.projectId)}>
        <span className="pf-menu-label">{project.name}</span>
      </DropdownMenuItem>)}
    </DropdownMenuSubContent>
  </DropdownMenuSub>;
  const view = props.viewItems !== undefined && <DropdownMenuSub key="view">
    <DropdownMenuSubTrigger data-testid="pf-menu-view" disabled={disabled('view')}><Grid2X2 size={16} aria-hidden="true" /><span className="pf-menu-label">{t('projectFile.menu.view')}</span></DropdownMenuSubTrigger>
    <DropdownMenuSubContent className="pf-menu pf-menu-sub">{props.viewItems}</DropdownMenuSubContent>
  </DropdownMenuSub>;
  // Separators as in 12-07: file, versions, the project folder, view.
  const groups: readonly (readonly (ReactNode | undefined | false)[])[] = [
    [item('newProject', <Plus size={16} aria-hidden="true" />, t('projectFile.menu.newProject'), props.onNewProject, PROJECT_FILE_MENU_ACCELERATORS.newProject),
      item('open', <FolderOpen size={16} aria-hidden="true" />, t('projectFile.menu.open'), props.onOpen, PROJECT_FILE_MENU_ACCELERATORS.open), recentProjects],
    [item('saveVersion', <ProjectFileIcon name="bookmarkPlus" />, t('projectFile.menu.saveVersion'), props.onSaveVersion, PROJECT_FILE_MENU_ACCELERATORS.saveVersion),
      item('versionHistory', <ProjectFileIcon name="history" />, t('projectFile.menu.versionHistory'), props.onVersionHistory),
      item('saveAs', <ProjectFileIcon name="copy" />, t('projectFile.menu.saveAs'), props.onSaveAs, PROJECT_FILE_MENU_ACCELERATORS.saveAs)],
    [item('pack', <Icon name="box" size={16} />, t('projectFile.menu.pack'), props.onPack),
      item('reveal', <Icon name="folder" size={16} />, t(revealLabelKey(platform)), props.onReveal),
      item('rules', <Icon name="note" size={16} />, t('projectFile.menu.rules'), props.onRules),
      item('exportStoryboard', <ProjectFileIcon name="fileDown" />, t('projectFile.menu.exportStoryboard'), props.onExportStoryboard, PROJECT_FILE_MENU_ACCELERATORS.exportStoryboard)],
    [view],
  ];
  const shown = groups.map(entries => entries.filter(Boolean)).filter(entries => entries.length > 0);
  return <>{shown.map((entries, index) => <React.Fragment key={index}>{index > 0 && <DropdownMenuSeparator />}{entries}</React.Fragment>)}</>;
}

export interface ProjectFileMenuProps extends ProjectFileMenuItemsProps {
  readonly projectName: string;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}
/** The project name in the top bar and its menu. */
export function ProjectFileMenu({ projectName, open, onOpenChange, ...items }: ProjectFileMenuProps): ReactElement {
  return <DropdownMenu open={open} onOpenChange={next => onOpenChange?.(next)}>
    <DropdownMenuTrigger render={<WorkbenchButton variant="ghost" className="pf-menu-trigger" data-testid="pf-menu-trigger" />}>
      <span className="pf-menu-trigger-name">{projectName}</span><ChevronDown size={14} aria-hidden="true" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="pf-menu" data-testid="pf-menu"><ProjectFileMenuItems {...items} /></DropdownMenuContent>
  </DropdownMenu>;
}

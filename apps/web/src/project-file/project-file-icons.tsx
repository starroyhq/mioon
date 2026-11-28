import React from 'react';
import type { ComponentType, ReactElement, SVGProps } from 'react';
import {
  Bookmark, BookmarkPlus, Calendar, Captions, CircleDot, Copy, File, FileDown, FileX, FolderSearch, History, Inbox,
  WORKBENCH_ICON_STROKE_WIDTH,
} from '@mioon/ui/components/workbench-icons';

type LucideLike = ComponentType<SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number | string }>;

const icons = {
  inbox: Inbox,
  fileX: FileX,
  file: File,
  fileDown: FileDown,
  bookmark: Bookmark,
  bookmarkPlus: BookmarkPlus,
  history: History,
  copy: Copy,
  circleDot: CircleDot,
  calendar: Calendar,
  captions: Captions,
  folderSearch: FolderSearch,
} satisfies Record<string, LucideLike>;

export type ProjectFileIconName = keyof typeof icons;

export function ProjectFileIcon({
  name,
  size = 16,
  strokeWidth = WORKBENCH_ICON_STROKE_WIDTH,
  ...props
}: Omit<SVGProps<SVGSVGElement>, 'name'> & { name: ProjectFileIconName; size?: number }): ReactElement {
  const Component = icons[name];
  return <Component size={size} strokeWidth={strokeWidth} aria-hidden="true" {...props} />;
}

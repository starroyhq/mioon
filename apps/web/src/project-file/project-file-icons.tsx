import React from 'react';
import type { ReactElement, ReactNode, SVGProps } from 'react';

/** Icons the project file screens need that neither `../icons.tsx` nor the
 * Lucide re-exports of `@mioon/ui/components/workbench-icons` have. Same
 * 24-unit grid and stroke as `../icons.tsx`. */
const paths = {
  inbox: <><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1Z" /></>,
  folderSearch: <><path d="M10.5 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H20a2 2 0 0 1 2 2v3" /><circle cx="17" cy="16" r="3" /><path d="m21 20-1.9-1.9" /></>,
} satisfies Record<string, ReactNode>;
export type ProjectFileIconName = keyof typeof paths;

export function ProjectFileIcon({ name, size = 16, ...props }: Omit<SVGProps<SVGSVGElement>, 'name'> & { name: ProjectFileIconName; size?: number }): ReactElement {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}

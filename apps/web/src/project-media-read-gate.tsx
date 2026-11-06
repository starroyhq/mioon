import React, {createContext, useContext} from 'react';
import type {ReactNode, ImgHTMLAttributes} from 'react';
import type {ProjectMediaBinding} from './use-project-media.ts';
import {MediaStatusBadge, MediaStatusNote} from './project-file/MediaStatus.tsx';

const ProjectMediaContext = createContext<ProjectMediaBinding | null>(null);
export function ProjectMediaProvider({media, children}: {readonly media: ProjectMediaBinding; readonly children: ReactNode}) {
  return <ProjectMediaContext.Provider value={media}>{children}</ProjectMediaContext.Provider>;
}
export const useProjectMediaReadGate = (): ProjectMediaBinding | null => useContext(ProjectMediaContext);
export function ProjectMediaImage({asset, ...props}: ImgHTMLAttributes<HTMLImageElement> & {readonly asset: unknown}) {
  const gate = useProjectMediaReadGate();
  if (gate && !gate.canRead(asset)) return <span className="pf-media-blocked" data-testid="media-image-blocked"><MediaStatusBadge status={gate.statusFor(asset)} /><MediaStatusNote status={gate.statusFor(asset)} /></span>;
  return <img {...props} />;
}
/** A version's output is a separate asset from its first-frame/reference.
 * Never admit that output merely because the reference is online. */
export function mediaReadIdentity(asset: unknown, version?: unknown): unknown {
  if (version === null || version === undefined) return asset;
  if (typeof version !== 'object' || !('assetId' in version) || typeof version.assetId !== 'string') return null;
  return {id: version.assetId, ...('projectId' in version ? {projectId: version.projectId} : {})};
}

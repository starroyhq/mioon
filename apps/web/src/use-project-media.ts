import {useLayoutEffect, useRef, useState} from 'react';
import {createProjectMediaController, sameMediaOwner} from './project-media-state.ts';
import type {ChooseMediaPreview, ProjectMediaAsset, ProjectMediaController, ProjectMediaOwner, ProjectMediaState} from './project-media-state.ts';
import type {ProjectMediaClient} from './project-media-client.ts';
import type {MediaStatusUi} from './project-file/media-status.ts';

export interface ProjectMediaBinding {
  readonly state: ProjectMediaState;
  readonly controller: ProjectMediaController;
  readonly canRead: (asset: unknown) => boolean;
  readonly statusFor: (asset: unknown) => MediaStatusUi;
}
function assetIdentity(value: unknown): {id: string; projectId?: unknown; referenceRevision?: unknown} | null {
  if (typeof value === 'string') return {id: value};
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') return null;
  return {id: value.id, ...('projectId' in value ? {projectId: value.projectId} : {}), ...('referenceRevision' in value ? {referenceRevision: value.referenceRevision} : {})};
}
/** Owner refs change during render so an old response can never admit content
 * in the interval before layout effects update the controller. */
export function useProjectMedia(options: {
  readonly owner: ProjectMediaOwner | null;
  readonly assets: readonly ProjectMediaAsset[];
  readonly readOwner: () => ProjectMediaOwner | null;
  readonly onApplied?: (owner: ProjectMediaOwner) => unknown | Promise<unknown>;
  readonly client?: ProjectMediaClient;
  readonly choosePreview?: ChooseMediaPreview;
  readonly autoOpenOutside?: boolean;
}): ProjectMediaBinding {
  const live = useRef(options); live.current = options;
  const changed = useRef<(value: ProjectMediaState) => void>(() => {});
  const [controller] = useState(() => createProjectMediaController({
    ...(options.client ? {client: options.client} : {}), ...(options.choosePreview ? {choosePreview: options.choosePreview} : {}),
    ...(options.autoOpenOutside === undefined ? {} : {autoOpenOutside: options.autoOpenOutside}),
    readOwner: () => sameMediaOwner(live.current.owner, live.current.readOwner()) ? live.current.owner : null,
    readAssets: () => live.current.assets, onChange: value => changed.current(value), onApplied: owner => live.current.onApplied?.(owner),
  }));
  const [state, setState] = useState(controller.getState); changed.current = setState;
  const ownerKey = JSON.stringify(options.owner), assetsKey = JSON.stringify(options.assets.map(asset => [asset.id, asset.referenceRevision]).sort());
  useLayoutEffect(() => {controller.activate(); return () => controller.dispose();}, [controller]);
  useLayoutEffect(() => {controller.update(live.current.owner); void controller.refresh();}, [controller, ownerKey, assetsKey]);
  const current = (value: unknown): ProjectMediaAsset | null => {
    const identity = assetIdentity(value), owner = live.current.owner;
    if (!identity || !owner || !sameMediaOwner(owner, controller.getState().owner) || !sameMediaOwner(owner, live.current.readOwner())) return null;
    const asset = live.current.assets.find(item => item.id === identity.id && item.projectId === owner.projectId);
    if (!asset || identity.projectId !== undefined && identity.projectId !== owner.projectId || identity.referenceRevision !== undefined && identity.referenceRevision !== asset.referenceRevision) return null;
    return asset;
  };
  return {state, controller, canRead: value => {const asset = current(value); return Boolean(asset && controller.canRead(asset));}, statusFor: value => {const asset = current(value); return asset ? controller.statusFor(asset) : {kind: 'checking'};}};
}

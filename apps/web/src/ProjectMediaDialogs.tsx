import React from 'react';
import {MediaRelinkDialog} from './project-file/MediaRelinkDialog.tsx';
import {OutsideLocationsDialog} from './project-file/OutsideLocationsDialog.tsx';
import type {ProjectMediaBinding} from './use-project-media.ts';

export function ProjectMediaDialogs({media, projectName}: {readonly media: ProjectMediaBinding; readonly projectName: string}) {
  const {state, controller} = media;
  const locations = state.locations.kind === 'ready' ? {kind: 'ready' as const, value: state.locations.value.locations.filter(value => !value.confirmed)} : state.locations;
  const changedIds = state.status.kind === 'ready' ? Object.values(state.status.value).filter(value => value.status === 'changed' && value.readable && value.reason !== 'unverified').map(value => value.assetId) : [];
  return <>
    <OutsideLocationsDialog open={state.outsideOpen} projectName={projectName} fromAnotherComputer={false} state={locations} rulesUntrusted={state.rulesUntrusted} action={state.outsideAction}
      canAllow={locations.kind === 'ready' && locations.value.some(value => value.available)} onOpenOnly={() => controller.openOnly()} onClose={() => controller.openOnly()} onAllow={() => {void controller.allowOutside();}} onRetry={() => {void controller.refreshLocations();}} />
    <MediaRelinkDialog open={state.relinkOpen} projectName={projectName} state={state.relink} apply={state.applyAction} canApply={state.canApply} changedSelected={state.changedSelected} newAdded={state.newAdded}
      {...(state.canChoose ? {onChooseFile: (id: string) => {void controller.choose(id);}} : {})} onUseNewFile={id => controller.toggleChanged(id)} canUseNewFile={id => state.canChangeSelection && changedIds.includes(id)}
      onApply={() => {void controller.apply();}} onRetry={() => {void controller.refresh();}} onClose={() => controller.cancelRelink()} />
  </>;
}

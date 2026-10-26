import type {ClipDraftEnvelope,ClipDraftList} from '@mioon/contracts/local-drafts';
import type {createLocalDrafts} from '../../packages/business/src/local-drafts.ts';

// These fixtures create ordinary workspaces; the restored-workspace response is
// exercised separately with its own negative inputs.
export type OrdinaryDraftEnvelope=Extract<ClipDraftEnvelope,{supported:true}>;
export type OrdinaryDraftList=Extract<ClipDraftList,{supported:true}>;
export type OrdinaryLocalDrafts=Omit<ReturnType<typeof createLocalDrafts>,'get'|'list'|'put'|'discard'> & {
  get(input:unknown):OrdinaryDraftEnvelope;
  list(input:unknown):OrdinaryDraftList;
  put(input:unknown):OrdinaryDraftEnvelope;
  discard(input:unknown):OrdinaryDraftEnvelope;
};

import type {createLocalDelivery} from '../../packages/business/src/local-delivery.ts';
import type {LocalDeliverySupported} from '../../apps/web/src/local-delivery-state.ts';
import type {LocalDeliveryRenderInput} from '@mioon/contracts/local-delivery';
import type {FixtureExport} from './strict-timeline-core-types.ts';
export type OrdinaryDeliveryEnvelope=Omit<LocalDeliverySupported,'intent'>&{intent:(Omit<NonNullable<LocalDeliverySupported['intent']>,'input'>&{input:LocalDeliveryRenderInput})|null};
export type OrdinaryLocalDelivery=Omit<ReturnType<typeof createLocalDelivery>,'get'|'put'|'prepare'|'discard'|'execute'|'recover'>&{
 get(input:unknown):OrdinaryDeliveryEnvelope;
 put(input:unknown):OrdinaryDeliveryEnvelope;
 prepare(input:unknown):OrdinaryDeliveryEnvelope;
 discard(input:unknown):OrdinaryDeliveryEnvelope;
 execute(input:unknown):Promise<{envelope:OrdinaryDeliveryEnvelope;response:FixtureExport|null}>;
 recover(input:unknown):Promise<{envelope:OrdinaryDeliveryEnvelope;response:FixtureExport|null}>;
};

import {z} from 'zod';

/** Trusted first-party composition identity, not an installable manifest or proof
 * that an external ComfyUI runtime/model is present, safe, or compatible. */
export const COMFY_CONNECTOR_DESCRIPTOR = Object.freeze({
  connectorId: 'mioon.comfy-local', implementationVersion: '1',
} as const);
const common = {
  schemaVersion:z.literal(1), connectorId:z.literal(COMFY_CONNECTOR_DESCRIPTOR.connectorId),
  implementationVersion:z.literal(COMFY_CONNECTOR_DESCRIPTOR.implementationVersion),
  fixedForSession:z.literal(true),
};
export const comfyConnectorAvailabilitySchema=z.discriminatedUnion('state',[
  z.object({...common,state:z.literal('available'),reason:z.literal('ready')}).strict(),
  z.object({...common,state:z.literal('not_provided'),reason:z.literal('distribution_not_provided')}).strict(),
  z.object({...common,state:z.literal('not_loaded'),reason:z.literal('startup_not_loaded')}).strict(),
]);
export type ComfyConnectorAvailability=z.infer<typeof comfyConnectorAvailabilitySchema>;
export type ComfyModuleMode='load'|'skip'|'not-provided';
export function comfyConnectorAvailability(mode:ComfyModuleMode):Readonly<ComfyConnectorAvailability>{
  const state=mode==='load'?'available':mode==='skip'?'not_loaded':mode==='not-provided'?'not_provided':null;
  if(state===null)throw new TypeError('Invalid official ComfyUI module composition');
  return Object.freeze(comfyConnectorAvailabilitySchema.parse({schemaVersion:1,...COMFY_CONNECTOR_DESCRIPTOR,
    state,reason:state==='available'?'ready':state==='not_loaded'?'startup_not_loaded':'distribution_not_provided',fixedForSession:true}));
}

import {comfyConnectorAvailability,comfyConnectorAvailabilitySchema} from '../../../contracts/src/comfy-availability.ts';
import type {ComfyConnectorAvailability} from '../../../contracts/src/comfy-availability.ts';

export const COMFY_MODULE_UNAVAILABLE_MESSAGE='本次启动未提供可用的 ComfyUI 连接器。旧素材和任务记录仍保留；不会查询、重提或取消远端工作。';
export class ComfyModuleUnavailableError extends Error {
  readonly code='COMFY_MODULE_UNAVAILABLE'; readonly status=503;
  details:Record<string,unknown>={};
  constructor(){super(COMFY_MODULE_UNAVAILABLE_MESSAGE);}
}
export function comfyModuleUnavailable():ComfyModuleUnavailableError{
  return new ComfyModuleUnavailableError();
}
/** Snapshot the trusted startup composition. Settings.enabled deliberately is
 * absent: it permits NEW generation, not observation of an already frozen run. */
export function createComfyAdmission(connector:unknown,declared?:unknown){
  const availability:Readonly<ComfyConnectorAvailability>=Object.freeze(declared===undefined
    ? comfyConnectorAvailability(connector?'load':'not-provided')
    : comfyConnectorAvailabilitySchema.parse(declared));
  if(Boolean(connector)!==(availability.state==='available'))throw new TypeError('Inconsistent official ComfyUI module composition');
  return Object.freeze({availability,assertAvailable(){if(availability.state!=='available')throw comfyModuleUnavailable();}});
}

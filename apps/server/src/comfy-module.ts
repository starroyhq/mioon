import {comfyConnectorAvailability} from '../../../packages/contracts/src/comfy-availability.ts';
import type {ComfyModuleMode} from '../../../packages/contracts/src/comfy-availability.ts';

/** Fixed module, no user-controlled path, registry, import URL or executable.
 * Skipped/absent modules are not constructed. Bundling is unchanged; this seam
 * makes no package-size, sandbox, GPU or runtime compatibility claim. */
export function composeOfficialComfyModule<T>(mode:ComfyModuleMode,create:()=>T){
  const availability=comfyConnectorAvailability(mode);
  const connector=mode==='load'?create():undefined;
  return Object.freeze({availability,connector});
}
/** Launcher-only opt-out, captured once before startup. It cannot identify code
 * or claim that the current distribution omitted its bundled implementation. */
export function comfyModuleModeFromEnvironment(value:unknown):'load'|'skip'{
  if(value===undefined||value==='load')return 'load';
  if(value==='skip')return 'skip';
  throw new TypeError('MIOON_COMFY_MODULE must be load or skip');
}

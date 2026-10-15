import {comfyConnectorAvailability,comfyConnectorAvailabilitySchema} from '../../packages/contracts/src/comfy-availability.ts';
import type {ComfyConnectorAvailability,ComfyModuleMode} from '../../packages/contracts/src/comfy-availability.ts';
import {createComfyAdmission} from '../../packages/business/src/comfy/admission.ts';
import {composeOfficialComfyModule,comfyModuleModeFromEnvironment} from '../../apps/server/src/comfy-module.ts';
const mode:ComfyModuleMode=comfyModuleModeFromEnvironment('skip');
const descriptor:Readonly<ComfyConnectorAvailability>=comfyConnectorAvailability(mode);
const checked=comfyConnectorAvailabilitySchema.parse(descriptor);
const {connector,availability}=composeOfficialComfyModule(mode,()=>({fixed:true as const}));
const admission=createComfyAdmission(connector,availability);
if(checked.state==='not_loaded'){
 const reason:'startup_not_loaded'=checked.reason;
 void reason;
}
// @ts-expect-error Arbitrary path is never a module composition value.
comfyConnectorAvailability('/tmp/plugin.mjs');
// @ts-expect-error State is frozen; callers cannot toggle an active session.
admission.availability.state='available';
void descriptor;

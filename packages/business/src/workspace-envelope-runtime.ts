/** Narrow trusted startup dependencies. No legacy JavaScript enters the typed
 * workspace admission graph, and absent assembly never grants admission. */
import type {DatabaseSync} from 'node:sqlite';
import type {WorkspaceClassificationV40V41} from './workspace-restore-schema-v41.ts';
export interface WorkspaceEnvelopeRuntime {
 readonly isTimelineRecord: (value:unknown,options?:Readonly<{projectId?:unknown}>)=>boolean;
 readonly isTimelineRenderRecord: (value:unknown,input:unknown)=>boolean;
 readonly timelineRenderResponseBytes: number;
 readonly validateClipIntent: (operation:'timeline.clip.add'|'timeline.clip.update',value:unknown)=>boolean;
 readonly classify40Or41: (db:DatabaseSync)=>WorkspaceClassificationV40V41;
 readonly validateRestored41: (db:DatabaseSync)=>unknown;
}
let runtime:Readonly<WorkspaceEnvelopeRuntime>|undefined;
const unavailable=():never=>{throw Object.assign(new Error('Workspace envelope validators are not assembled.'),{code:'WORKSPACE_VOLUME_ENVELOPE_RUNTIME_UNAVAILABLE'});};
/** Called once by the existing application-owned database startup assembly. */
export function installWorkspaceEnvelopeRuntime(value:WorkspaceEnvelopeRuntime):void {
 if(runtime||!value||typeof value.isTimelineRecord!=='function'||typeof value.isTimelineRenderRecord!=='function'||
    typeof value.validateClipIntent!=='function'||typeof value.validateRestored41!=='function'||typeof value.classify40Or41!=='function'||
    !Number.isSafeInteger(value.timelineRenderResponseBytes)||value.timelineRenderResponseBytes<1)unavailable();
 runtime=Object.freeze({...value});
}
export function requireWorkspaceEnvelopeRuntime():Readonly<WorkspaceEnvelopeRuntime>{return runtime??unavailable();}

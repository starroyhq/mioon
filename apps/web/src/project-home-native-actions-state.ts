import type {ProjectDeleteInput} from '../../../packages/contracts/src/project-lifecycle.ts';
import type {ProjectEntriesDesktopBridge, ProjectDesktopTemplate} from '../../../packages/contracts/src/project-entry-desktop.ts';
import {projectDesktopSelectionSchema} from '../../../packages/contracts/src/project-entry-desktop.ts';
import {projectDeleteInputSchema, projectDeleteResponseSchema} from '../../../packages/contracts/src/project-lifecycle.ts';
import {projectCopyResponseSchema} from '../../../packages/contracts/src/project-copies.ts';
import type {ProjectCopyResponse} from '../../../packages/contracts/src/project-copies.ts';
import {projectEntriesResponseSchema} from '../../../packages/contracts/src/project-entry.ts';
import {projectEntryControlErrorSchema} from '../../../packages/contracts/src/project-entry-control.ts';
import type {RecentProject} from '../../../packages/contracts/src/project-registry.ts';
import {BrowserRpcError} from './browser-rpc.ts';

export interface ProjectHomeNativeActions {
  readonly trash?: (input: ProjectDeleteInput) => Promise<unknown>;
  readonly example?: {
    readonly bridge: Pick<ProjectEntriesDesktopBridge, 'chooseLocation' | 'instantiateTemplate'>;
    readonly templates: readonly ProjectDesktopTemplate[];
  };
}
export interface ProjectHomeNativeActionMetadata {
  readonly busy: boolean;
  readonly unknown: boolean;
  readonly version: number;
}
export interface ProjectHomeNativeActionIdentity {readonly appLibraryScope: string; readonly instanceId: string; readonly epoch: number}
type ExampleInput=Parameters<NonNullable<ProjectEntriesDesktopBridge['instantiateTemplate']>>[0];
export interface ProjectHomeNativeActionState {
  readonly kind: 'idle' | 'checking' | 'confirm-trash' | 'working-trash' | 'trash-blocked' | 'trash-unknown' | 'choosing-example' | 'working-example' | 'example-blocked' | 'example-unknown' | 'example-created' | 'opening-example';
  readonly project: RecentProject | null;
  readonly exampleName: string | null;
  readonly exampleReceipt: ProjectCopyResponse | null;
  readonly reason: 'busy' | 'denied' | 'unavailable' | 'facts' | null;
  readonly notice: {readonly kind: 'success' | 'changed'; readonly name: string} | null;
  readonly version: number;
}
interface Authority {readonly identity: ProjectHomeNativeActionIdentity; readonly lifetime: number; readonly current: () => boolean; readonly nativePermit?: () => boolean}
type Pending = {readonly authority: Authority} & (
  {readonly kind: 'trash'; readonly project: RecentProject; readonly input: ProjectDeleteInput} |
  {readonly kind: 'example'; readonly project: null; readonly input: ExampleInput; readonly displayPath: string});
const sameIdentity=(a:ProjectHomeNativeActionIdentity|null,b:ProjectHomeNativeActionIdentity):boolean=>a!==null&&a.appLibraryScope===b.appLibraryScope&&a.instanceId===b.instanceId&&a.epoch===b.epoch;
const busy=(kind:ProjectHomeNativeActionState['kind'])=>['checking','working-trash','choosing-example','working-example'].includes(kind);
const uncertain=(kind:ProjectHomeNativeActionState['kind'])=>kind==='trash-unknown'||kind==='example-unknown';
const initial=():ProjectHomeNativeActionState=>({kind:'idle',project:null,exampleName:null,exampleReceipt:null,reason:null,notice:null,version:0});
function immutableProject(project:RecentProject):RecentProject {
  Object.freeze(project.fileIdentity);
  if(project.summary){if(project.summary.cover)Object.freeze(project.summary.cover);Object.freeze(project.summary);}
  return Object.freeze(project);
}

/** Application metadata and opaque native tickets are the only authorities.
 * A dispatched input is retained before awaiting transport, and only exact
 * explicit recheck can reuse it. No path disappearance establishes success. */
export function createProjectHomeNativeActionsController(options: {
  readonly ports: () => ProjectHomeNativeActions | undefined;
  readonly owner: () => ProjectHomeNativeActionIdentity | null;
  readonly canStart: () => boolean;
  readonly readDirectory: () => Promise<unknown>;
  readonly onChange?: (state: ProjectHomeNativeActionState, metadata: ProjectHomeNativeActionMetadata) => void;
  readonly onRefresh: () => void | Promise<void>;
  /** Existing entry owner performs departure consent and its fresh identity/
   * membership check. This callback never accepts a renderer path or token. */
  readonly onOpenCreated: (projectId: string) => boolean | Promise<boolean>;
  /** Receives the original opaque native departure function, never a local
   * boolean or wrapper. The entry owner validates and consumes its authority. */
  readonly onOpenNativeResult?: (projectId: string, permit: () => boolean) => boolean | Promise<boolean>;
  readonly newRequestId?: () => string;
}) {
  let active=false,lifetime=0,serial=0,state=initial(),authority:Authority|null=null,pending:Pending|null=null,retainedUnknown=false,rechecking=false;
  let knownExample:{readonly input:ExampleInput;readonly receipt:ProjectCopyResponse}|null=null;
  const requestId=options.newRequestId??(()=>globalThis.crypto.randomUUID());
  function emit(patch:Partial<ProjectHomeNativeActionState>):void {
    state=Object.freeze({...state,...patch,version:state.version+1});
    options.onChange?.(state,Object.freeze({busy:busy(state.kind),unknown:uncertain(state.kind)||retainedUnknown,version:state.version}));
  }
  const current=(value:Authority):boolean=>active&&value.lifetime===lifetime&&sameIdentity(options.owner(),value.identity)&&value.current();
  const idle=():void=>{authority=null;emit({kind:'idle',project:null,exampleName:null,exampleReceipt:null,reason:null});};
  const retireRead=(value:Authority,call:number):void=>{if(!pending&&active&&lifetime===value.lifetime&&call===serial)idle();};
  const refresh=async():Promise<void>=>{
    // Read failure has its own directory state. It cannot turn a verified
    // destructive receipt into an unknown outcome or replay that operation.
    try {await options.onRefresh();}catch {/* The directory retains its error. */}
  };
  function capture(permit:()=>boolean,nativePermit?:()=>boolean):Authority|null {
    const identity=options.owner();
    return active&&options.canStart()&&state.kind==='idle'&&identity&&permit()?Object.freeze({identity:Object.freeze({...identity}),lifetime,current:permit,...(nativePermit?{nativePermit}:{})}):null;
  }
  async function directory(value:Authority) {
    const response=projectEntriesResponseSchema.parse(await options.readDirectory());
    if(!current(value)||response.appLibraryScope!==value.identity.appLibraryScope||response.instanceId!==value.identity.instanceId)throw Error('Entry identity changed');
    return response;
  }
  function failure(error:unknown):string|null {
    if(error instanceof BrowserRpcError)return error.definitive&&!/UNKNOWN|UNCONFIRMED/u.test(error.code)?error.code:null;
    const parsed=projectEntryControlErrorSchema.safeParse(error);
    return parsed.success&&parsed.data.status<500&&!/UNKNOWN|UNCONFIRMED/u.test(parsed.data.code)?parsed.data.code:null;
  }
  const unknown=(operation:Pending):void=>{retainedUnknown=true;emit({kind:operation.kind==='trash'?'trash-unknown':'example-unknown',project:operation.project,reason:null});};
  async function openCreated(automatic=false):Promise<boolean> {
    const value=authority,project=state.project;
    if(!value||!project||state.kind!=='example-created'||!active||value.lifetime!==lifetime||!sameIdentity(options.owner(),value.identity))return false;
    if(!automatic&&!options.canStart())return false;
    if(automatic&&(!value.nativePermit||!options.onOpenNativeResult||!current(value)))return false;
    const call=++serial;
    try {
      // Parent entry owns its own open latch/consent. This local visual latch
      // must not report itself as a competing native mutation to that owner.
      emit({kind:'opening-example'});
      const accepted=automatic?await options.onOpenNativeResult!(project.projectId,value.nativePermit!):await options.onOpenCreated(project.projectId);
      if(!active||value.lifetime!==lifetime||!sameIdentity(options.owner(),value.identity)||call!==serial)return accepted===true;
      if(accepted===true)idle();else emit({kind:'example-created'});
      return accepted===true;
    }catch {if(active&&value.lifetime===lifetime&&call===serial)emit({kind:'example-created'});return false;}
  }
  async function execute(operation:Pending):Promise<boolean> {
    const value=operation.authority,call=++serial,wasUnknown=uncertain(state.kind);
    if(!current(value))return false;
    pending=operation;
    emit({kind:operation.kind==='trash'?'working-trash':'working-example',project:operation.project,reason:null,notice:null});
    if(!current(value)){if(wasUnknown)unknown(operation);else{pending=null;idle();}return false;}
    try {
      if(operation.kind==='trash'){
        const port=options.ports()?.trash;if(!port)throw Error('Trash capability unavailable');
        const result=projectDeleteResponseSchema.parse(await port(operation.input));
        if(result.requestId!==operation.input.requestId||result.projectId!==operation.input.projectId||result.projectFile!==operation.input.projectFile)throw Error('Trash receipt mismatch');
        if(!current(value)||call!==serial){if(pending===operation&&call===serial)unknown(operation);return false;}
        pending=null;retainedUnknown=false;authority=null;emit({kind:'idle',project:null,notice:{kind:'success',name:operation.project.name}});await refresh();return true;
      }
      const port=options.ports()?.example?.bridge.instantiateTemplate;if(!port)throw Error('Template capability unavailable');
      const result=projectCopyResponseSchema.parse(await port(operation.input));
      if(result.requestId!==operation.input.requestId||result.project.projectFile!==operation.displayPath||result.project.name!==operation.input.name)throw Error('Template receipt mismatch');
      immutableProject(result.project);const receipt=Object.freeze(result);knownExample={input:operation.input,receipt};
      // A changed input/lease revokes opening authority, not the verified ACK.
      // Cross-lifetime/library results stay private until explicit recheck.
      if(!active||value.lifetime!==lifetime||!sameIdentity(options.owner(),value.identity)||call!==serial)return false;
      pending=null;retainedUnknown=false;emit({kind:'example-created',project:receipt.project,exampleReceipt:receipt});await refresh();
      if(current(value)&&value.nativePermit&&options.onOpenNativeResult)await openCreated(true);
      return true;
    }catch(error){
      if(!current(value)||call!==serial){if(pending===operation&&call===serial)unknown(operation);return false;}
      const code=failure(error);
      if(code===null){unknown(operation);return false;}
      pending=null;retainedUnknown=false;
      if(operation.kind==='trash'&&(code==='PROJECT_TRASH_SOURCE_CHANGED'||code==='REVISION_CONFLICT')){
        authority=null;emit({kind:'idle',project:null,notice:{kind:'changed',name:operation.project.name}});await refresh();
      }else emit({kind:operation.kind==='example'?'example-blocked':'trash-blocked',project:operation.project,reason:code==='PROJECT_HOST_BUSY'?'busy':code==='PROJECT_ACCESS_DENIED'?'denied':'unavailable'});
      return false;
    }
  }
  return {
    getState:()=>state,
    getMetadata:():ProjectHomeNativeActionMetadata=>({busy:busy(state.kind),unknown:uncertain(state.kind)||retainedUnknown,version:state.version}),
    activate():void {if(!active){active=true;lifetime++;}},
    dispose():void {
      active=false;lifetime++;serial++;
      if(pending){unknown(pending);}else if(!uncertain(state.kind)){authority=null;emit({kind:'idle',project:null,reason:null});}
    },
    close():boolean {if(busy(state.kind)||uncertain(state.kind)||state.kind==='opening-example')return false;serial++;pending=null;knownExample=null;idle();return true;},
    dismissNotice():void {emit({notice:null});},
    rejectPreparation(example:boolean):void {if(active&&state.kind==='idle')emit({kind:example?'example-blocked':'trash-blocked',project:null,reason:'facts'});},
    async prepareTrash(projectId:string,permit:()=>boolean=()=>true):Promise<boolean> {
      if(!options.ports()?.trash)return false;
      const value=capture(permit);if(!value)return false;
      authority=value;const call=++serial;emit({kind:'checking',notice:null});
      try {const snapshot=await directory(value);if(!current(value)||call!==serial){retireRead(value,call);return false;}
        const entry=snapshot.registered.find(entry=>entry.project.projectId===projectId);
        if(!entry||entry.availability.state==='missing'||!entry.project.summary){emit({kind:'trash-blocked',project:entry?.project??null,reason:'facts'});return false;}
        emit({kind:'confirm-trash',project:immutableProject(entry.project),reason:null});return true;
      }catch {if(current(value)&&call===serial)emit({kind:'trash-blocked',project:null,reason:'facts'});else retireRead(value,call);return false;}
    },
    async confirmTrash():Promise<boolean> {
      const value=authority,target=state.project;if(!value||!target||state.kind!=='confirm-trash'||!current(value))return false;
      const call=++serial;emit({kind:'checking'});
      try {const snapshot=await directory(value);if(!current(value)||call!==serial){retireRead(value,call);return false;}
        const actual=snapshot.registered.find(entry=>entry.project.projectId===target.projectId)?.project;
        if(!actual?.summary||actual.projectFile!==target.projectFile||actual.fileIdentity.dev!==target.fileIdentity.dev||actual.fileIdentity.ino!==target.fileIdentity.ino||actual.summary.revision!==target.summary?.revision){
          authority=null;emit({kind:'idle',project:null,notice:{kind:'changed',name:target.name}});await refresh();return false;
        }
        const parsed=projectDeleteInputSchema.parse({requestId:requestId(),projectId:actual.projectId,projectFile:actual.projectFile,fileIdentity:actual.fileIdentity,expectedRevision:actual.summary.revision,confirmTrash:true});
        Object.freeze(parsed.fileIdentity);const input=Object.freeze(parsed);
        return await execute({kind:'trash',authority:value,project:target,input});
      }catch {if(current(value)&&call===serial)emit({kind:'trash-blocked',reason:'facts'});else retireRead(value,call);return false;}
    },
    async startExample(message:string,suggestedName:string,permit:()=>boolean=()=>true,nativePermit?:()=>boolean):Promise<boolean> {
      const port=options.ports()?.example;if(!port?.bridge.instantiateTemplate||!port.templates.some(template=>template.id==='timeline-basics'&&template.version===1))return false;
      const value=capture(permit,nativePermit);if(!value)return false;authority=value;knownExample=null;const call=++serial;emit({kind:'choosing-example',exampleName:suggestedName,exampleReceipt:null,notice:null});
      try {await directory(value);if(!current(value)||call!==serial){retireRead(value,call);return false;}
        const raw=await port.bridge.chooseLocation({purpose:'template',suggestedName,message});
        if(!current(value)||call!==serial){retireRead(value,call);return false;}
        if(raw===null){idle();return false;}
        const selection=projectDesktopSelectionSchema.parse(raw),template=selection.template;
        if(!template||!port.templates.some(item=>item.id===template.id&&item.version===template.version))throw Error('Invalid template selection');
        await directory(value);if(!current(value)||call!==serial){retireRead(value,call);return false;}
        const input=Object.freeze({token:selection.token,templateId:template.id,templateVersion:template.version,name:template.name,requestId:requestId()});
        emit({exampleName:template.name});
        const operation:Pending={kind:'example',authority:value,input,displayPath:selection.displayPath,project:null};
        return await execute(operation);
      }catch {if(current(value)&&call===serial)emit({kind:'example-blocked',project:null,reason:'unavailable'});else retireRead(value,call);return false;}
    },
    async recheck(permit:()=>boolean=()=>true,nativePermit?:()=>boolean):Promise<boolean> {
      const original=pending;if(rechecking||!original||!uncertain(state.kind)||!active||!sameIdentity(options.owner(),original.authority.identity)||!permit())return false;
      // Only an explicit new consent may rebind a retained input after a
      // visibility lifetime ended. It keeps the original ID/token/body exact.
      const value:Authority=Object.freeze({identity:original.authority.identity,lifetime,current:permit,...(nativePermit?{nativePermit}:{})});
      const operation:Pending={...original,authority:value};authority=value;pending=operation;rechecking=true;
      try {await directory(value);if(!current(value))return false;
        if(operation.kind==='example'&&knownExample?.input===operation.input){
          pending=null;retainedUnknown=false;emit({kind:'example-created',project:knownExample.receipt.project,exampleReceipt:knownExample.receipt});
          if(value.nativePermit&&options.onOpenNativeResult)await openCreated(true);return true;
        }
        return await execute(operation);
      }catch{return false;}finally{rechecking=false;}
    },
    retryOpen:()=>openCreated(false),
  };
}
export type ProjectHomeNativeActionsController=ReturnType<typeof createProjectHomeNativeActionsController>;

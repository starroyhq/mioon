import {createHash,randomUUID} from 'node:crypto';
import {isProxy} from 'node:util/types';
import {LOCAL_SHOT_TEXT_LIMITS,createLocalShotTextSchemas,isLocalShotTextMutationResponse} from '@mioon/contracts/local-shot-text';
import type {LocalShotTextUpdateInput,LocalShotTextDraftValue,LocalShotTextIntent,LocalShotTextSlot,LocalShotTextDisk,LocalShotTextEnvelope,LocalShotTextExecution,LocalShotTextExecute,LocalShotTextKey} from '@mioon/contracts/local-shot-text';
import type {ProjectStore} from './project-file/store.ts';
import {createLocalDraftRepository, LocalDraftRepositoryError} from './local-draft-repository.ts';

export const LOCAL_SHOT_TEXT_FILENAME='local-shot-text-v1.json';
const messages={
  LOCAL_SHOT_TEXT_VALIDATION:[400,'镜头文字草稿参数无效。'],
  LOCAL_SHOT_TEXT_CONFLICT:[409,'镜头文字草稿或保存意图已变化。请重新读取。'],
  LOCAL_SHOT_TEXT_STALE_INSTANCE:[409,'本地服务已重新启动。请重新读取后显式恢复。'],
  LOCAL_SHOT_TEXT_SCOPE_MISMATCH:[409,'镜头文字草稿属于另一个工作区或渠道。'],
  LOCAL_SHOT_TEXT_OWNER_REQUIRED:[403,'镜头文字草稿需要持有当前工作区锁。'],
  LOCAL_SHOT_TEXT_NOT_FOUND:[404,'镜头文字草稿所属项目或镜头不存在。'],
  LOCAL_SHOT_TEXT_LIMIT:[413,'镜头文字草稿超过大小限制。'],
  LOCAL_SHOT_TEXT_CAPACITY:[507,'镜头文字草稿容量已满，已有记录保持不变。'],
  LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE:[503,'无法安全读取或保存镜头文字草稿，已有记录未被重置。'],
  LOCAL_SHOT_TEXT_SAVE_UNCERTAIN:[503,'镜头文字记录的持久化确认未完成。请重新读取并显式恢复。'],
} as const;
type ErrorCode=keyof typeof messages;
export class LocalShotTextError extends Error{
  readonly code:ErrorCode;readonly status:number;
  constructor(code:ErrorCode){super(messages[code][1]);this.code=code;this.status=messages[code][0];}
}
function fail(code:ErrorCode):never{throw new LocalShotTextError(code);}
export function safeLocalShotTextError(error:unknown):{status:number;code:ErrorCode;message:string}{
  const safe=error instanceof LocalShotTextError?error:new LocalShotTextError('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');
  return {status:safe.status,code:safe.code,message:safe.message};
}
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>object(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const same=(a:unknown,b:unknown):boolean=>canonical(a)===canonical(b);
const sha=(value:unknown):string=>createHash('sha256').update(canonical(value)).digest('hex');
const terminal=(intent:LocalShotTextIntent|null):boolean=>intent!==null&&intent.outcome.status!=='pending';
function plain(value:unknown,depth=0,budget={nodes:0}):void{
  if(++budget.nodes>128||depth>8)fail('LOCAL_SHOT_TEXT_VALIDATION');
  if(value===null||typeof value==='boolean')return;
  if(typeof value==='number'){if(!Number.isFinite(value))fail('LOCAL_SHOT_TEXT_VALIDATION');return;}
  if(typeof value==='string'){if(value.length>LOCAL_SHOT_TEXT_LIMITS.httpBytes)fail('LOCAL_SHOT_TEXT_LIMIT');return;}
  if(!object(value)||isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('LOCAL_SHOT_TEXT_VALIDATION');
  for(const key of Reflect.ownKeys(value)){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(typeof key!=='string'||key==='__proto__'||!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))fail('LOCAL_SHOT_TEXT_VALIDATION');
    plain(descriptor.value,depth+1,budget);
  }
}
function parse<T>(schema:{safeParse(input:unknown):{success:true;data:T}|{success:false}},value:unknown):T{
  plain(value);if(Buffer.byteLength(JSON.stringify(value))>LOCAL_SHOT_TEXT_LIMITS.httpBytes)fail('LOCAL_SHOT_TEXT_LIMIT');
  const result=schema.safeParse(value);if(!result.success)fail('LOCAL_SHOT_TEXT_VALIDATION');return result.data;
}
export interface LocalShotTextGuards{
  ownsLock():boolean;
  readShot(projectId:string,shotId:string):unknown|null;
  readReceipt(projectId:string,input:LocalShotTextUpdateInput):unknown|null;
  isShotUpdateInput(value:unknown):boolean;
  isNotApplied(projectId:string,input:LocalShotTextUpdateInput,error:unknown):boolean;
  /** The backend binds only services.updateShotInProject(projectId, input). */
  update(projectId:string,input:LocalShotTextUpdateInput):Promise<unknown>;
}
export type LocalShotTextFaultPoint='beforePersist'|'afterPersist'|'beforeCommit'|'afterCommit'|'beforeConfirm'|'afterConfirm'|'beforeDispatch'|'afterDispatch'|'beforeOutcomePersist';
export interface LocalShotTextOptions{
  store:ProjectStore;channel?:'web'|'production'|'development';guards:LocalShotTextGuards;signal?:AbortSignal;
  relocate?:()=>void;
  fault?:(point:LocalShotTextFaultPoint)=>void;
}
const unsupported={supported:false,reason:'RESTORED_WORKSPACE_UNSUPPORTED'} as const;

/** Local raw title/prompt drafts and one immutable pending text intent per project. This is
 * deliberately not an operation journal, generic settlement API or RPC tool.
 * A pending reservation is durable before the single fixed service can run. */
export function createLocalShotText({store,channel='web',guards,signal,fault=()=>{},relocate}:LocalShotTextOptions){
  if(!['web','production','development'].includes(channel))fail('LOCAL_SHOT_TEXT_VALIDATION');
  const schemas=createLocalShotTextSchemas(guards.isShotUpdateInput),instanceId=randomUUID();
  const repository=createLocalDraftRepository<LocalShotTextDisk>({store,kind:'shot-text',channel,signal,relocate,ownsLock:()=>guards.ownsLock(),fault:point=>fault(point),
    validate:value=>{const result=schemas.disk.safeParse(value);if(!result.success)fail('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');return result.data;}});
  const flights=new Map<string,{intentId:string;revision:number;promise:Promise<LocalShotTextExecution>}>();
  const readDigests=new WeakMap<LocalShotTextDisk,string>(),uncertain=new Map<string,string>();
  let draining=false,drainPromise:Promise<void>|undefined;
  let saveUncertain=false;
  function guarded<T>(fn:()=>T):T{try{return fn();}catch(error){if(error instanceof LocalShotTextError)throw error;if(error instanceof LocalDraftRepositoryError)fail(`LOCAL_SHOT_TEXT_${error.reason}`);fail('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');}}
  function owned():void{if(signal?.aborted)fail('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');if(guards.ownsLock()!==true)fail('LOCAL_SHOT_TEXT_OWNER_REQUIRED');}
  function active():boolean{owned();return true;}
  function identity():string{return repository.scope();}
  function admission():void{if(draining)fail('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');}
  function mutation():void{admission();if(process.platform==='win32')fail('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');}
  function writable(args:{workspaceScope:string;instanceId:string}):void{
    if(process.platform==='win32')fail('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');
    owned();if(args.workspaceScope!==identity())fail('LOCAL_SHOT_TEXT_SCOPE_MISMATCH');
    if(args.instanceId!==instanceId)fail('LOCAL_SHOT_TEXT_STALE_INSTANCE');
  }
  function read():LocalShotTextDisk{
    owned();const result={data:repository.read()};
    const shots=new Set<string>(),intents=new Set<string>(),requests=new Set<string>();
    for(const row of result.data.entries){
      if(shots.has(row.shotId)||Buffer.byteLength(JSON.stringify(row))>LOCAL_SHOT_TEXT_LIMITS.rowBytes)fail('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');shots.add(row.shotId);
      if(row.intent){if(intents.has(row.intent.intentId)||requests.has(row.intent.input.requestId))fail('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');intents.add(row.intent.intentId);requests.add(row.intent.input.requestId);}
    }
    readDigests.set(result.data,sha(result.data));return result.data;
  }
  const keyOf=(key:LocalShotTextKey):string=>JSON.stringify([key.projectId,key.shotId]);
  function slot(disk:LocalShotTextDisk,key:LocalShotTextKey):LocalShotTextSlot{
    if(disk.entries.some(row=>row.shotId===key.shotId&&row.projectId!==key.projectId))fail('LOCAL_SHOT_TEXT_CONFLICT');
    return disk.entries.find(row=>keyOf(row)===keyOf(key))??{projectId:key.projectId,shotId:key.shotId,draftRevision:0,draft:null,intentRevision:0,intent:null};
  }
  function replace(disk:LocalShotTextDisk,row:LocalShotTextSlot):void{
    const index=disk.entries.findIndex(item=>keyOf(item)===keyOf(row));if(index<0)disk.entries.push(row);else disk.entries[index]=row;
  }
  function shot(key:LocalShotTextKey):Record<string,unknown>|null{
    const value=guards.readShot(key.projectId,key.shotId);if(value===null)return null;
    if(!object(value)||value.projectId!==key.projectId||value.id!==key.shotId||!Number.isSafeInteger(value.revision)||typeof value.title!=='string'||typeof value.prompt!=='string')fail('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');return value;
  }
  function target(value:Pick<LocalShotTextDraftValue,'baseRevision'|'baseText'>|null,current:Record<string,unknown>|null):'unset'|'matching'|'changed'|'missing'{
    if(!value)return 'unset';if(!current)return 'missing';return current.revision===value.baseRevision&&current.title===value.baseText.title&&current.prompt===value.baseText.prompt?'matching':'changed';
  }
  function receipt(row:LocalShotTextKey,intent:LocalShotTextIntent):unknown|null{
    const value=guards.readReceipt(row.projectId,clone(intent.input));if(value===null)return null;
    if(!isLocalShotTextMutationResponse(row.projectId,intent,value))fail('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');return value;
  }
  function evidence(row:LocalShotTextSlot):unknown|null{
    if(!row.intent)return null;const saved=receipt(row,row.intent);
    if(row.intent.outcome.status==='applied'){
      if(!object(saved)||saved.revision!==row.intent.outcome.shotRevision||sha(saved)!==row.intent.outcome.responseSha256)fail('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');
    }else if(row.intent.outcome.status==='not_applied'){
      // Terminal proof is private persisted evidence from a prior fresh rollback;
      // never manufacture a new proof by reconstructing a public error shape.
      if(saved!==null||row.intent.outcome.code!=='REVISION_CONFLICT')fail('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');
    }
    return saved;
  }
  function pending(disk:LocalShotTextDisk,projectId:string):LocalShotTextSlot|undefined{
    return disk.entries.find(row=>row.projectId===projectId&&row.intent&&(row.intent.outcome.status==='pending'||uncertain.get(projectId)===row.intent.intentId));
  }
  function response(row:LocalShotTextSlot):LocalShotTextEnvelope{
    owned();const current=shot(row);evidence(row);owned();
    const disk=read(),active=pending(disk,row.projectId);
    // A different shot's pending reference contains identities only, but its
    // current ownership must still hold before it is disclosed to this project.
    if(active&&keyOf(active)!==keyOf(row))shot(active);
    const shown=uncertain.get(row.projectId)===row.intent?.intentId&&row.intent?{...row,intent:{...row.intent,outcome:{status:'pending' as const}}}:row;
    const result={supported:true as const,workspaceScope:identity(),instanceId,...shown,draftTargetStatus:target(row.draft,current),intentTargetStatus:target(row.intent,current),projectPendingIntent:active?.intent?{shotId:active.shotId,intentId:active.intent.intentId}:null};
    if(!schemas.envelope.safeParse(result).success)fail('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');return clone(result);
  }
  function confirmSaved():void{
    owned();identity();try{
      fault('beforeConfirm');owned();repository.confirm();
      fault('afterConfirm');owned();identity();
    }catch{fail('LOCAL_SHOT_TEXT_SAVE_UNCERTAIN');}
  }
  function repositoryCheck(check:()=>void):void{
    try{check();}catch(error){
      if(error instanceof LocalShotTextError){
        switch(error.code){
          case 'LOCAL_SHOT_TEXT_CONFLICT':throw new LocalDraftRepositoryError('CONFLICT',error);
          case 'LOCAL_SHOT_TEXT_OWNER_REQUIRED':throw new LocalDraftRepositoryError('OWNER_REQUIRED',error);
          case 'LOCAL_SHOT_TEXT_SCOPE_MISMATCH':throw new LocalDraftRepositoryError('SCOPE_MISMATCH',error);
          case 'LOCAL_SHOT_TEXT_LIMIT':throw new LocalDraftRepositoryError('LIMIT',error);
          case 'LOCAL_SHOT_TEXT_CAPACITY':throw new LocalDraftRepositoryError('CAPACITY',error);
          case 'LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE':throw new LocalDraftRepositoryError('STORAGE_UNAVAILABLE',error);
          case 'LOCAL_SHOT_TEXT_SAVE_UNCERTAIN':throw new LocalDraftRepositoryError('SAVE_UNCERTAIN',error);
          default:throw new LocalDraftRepositoryError('STORAGE_UNAVAILABLE',error);
        }
      }
      throw error;
    }
  }
  function persist(disk:LocalShotTextDisk,check?:()=>void):void{
    owned();if(disk.workspaceScope!==identity())fail('LOCAL_SHOT_TEXT_SCOPE_MISMATCH');
    const bytes=JSON.stringify(disk)+'\n';
    if(disk.entries.length>LOCAL_SHOT_TEXT_LIMITS.slots||Buffer.byteLength(bytes)>LOCAL_SHOT_TEXT_LIMITS.envelopeBytes)fail('LOCAL_SHOT_TEXT_CAPACITY');
    if(disk.entries.some(row=>Buffer.byteLength(JSON.stringify(row))>LOCAL_SHOT_TEXT_LIMITS.rowBytes))fail('LOCAL_SHOT_TEXT_LIMIT');
    if(!schemas.disk.safeParse(disk).success)fail('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');
    const before=readDigests.get(disk);if(before===undefined)fail('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');
    fault('beforePersist');owned();if(disk.workspaceScope!==identity())fail('LOCAL_SHOT_TEXT_SCOPE_MISMATCH');
    let published=false;try{repository.save(disk,before,check?()=>repositoryCheck(check):undefined);published=true;fault('afterPersist');if(sha(read())!==sha(disk))fail('LOCAL_SHOT_TEXT_SAVE_UNCERTAIN');confirmSaved();if(sha(read())!==sha(disk))fail('LOCAL_SHOT_TEXT_SAVE_UNCERTAIN');saveUncertain=false;}
    catch(error){saveUncertain=true;if(published)fail('LOCAL_SHOT_TEXT_SAVE_UNCERTAIN');throw error;}
  }
  function exact(args:LocalShotTextExecute):{disk:LocalShotTextDisk;row:LocalShotTextSlot;intent:LocalShotTextIntent}{
    writable(args);const disk=read(),row=slot(disk,args);
    if(!row.intent||row.intent.intentId!==args.intentId||row.intentRevision!==args.expectedIntentRevision)fail('LOCAL_SHOT_TEXT_CONFLICT');
    return {disk,row,intent:row.intent};
  }
  async function run(args:LocalShotTextExecute):Promise<LocalShotTextExecution>{
    try{
    // Scheduled only after the project single-flight claim is installed.
    const initial=exact(args),original=clone(initial.intent),originalDigest=sha(original);
    const finish=():{disk:LocalShotTextDisk;row:LocalShotTextSlot;intent:LocalShotTextIntent}=>{
      const latest=exact(args);if(sha(latest.intent)!==originalDigest)fail('LOCAL_SHOT_TEXT_CONFLICT');
      const current=shot(args);if(!current)fail('LOCAL_SHOT_TEXT_CONFLICT');return latest;
    };
      finish();confirmSaved();saveUncertain=false; // Explicit checkpoint before dispatch.
      let result=receipt(args,original),error:unknown;
      if(result===null){
        fault('beforeDispatch');finish();
        try{result=await guards.update(args.projectId,clone(original.input));}catch(caught){error=caught;}
        fault('afterDispatch');
      }
      let latest=finish();const saved=receipt(args,original);
      let outcome:LocalShotTextIntent['outcome']|null=null;
      if(saved!==null){
        if(!object(saved)||typeof saved.id!=='string')fail('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');
        if(error===undefined&&result!==null&&(!isLocalShotTextMutationResponse(args.projectId,original,result)||!same(result,saved)))fail('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');
        outcome={status:'applied',shotRevision:original.baseRevision+1,responseSha256:sha(saved),resolvedAt:new Date().toISOString()};result=saved;
      }else if(error!==undefined&&guards.isNotApplied(args.projectId,original.input,error)===true){
        if(!object(error)||typeof error.code!=='string')fail('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');
        outcome={status:'not_applied',code:error.code,resolvedAt:new Date().toISOString()};result=null;
      }
      if(outcome){
        fault('beforeOutcomePersist');latest=finish();
        // Recheck historical ownership and absence directly before the durable
        // terminal transition; a late callback never overwrites another claim.
        const currentReceipt=receipt(args,original);if(outcome.status==='applied'?!same(currentReceipt,result):currentReceipt!==null)fail('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');
        if(latest.row.intentRevision===Number.MAX_SAFE_INTEGER)fail('LOCAL_SHOT_TEXT_CONFLICT');
        const next:LocalShotTextSlot={...latest.row,intentRevision:latest.row.intentRevision+1,intent:{...latest.intent,outcome}};
        const captured=original.draft,currentDraft=latest.row.draft;
        if(outcome.status==='applied'&&captured&&currentDraft&&latest.row.draftRevision===captured.revision&&currentDraft.draftId===captured.draftId&&currentDraft.baseRevision===original.baseRevision&&same(currentDraft.baseText,original.baseText)&&same(currentDraft.raw,captured.raw)){
          if(next.draftRevision===Number.MAX_SAFE_INTEGER)fail('LOCAL_SHOT_TEXT_CONFLICT');next.draftRevision++;next.draft=null;
        }
        replace(latest.disk,next);
        const provenOutcome=outcome;
        try{persist(latest.disk,()=>{
          writable(args);const actual=slot(read(),args);if(!shot(args))fail('LOCAL_SHOT_TEXT_CONFLICT');const saved=receipt(args,original);
          if(!same(actual,latest.row)&&!same(actual,next))fail('LOCAL_SHOT_TEXT_CONFLICT');
          if(provenOutcome.status==='applied'?!same(saved,result):saved!==null)fail('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');
        });}catch(error){uncertain.set(args.projectId,args.intentId);throw error;}
        uncertain.delete(args.projectId);saveUncertain=false;return {envelope:response(next),response:outcome.status==='applied'?clone(result):null};
      }
      return {envelope:response(latest.row),response:null};
    }catch(error){if(error instanceof LocalShotTextError)throw error;if(error instanceof LocalDraftRepositoryError)fail(`LOCAL_SHOT_TEXT_${error.reason}`);fail('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');}
  }
  function execute(value:unknown):Promise<LocalShotTextExecution>{
    return guarded(()=>{
      mutation();if(!active())return Promise.resolve({envelope:unsupported,response:null});
      const args=parse(schemas.execute,value),found=exact(args);
      // A terminal intent can be observed again only with its current revision.
      if(terminal(found.intent)){shot(args);const saved=evidence(found.row);confirmSaved();const latest=exact(args);if(!same(latest.intent,found.intent))fail('LOCAL_SHOT_TEXT_CONFLICT');evidence(latest.row);uncertain.delete(args.projectId);saveUncertain=false;return Promise.resolve({envelope:response(latest.row),response:found.intent.outcome.status==='applied'?clone(saved):null});}
      const activeFlight=flights.get(args.projectId);
      if(activeFlight){if(activeFlight.intentId!==args.intentId||activeFlight.revision!==args.expectedIntentRevision)fail('LOCAL_SHOT_TEXT_CONFLICT');return activeFlight.promise;}
      const promise=Promise.resolve().then(()=>run(args)).finally(()=>{if(flights.get(args.projectId)?.promise===promise)flights.delete(args.projectId);});
      flights.set(args.projectId,{intentId:args.intentId,revision:args.expectedIntentRevision,promise});
      return promise;
    });
  }
  return {
    assertProjectDeletable(projectId:string):void{guarded(()=>{admission();owned();if(!/^[a-f0-9-]{36}$/iu.test(projectId))fail('LOCAL_SHOT_TEXT_VALIDATION');const disk=read();if(flights.has(projectId)||uncertain.has(projectId)||saveUncertain||disk.entries.some(row=>row.projectId===projectId&&row.intent&&row.intent.outcome.status==='pending'))fail('LOCAL_SHOT_TEXT_CONFLICT');});},
    removeProject(projectId:string):void{guarded(()=>{mutation();owned();if(!/^[a-f0-9-]{36}$/iu.test(projectId))fail('LOCAL_SHOT_TEXT_VALIDATION');const disk=read();if(flights.has(projectId)||uncertain.has(projectId)||saveUncertain||disk.entries.some(row=>row.projectId===projectId&&row.intent&&row.intent.outcome.status==='pending'))fail('LOCAL_SHOT_TEXT_CONFLICT');const entries=disk.entries.filter(row=>row.projectId!==projectId);if(entries.length===disk.entries.length)return;disk.entries=entries;persist(disk);confirmSaved();});},
    get(value:unknown):LocalShotTextEnvelope{return guarded(()=>{admission();if(!active())return unsupported;const key=parse(schemas.key,value);return response(slot(read(),key));});},
    put(value:unknown):LocalShotTextEnvelope{return guarded(()=>{
      mutation();if(!active())return unsupported;const args=parse(schemas.put,value);writable(args);const disk=read(),row=slot(disk,args),current=shot(args);evidence(row);
      const nextDraft={draftId:args.draftId,baseRevision:args.baseRevision,baseText:args.baseText,raw:args.raw};
      if(row.draftRevision===args.expectedDraftRevision+1&&row.draft&&same(nextDraft,{draftId:row.draft.draftId,baseRevision:row.draft.baseRevision,baseText:row.draft.baseText,raw:row.draft.raw})){confirmSaved();saveUncertain=false;return response(row);}
      if(row.draftRevision!==args.expectedDraftRevision||row.draftRevision===Number.MAX_SAFE_INTEGER)fail('LOCAL_SHOT_TEXT_CONFLICT');
      if(row.draft?(row.draft.draftId!==args.draftId||row.draft.baseRevision!==args.baseRevision||!same(row.draft.baseText,args.baseText)):target(nextDraft,current)!=='matching')fail('LOCAL_SHOT_TEXT_CONFLICT');
      const next={...row,draftRevision:row.draftRevision+1,draft:{...nextDraft,updatedAt:new Date().toISOString()}};replace(disk,next);persist(disk,()=>{const actual=shot(args);evidence(row);if(!row.draft&&target(nextDraft,actual)!=='matching')fail('LOCAL_SHOT_TEXT_CONFLICT');});return response(next);
    });},
    discard(value:unknown):LocalShotTextEnvelope{return guarded(()=>{
      mutation();if(!active())return unsupported;const args=parse(schemas.discard,value);writable(args);const disk=read(),row=slot(disk,args);shot(args);evidence(row);
      if(!row.draft||row.draft.draftId!==args.draftId||row.draftRevision!==args.expectedDraftRevision||row.draftRevision===Number.MAX_SAFE_INTEGER)fail('LOCAL_SHOT_TEXT_CONFLICT');
      const next={...row,draftRevision:row.draftRevision+1,draft:null};replace(disk,next);persist(disk,()=>{shot(args);evidence(row);});return response(next);
    });},
    prepare(value:unknown):LocalShotTextEnvelope{return guarded(()=>{
      mutation();if(!active())return unsupported;const args=parse(schemas.prepare,value);writable(args);const disk=read(),row=slot(disk,args),current=shot(args);evidence(row);
      const intent={intentId:args.intentId,baseRevision:args.baseRevision,baseText:args.baseText,draft:args.draft,input:args.input};
      if(row.intentRevision===args.expectedIntentRevision+1&&row.intent&&same(intent,{intentId:row.intent.intentId,baseRevision:row.intent.baseRevision,baseText:row.intent.baseText,draft:row.intent.draft,input:row.intent.input})){confirmSaved();saveUncertain=false;return response(row);}
      if(row.intentRevision!==args.expectedIntentRevision||(row.intent?.intentId??null)!==args.expectedIntentId||row.intentRevision===Number.MAX_SAFE_INTEGER||pending(disk,args.projectId)||flights.has(args.projectId)||uncertain.has(args.projectId)||saveUncertain)fail('LOCAL_SHOT_TEXT_CONFLICT');
      if(disk.entries.some(item=>item.intent&&(item.intent.intentId===args.intentId||item.intent.input.requestId===args.input.requestId)))fail('LOCAL_SHOT_TEXT_CONFLICT');
      if(target(intent,current)!=='matching')fail('LOCAL_SHOT_TEXT_CONFLICT');
      if(!row.draft||row.draftRevision!==args.draft.revision||row.draft.draftId!==args.draft.draftId||row.draft.baseRevision!==args.baseRevision||!same(row.draft.baseText,args.baseText)||!same(row.draft.raw,args.draft.raw))fail('LOCAL_SHOT_TEXT_CONFLICT');
      const next:LocalShotTextSlot={...row,intentRevision:row.intentRevision+1,intent:{...intent,createdAt:new Date().toISOString(),outcome:{status:'pending'}}};
      replace(disk,next);persist(disk,()=>{const actual=shot(args);evidence(row);if(target(intent,actual)!=='matching')fail('LOCAL_SHOT_TEXT_CONFLICT');});return response(next);
    });},
    execute,recover:execute,
    isBusy:():boolean=>flights.size>0,
    drain():Promise<void>{
      draining=true;
      // Every flight includes its finally. A settled business rejection has no
      // remaining resource to drain; the host separately bounds this full join.
      return drainPromise??=Promise.allSettled([...flights.values()].map(flight=>flight.promise)).then(()=>{});
    },
  };
}

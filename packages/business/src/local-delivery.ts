import {createHash,randomUUID} from 'node:crypto';
import {constants,openSync,closeSync,fsyncSync,fstatSync} from 'node:fs';
import {isProxy} from 'node:util/types';
import path from 'node:path';
import {LOCAL_DELIVERY_LIMITS,createLocalDeliverySchemas} from '@mioon/contracts/local-delivery';
import type {LocalDeliveryRenderInput,LocalDeliveryDraftValue,LocalDeliveryIntent,LocalDeliverySlot,LocalDeliveryDisk,LocalDeliveryEnvelope,LocalDeliveryExecution,LocalDeliveryExecute} from '@mioon/contracts/local-delivery';
import type {LocalDraftStorage} from './local-drafts.ts';

export const LOCAL_DELIVERY_FILENAME='local-delivery-v1.json';
const messages={
  LOCAL_DELIVERY_VALIDATION:[400,'成片草稿参数无效。'],
  LOCAL_DELIVERY_CONFLICT:[409,'成片草稿或导出意图已变化。请重新读取。'],
  LOCAL_DELIVERY_STALE_INSTANCE:[409,'本地服务已重新启动。请重新读取后显式恢复。'],
  LOCAL_DELIVERY_SCOPE_MISMATCH:[409,'成片草稿属于另一个工作区或渠道。'],
  LOCAL_DELIVERY_OWNER_REQUIRED:[403,'成片草稿需要持有当前工作区锁。'],
  LOCAL_DELIVERY_NOT_FOUND:[404,'成片草稿所属项目或时间线不存在。'],
  LOCAL_DELIVERY_LIMIT:[413,'成片草稿超过大小限制。'],
  LOCAL_DELIVERY_CAPACITY:[507,'成片草稿容量已满，已有记录保持不变。'],
  LOCAL_DELIVERY_STORAGE_UNAVAILABLE:[503,'无法安全读取或保存成片草稿，已有记录未被重置。'],
  LOCAL_DELIVERY_SAVE_UNCERTAIN:[503,'成片记录的持久化确认未完成。请重新读取并显式恢复。'],
} as const;
type ErrorCode=keyof typeof messages;
export class LocalDeliveryError extends Error{
  readonly code:ErrorCode;readonly status:number;
  constructor(code:ErrorCode){super(messages[code][1]);this.code=code;this.status=messages[code][0];}
}
function fail(code:ErrorCode):never{throw new LocalDeliveryError(code);}
export function safeLocalDeliveryError(error:unknown):{status:number;code:ErrorCode;message:string}{
  const safe=error instanceof LocalDeliveryError?error:new LocalDeliveryError('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');
  return {status:safe.status,code:safe.code,message:safe.message};
}
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>object(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const same=(a:unknown,b:unknown):boolean=>canonical(a)===canonical(b);
const sha=(value:unknown):string=>createHash('sha256').update(canonical(value)).digest('hex');
const terminal=(intent:LocalDeliveryIntent|null):boolean=>intent!==null&&intent.outcome.status!=='pending';
function plain(value:unknown,depth=0,budget={nodes:0}):void{
  if(++budget.nodes>128||depth>8)fail('LOCAL_DELIVERY_VALIDATION');
  if(value===null||typeof value==='boolean')return;
  if(typeof value==='number'){if(!Number.isFinite(value))fail('LOCAL_DELIVERY_VALIDATION');return;}
  if(typeof value==='string'){if(value.length>LOCAL_DELIVERY_LIMITS.httpBytes)fail('LOCAL_DELIVERY_LIMIT');return;}
  if(!object(value)||isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('LOCAL_DELIVERY_VALIDATION');
  for(const key of Reflect.ownKeys(value)){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(typeof key!=='string'||key==='__proto__'||!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))fail('LOCAL_DELIVERY_VALIDATION');
    plain(descriptor.value,depth+1,budget);
  }
}
function parse<T>(schema:{safeParse(input:unknown):{success:true;data:T}|{success:false}},value:unknown):T{
  plain(value);if(Buffer.byteLength(JSON.stringify(value))>LOCAL_DELIVERY_LIMITS.httpBytes)fail('LOCAL_DELIVERY_LIMIT');
  const result=schema.safeParse(value);if(!result.success)fail('LOCAL_DELIVERY_VALIDATION');return result.data;
}
export interface LocalDeliveryGuards{
  ownsLock():boolean;isRestored():boolean;
  /** Existing bounded ownership reader, never timeline.get's initializing path. */
  readTimeline(projectId:string):unknown;
  /** Original hash checked, ownership-validated shared receipt, publicValue only. */
  readReceipt(input:LocalDeliveryRenderInput):unknown|null;
  isRenderInput(value:unknown):boolean;
  isRenderResponse(input:LocalDeliveryRenderInput,value:unknown):boolean;
  isNotApplied(input:LocalDeliveryRenderInput,error:unknown):boolean;
  /** The backend binds only services.call('timeline.render', input). */
  render(input:LocalDeliveryRenderInput):Promise<unknown>;
}
export type LocalDeliveryFaultPoint='beforePersist'|'afterPersist'|'beforeDirectorySync'|'afterDirectorySync'|'beforeDispatch'|'afterDispatch'|'beforeOutcomePersist';
export interface LocalDeliveryOptions{
  root:string;channel?:'web'|'production'|'development';guards:LocalDeliveryGuards;storage:LocalDraftStorage;signal?:AbortSignal;
  fault?:(point:LocalDeliveryFaultPoint)=>void;
}
const unsupported={supported:false,reason:'RESTORED_WORKSPACE_UNSUPPORTED'} as const;

/** Local title and one immutable latest export intention per project. This is
 * deliberately not an operation journal, renderer settlement API or RPC tool.
 * A pending reservation is durable before the single fixed service can run. */
export function createLocalDelivery({root,channel='web',guards,storage,signal,fault=()=>{}}:LocalDeliveryOptions){
  if(!path.isAbsolute(root)||!['web','production','development'].includes(channel))fail('LOCAL_DELIVERY_VALIDATION');
  const schemas=createLocalDeliverySchemas(guards.isRenderInput),file=path.join(root,LOCAL_DELIVERY_FILENAME),instanceId=randomUUID();
  const flights=new Map<string,{intentId:string;revision:number;promise:Promise<LocalDeliveryExecution>}>();
  const readDigests=new WeakMap<LocalDeliveryDisk,string>(),uncertain=new Map<string,string>();
  let scope:string|undefined;
  function guarded<T>(fn:()=>T):T{try{return fn();}catch(error){if(error instanceof LocalDeliveryError)throw error;fail('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');}}
  function owned():void{if(guards.isRestored())fail('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');if(signal?.aborted)fail('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');if(guards.ownsLock()!==true)fail('LOCAL_DELIVERY_OWNER_REQUIRED');}
  function active():boolean{if(guards.isRestored())return false;owned();return true;}
  function identity():string{
    const directory=storage.validatePrivateDirectory(root),db=storage.validateManagedFile(path.join(root,'workbench.sqlite'),{root});
    if(!directory||!db)fail('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');
    const current=createHash('sha256').update(JSON.stringify([channel,path.resolve(root),String(directory.dev),String(directory.ino),String(db.dev),String(db.ino),db.birthtimeMs??null])).digest('hex');
    if(scope!==undefined&&scope!==current)fail('LOCAL_DELIVERY_SCOPE_MISMATCH');scope=current;return current;
  }
  function writable(args:{workspaceScope:string;instanceId:string}):void{
    owned();if(args.workspaceScope!==identity())fail('LOCAL_DELIVERY_SCOPE_MISMATCH');
    if(args.instanceId!==instanceId)fail('LOCAL_DELIVERY_STALE_INSTANCE');
  }
  function read():LocalDeliveryDisk{
    owned();const workspaceScope=identity(),bytes=storage.readPrivateFile(file,{root,allowMissing:true,private:true,maxBytes:LOCAL_DELIVERY_LIMITS.envelopeBytes});
    if(bytes===null){const empty:LocalDeliveryDisk={version:1,workspaceScope,entries:[]};readDigests.set(empty,sha(empty));return empty;}
    if(!Buffer.isBuffer(bytes)||bytes.length>LOCAL_DELIVERY_LIMITS.envelopeBytes)fail('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');
    let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');}
    const result=schemas.disk.safeParse(value);if(!result.success)fail('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');
    if(result.data.workspaceScope!==workspaceScope)fail('LOCAL_DELIVERY_SCOPE_MISMATCH');
    const projects=new Set<string>(),intents=new Set<string>(),requests=new Set<string>();
    for(const row of result.data.entries){
      if(projects.has(row.projectId)||Buffer.byteLength(JSON.stringify(row))>LOCAL_DELIVERY_LIMITS.rowBytes)fail('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');projects.add(row.projectId);
      if(row.intent){if(intents.has(row.intent.intentId)||requests.has(row.intent.input.requestId))fail('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');intents.add(row.intent.intentId);requests.add(row.intent.input.requestId);}
    }
    readDigests.set(result.data,sha(result.data));return result.data;
  }
  function slot(disk:LocalDeliveryDisk,projectId:string):LocalDeliverySlot{
    return disk.entries.find(row=>row.projectId===projectId)??{projectId,draftRevision:0,draft:null,intentRevision:0,intent:null};
  }
  function replace(disk:LocalDeliveryDisk,row:LocalDeliverySlot):void{
    const index=disk.entries.findIndex(item=>item.projectId===row.projectId);if(index<0)disk.entries.push(row);else disk.entries[index]=row;
  }
  function timeline(projectId:string):Record<string,unknown>|null{
    const value=guards.readTimeline(projectId);if(value===null)return null;
    if(!object(value)||value.projectId!==projectId||typeof value.id!=='string'||!Number.isSafeInteger(value.revision))fail('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');return value;
  }
  function target(value:Pick<LocalDeliveryDraftValue,'timelineId'|'baseRevision'>|null,current:Record<string,unknown>|null):'unset'|'matching'|'changed'|'missing'{
    if(!value)return 'unset';if(!current||current.id!==value.timelineId)return 'missing';return current.revision===value.baseRevision?'matching':'changed';
  }
  function receipt(intent:LocalDeliveryIntent):unknown|null{
    const value=guards.readReceipt(clone(intent.input));if(value===null)return null;
    if(guards.isRenderResponse(intent.input,value)!==true||!object(value)||value.status!=='queued'||!object(value.snapshot)||!object(value.snapshot.timeline)||value.snapshot.timeline.id!==intent.timelineId)fail('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');
    if(Buffer.byteLength(JSON.stringify(value))>LOCAL_DELIVERY_LIMITS.renderResponseBytes)fail('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');
    return value;
  }
  function evidence(row:LocalDeliverySlot):unknown|null{
    if(!row.intent)return null;const saved=receipt(row.intent);
    if(row.intent.outcome.status==='accepted'){
      if(!object(saved)||saved.id!==row.intent.outcome.exportId||sha(saved)!==row.intent.outcome.responseSha256)fail('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');
    }else if(row.intent.outcome.status==='not_applied'){
      if(saved!==null||guards.isNotApplied(row.intent.input,{code:row.intent.outcome.code,status:409,details:{mutationOutcome:'not_applied',operation:'timeline.render',projectId:row.projectId,requestId:row.intent.input.requestId}})!==true)fail('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');
    }
    return saved;
  }
  function response(row:LocalDeliverySlot):LocalDeliveryEnvelope{
    owned();const current=timeline(row.projectId);evidence(row);owned();
    const shown=uncertain.get(row.projectId)===row.intent?.intentId&&row.intent?{...row,intent:{...row.intent,outcome:{status:'pending' as const}}}:row;
    return clone({supported:true,workspaceScope:identity(),instanceId,...shown,draftTargetStatus:target(row.draft,current),intentTargetStatus:target(row.intent,current)});
  }
  function syncDirectory():void{
    owned();identity();try{
      fault('beforeDirectorySync');owned();identity();
      const expected=storage.validatePrivateDirectory(root);if(!expected)fail('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');
      const fd=openSync(root,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{const actual=fstatSync(fd);if(!actual.isDirectory()||actual.dev!==expected.dev||actual.ino!==expected.ino||actual.uid!==process.getuid?.()||(actual.mode&0o077))fail('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');fsyncSync(fd);}finally{closeSync(fd);}
      fault('afterDirectorySync');owned();identity();
    }catch{fail('LOCAL_DELIVERY_SAVE_UNCERTAIN');}
  }
  function persist(disk:LocalDeliveryDisk):void{
    owned();if(disk.workspaceScope!==identity())fail('LOCAL_DELIVERY_SCOPE_MISMATCH');
    const bytes=JSON.stringify(disk)+'\n';
    if(disk.entries.length>LOCAL_DELIVERY_LIMITS.slots||Buffer.byteLength(bytes)>LOCAL_DELIVERY_LIMITS.envelopeBytes)fail('LOCAL_DELIVERY_CAPACITY');
    if(disk.entries.some(row=>Buffer.byteLength(JSON.stringify(row))>LOCAL_DELIVERY_LIMITS.rowBytes))fail('LOCAL_DELIVERY_LIMIT');
    const before=readDigests.get(disk);if(before===undefined)fail('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');
    fault('beforePersist');owned();if(disk.workspaceScope!==identity())fail('LOCAL_DELIVERY_SCOPE_MISMATCH');
    if(sha(read())!==before)fail('LOCAL_DELIVERY_CONFLICT');
    let published=false;try{storage.writePrivateFileAtomic(file,bytes,{root,private:true,maxBytes:LOCAL_DELIVERY_LIMITS.envelopeBytes});published=true;fault('afterPersist');if(sha(read())!==sha(disk))fail('LOCAL_DELIVERY_SAVE_UNCERTAIN');syncDirectory();if(sha(read())!==sha(disk))fail('LOCAL_DELIVERY_SAVE_UNCERTAIN');}
    catch(error){if(published)fail('LOCAL_DELIVERY_SAVE_UNCERTAIN');throw error;}
  }
  function exact(args:LocalDeliveryExecute):{disk:LocalDeliveryDisk;row:LocalDeliverySlot;intent:LocalDeliveryIntent}{
    writable(args);const disk=read(),row=slot(disk,args.projectId);
    if(!row.intent||row.intent.intentId!==args.intentId||row.intentRevision!==args.expectedIntentRevision)fail('LOCAL_DELIVERY_CONFLICT');
    return {disk,row,intent:row.intent};
  }
  async function run(args:LocalDeliveryExecute):Promise<LocalDeliveryExecution>{
    // Scheduled only after the project single-flight claim is installed.
    const initial=exact(args),original=clone(initial.intent),originalDigest=sha(original);
    const finish=():{disk:LocalDeliveryDisk;row:LocalDeliverySlot;intent:LocalDeliveryIntent}=>{
      const latest=exact(args);if(sha(latest.intent)!==originalDigest)fail('LOCAL_DELIVERY_CONFLICT');
      const current=timeline(args.projectId);if(!current||current.id!==original.timelineId)fail('LOCAL_DELIVERY_CONFLICT');return latest;
    };
    try{
      finish();syncDirectory(); // Includes an earlier uncertain prepare publication.
      let result=receipt(original),error:unknown;
      if(result===null){
        fault('beforeDispatch');finish();
        try{result=await guards.render(clone(original.input));}catch(caught){error=caught;}
        fault('afterDispatch');
      }
      let latest=finish();const saved=receipt(original);
      let outcome:LocalDeliveryIntent['outcome']|null=null;
      if(saved!==null){
        if(!object(saved)||typeof saved.id!=='string')fail('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');
        if(error===undefined&&result!==null&&(guards.isRenderResponse(original.input,result)!==true||!same(result,saved)))fail('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');
        outcome={status:'accepted',exportId:saved.id,responseSha256:sha(saved),resolvedAt:new Date().toISOString()};result=saved;
      }else if(error!==undefined&&guards.isNotApplied(original.input,error)===true){
        if(!object(error)||typeof error.code!=='string')fail('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');
        outcome={status:'not_applied',code:error.code,resolvedAt:new Date().toISOString()};result=null;
      }
      if(outcome){
        fault('beforeOutcomePersist');latest=finish();
        // Recheck historical ownership and absence directly before the durable
        // terminal transition; a late callback never overwrites another claim.
        const currentReceipt=receipt(original);if(outcome.status==='accepted'?!same(currentReceipt,result):currentReceipt!==null)fail('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');
        if(latest.row.intentRevision===Number.MAX_SAFE_INTEGER)fail('LOCAL_DELIVERY_CONFLICT');
        const next:LocalDeliverySlot={...latest.row,intentRevision:latest.row.intentRevision+1,intent:{...latest.intent,outcome}};
        const captured=original.draft,currentDraft=latest.row.draft;
        if(outcome.status==='accepted'&&captured&&currentDraft&&latest.row.draftRevision===captured.revision&&currentDraft.draftId===captured.draftId&&currentDraft.timelineId===original.timelineId&&currentDraft.baseRevision===original.baseRevision&&same(currentDraft.raw,captured.raw)){
          if(next.draftRevision===Number.MAX_SAFE_INTEGER)fail('LOCAL_DELIVERY_CONFLICT');next.draftRevision++;next.draft=null;
        }
        replace(latest.disk,next);
        try{persist(latest.disk);}catch(error){uncertain.set(args.projectId,args.intentId);throw error;}
        uncertain.delete(args.projectId);return {envelope:response(next),response:outcome.status==='accepted'?clone(result):null};
      }
      return {envelope:response(latest.row),response:null};
    }catch(error){if(error instanceof LocalDeliveryError)throw error;fail('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');}
  }
  function execute(value:unknown):Promise<LocalDeliveryExecution>{
    return guarded(()=>{
      if(!active())return Promise.resolve({envelope:unsupported,response:null});
      const args=parse(schemas.execute,value),found=exact(args);
      // A terminal intent can be observed again only with its current revision.
      if(terminal(found.intent)){timeline(args.projectId);const saved=evidence(found.row);syncDirectory();const latest=exact(args);if(!same(latest.intent,found.intent))fail('LOCAL_DELIVERY_CONFLICT');evidence(latest.row);uncertain.delete(args.projectId);return Promise.resolve({envelope:response(latest.row),response:found.intent.outcome.status==='accepted'?clone(saved):null});}
      const activeFlight=flights.get(args.projectId);
      if(activeFlight){if(activeFlight.intentId!==args.intentId||activeFlight.revision!==args.expectedIntentRevision)fail('LOCAL_DELIVERY_CONFLICT');return activeFlight.promise;}
      const promise=Promise.resolve().then(()=>run(args));
      flights.set(args.projectId,{intentId:args.intentId,revision:args.expectedIntentRevision,promise});
      void promise.finally(()=>{if(flights.get(args.projectId)?.promise===promise)flights.delete(args.projectId);}).catch(()=>{});
      return promise;
    });
  }
  return {
    get(value:unknown):LocalDeliveryEnvelope{return guarded(()=>{if(!active())return unsupported;const {projectId}=parse(schemas.project,value);return response(slot(read(),projectId));});},
    put(value:unknown):LocalDeliveryEnvelope{return guarded(()=>{
      if(!active())return unsupported;const args=parse(schemas.put,value);writable(args);const disk=read(),row=slot(disk,args.projectId),current=timeline(args.projectId);evidence(row);
      const nextDraft={draftId:args.draftId,timelineId:args.timelineId,baseRevision:args.baseRevision,raw:args.raw};
      if(row.draftRevision===args.expectedDraftRevision+1&&row.draft&&same(nextDraft,{draftId:row.draft.draftId,timelineId:row.draft.timelineId,baseRevision:row.draft.baseRevision,raw:row.draft.raw})){syncDirectory();return response(row);}
      if(row.draftRevision!==args.expectedDraftRevision||row.draftRevision===Number.MAX_SAFE_INTEGER)fail('LOCAL_DELIVERY_CONFLICT');
      if(row.draft?(row.draft.draftId!==args.draftId||row.draft.timelineId!==args.timelineId||row.draft.baseRevision!==args.baseRevision):target(nextDraft,current)!=='matching')fail('LOCAL_DELIVERY_CONFLICT');
      const next={...row,draftRevision:row.draftRevision+1,draft:{...nextDraft,updatedAt:new Date().toISOString()}};replace(disk,next);persist(disk);return response(next);
    });},
    discard(value:unknown):LocalDeliveryEnvelope{return guarded(()=>{
      if(!active())return unsupported;const args=parse(schemas.discard,value);writable(args);const disk=read(),row=slot(disk,args.projectId);timeline(args.projectId);evidence(row);
      // Tombstones retain revision but not draftId. Without the exact deleted
      // identity, a repeated DELETE must reread rather than manufacture an ACK.
      if(!row.draft||row.draft.draftId!==args.draftId||row.draftRevision!==args.expectedDraftRevision||row.draftRevision===Number.MAX_SAFE_INTEGER)fail('LOCAL_DELIVERY_CONFLICT');
      const next={...row,draftRevision:row.draftRevision+1,draft:null};replace(disk,next);persist(disk);return response(next);
    });},
    prepare(value:unknown):LocalDeliveryEnvelope{return guarded(()=>{
      if(!active())return unsupported;const args=parse(schemas.prepare,value);writable(args);const disk=read(),row=slot(disk,args.projectId),current=timeline(args.projectId);evidence(row);
      const intent={intentId:args.intentId,timelineId:args.timelineId,baseRevision:args.baseRevision,draft:args.draft,input:args.input};
      if(row.intentRevision===args.expectedIntentRevision+1&&row.intent&&same(intent,{intentId:row.intent.intentId,timelineId:row.intent.timelineId,baseRevision:row.intent.baseRevision,draft:row.intent.draft,input:row.intent.input})){syncDirectory();return response(row);}
      if(row.intentRevision!==args.expectedIntentRevision||(row.intent?.intentId??null)!==args.expectedIntentId||row.intentRevision===Number.MAX_SAFE_INTEGER||row.intent&&!terminal(row.intent)||flights.has(args.projectId)||uncertain.has(args.projectId))fail('LOCAL_DELIVERY_CONFLICT');
      if(disk.entries.some(item=>item.intent&&(item.intent.intentId===args.intentId||item.intent.input.requestId===args.input.requestId)))fail('LOCAL_DELIVERY_CONFLICT');
      if(target(intent,current)!=='matching')fail('LOCAL_DELIVERY_CONFLICT');
      if(args.draft&&(!row.draft||row.draftRevision!==args.draft.revision||row.draft.draftId!==args.draft.draftId||row.draft.timelineId!==args.timelineId||row.draft.baseRevision!==args.baseRevision||!same(row.draft.raw,args.draft.raw)))fail('LOCAL_DELIVERY_CONFLICT');
      const next:LocalDeliverySlot={...row,intentRevision:row.intentRevision+1,intent:{...intent,createdAt:new Date().toISOString(),outcome:{status:'pending'}}};
      replace(disk,next);persist(disk);return response(next);
    });},
    execute,recover:execute,
  };
}

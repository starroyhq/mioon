import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {audioPreviewSourceInputSchema,AUDIO_PREVIEW_LIMITS} from '@mioon/contracts/timeline-audio-preview';
import {continuousAudioBlockInputSchema,continuousAudioQuery,CONTINUOUS_AUDIO_ENDPOINT,CONTINUOUS_AUDIO_LIMITS} from '@mioon/contracts/timeline-audio-continuous';
import type {ContinuousAudioBlockInput} from '@mioon/contracts/timeline-audio-continuous';
import {nativeAudioConfigSchema,nativeAudioProofSchema,nativeAudioProofMaterial,nativeAudioSourceQuery,sameNativeAudioOwner,
  NATIVE_AUDIO_PCM_PATH,NATIVE_AUDIO_LEASE_HEADER,NATIVE_AUDIO_PROOF_HEADER,NATIVE_AUDIO_SIGNATURE_HEADER} from '@mioon/contracts/native-audio-preview';
import type {NativeAudioCommand,NativeAudioReply,NativeAudioConfig,NativeAudioLease,NativeAudioOwner,NativeAudioProof} from '@mioon/contracts/native-audio-preview';
import {nativeAudioRequestSchema,NATIVE_AUDIO_EVENT} from './native-audio-preview-protocol.ts';
import type {NativeAudioAcquireResult,NativeAudioEvent} from './native-audio-preview-protocol.ts';

export interface NativeAudioFrame {readonly url:string;isDestroyed?():boolean;readonly detached?:boolean}
export interface NativeAudioContents {readonly mainFrame:NativeAudioFrame;send(channel:string,value:NativeAudioEvent):void}
export interface NativeAudioDocument extends NativeAudioOwner {
  readonly contents:NativeAudioContents;readonly frame:NativeAudioFrame;isCurrent():boolean;
}
export interface NativeAudioSigner {readonly config:NativeAudioConfig;sign(proof:NativeAudioProof):string}
/** Private signing material is captured in this main-process closure only. It
 * is never returned, exported, persisted, logged or derived from session auth. */
export function createNativeAudioPreviewSigningIdentity(backendId:string):NativeAudioSigner {
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const config=nativeAudioConfigSchema.parse({version:1,backendId,publicKey:publicKey.export({format:'der',type:'spki'}).toString('hex')});
  return Object.freeze({config:Object.freeze(config),sign(proof:NativeAudioProof):string{
    const parsed=nativeAudioProofSchema.parse(proof);if(parsed.backendId!==backendId)throw Error('Native audio epoch mismatch');
    return sign(null,Buffer.from(nativeAudioProofMaterial(parsed)),privateKey).toString('hex');
  }});
}
interface Options {
  readonly backendId:string;readonly origin:string;readonly signer:NativeAudioSigner;
  /** Current main-owned lifecycle permission for new admission only. Cleanup
   * keeps its separate exact document identity through Quit/Restart requests. */
  isAdmissionAllowed():boolean;
  ownerForContents(contents:NativeAudioContents):NativeAudioDocument|null;
  request(command:NativeAudioCommand,onPending?:()=>void):Promise<NativeAudioReply>;
  /** Main's exact owned supervisor only: actual utility exit plus confirmed
   * media retirement. Never derived from renderer or utility message claims. */
  isBackendExitConfirmed?():boolean;
}
interface Event {readonly sender:NativeAudioContents;readonly senderFrame:NativeAudioFrame|null}
interface RequestDetails {readonly id:number;readonly url:string;readonly method:string;readonly resourceType:string;
  readonly webContents?:NativeAudioContents;readonly frame?:NativeAudioFrame|null;readonly requestHeaders:Record<string,string|string[]>}
interface LeaseRecord {lease:NativeAudioLease;document:NativeAudioDocument;phase:'reserving'|'active'|'retiring'|'blocked';
  granted:boolean;sequence:number;generation:number;lastInput?:ContinuousAudioBlockInput;deleting:boolean;proofs:Map<number,{query:string;method:string;proof:string;signature:string}>;
  renderer:{promise:Promise<void>;resolve:()=>void};backend:{promise:Promise<void>;resolve:()=>void};retirement:Promise<boolean>|null}
interface Attempt {document:NativeAudioDocument;actionId:string;input:NativeAudioLease['input'];planHash:string;sessionId?:string;cancelled:boolean;promise:Promise<NativeAudioAcquireResult>}
const sameLease=(record:LeaseRecord,actionId:string,leaseId:string)=>record.lease.actionId===actionId&&record.lease.leaseId===leaseId;
const ownerOf=(document:NativeAudioDocument):NativeAudioOwner=>({backendId:document.backendId,windowId:document.windowId,contextId:document.contextId,projectId:document.projectId});
const publicResult=(status:'cancelled'|'blocked'|'unavailable'|'busy'):NativeAudioAcquireResult=>({status});
const completion=():{promise:Promise<void>;resolve:()=>void}=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const samePlan=(a:{input:NativeAudioLease['input'];planHash:string;sessionId?:string},b:{input:NativeAudioLease['input'];planHash:string;sessionId?:string}):boolean=>a.planHash===b.planHash&&a.sessionId===b.sessionId&&
  a.input.projectId===b.input.projectId&&a.input.timelineId===b.input.timelineId&&a.input.expectedRevision===b.input.expectedRevision&&a.input.startFrame===b.input.startFrame;

/** One app-wide retained audition, plus at most one waiting explicit action.
 * Native focus, window ordering and timeout never constitute resource proof. */
export function createNativeAudioPreviewHost(options:Options){
  if(options.signer.config.backendId!==options.backendId||new URL(options.origin).origin!==options.origin)throw Error('Invalid native audition owner');
  let active:LeaseRecord|null=null,pending:Attempt|null=null,disposed=false,admissionFenced=false;
  let draining:Promise<void>|null=null;
  // Only live WebContents keys are retained. A replacement document cannot
  // replay its predecessor's requests; no old-document graph is accumulated.
  const actions=new WeakMap<NativeAudioContents,{contextId:string;seen:Set<string>}>();
  const reloads=new WeakMap<NativeAudioContents,{owner:NativeAudioOwner;release:()=>void}>();
  // Actual destruction is remembered without retaining native handles or
  // querying any property/method on the already-destroyed Electron object.
  const destroyedContents=new WeakSet<NativeAudioContents>();
  const rememberDestroyed=(document:NativeAudioDocument):void=>{destroyedContents.add(document.contents);actions.delete(document.contents);};
  const trusted=(document:NativeAudioDocument,frame:NativeAudioFrame|null|undefined):boolean=>{
    try{return !disposed&&!destroyedContents.has(document.contents)&&document.backendId===options.backendId&&document.isCurrent()&&frame===document.frame&&frame===document.contents.mainFrame&&
      !frame.isDestroyed?.()&&!frame.detached&&frame.url===`${options.origin}/?project=${document.projectId}`;}
    catch{return false;}
  };
  const lookup=(event:Event):NativeAudioDocument|null=>{if(destroyedContents.has(event.sender))return null;const owner=options.ownerForContents(event.sender);return owner&&trusted(owner,event.senderFrame)?owner:null;};
  const notify=(document:NativeAudioDocument,event:NativeAudioEvent):void=>{if(destroyedContents.has(document.contents))return;try{document.contents.send(NATIVE_AUDIO_EVENT,event);}catch{/* Missing delivery is never cleanup proof. */}};
  const backendExitConfirmed=():boolean=>{try{return options.isBackendExitConfirmed?.()===true;}catch{return false;}};
  const lifecycleAdmissionAllowed=():boolean=>{try{return !admissionFenced&&options.isAdmissionAllowed()===true;}catch{return false;}};
  const admissionAllowed=(document:NativeAudioDocument):boolean=>{const reload=reloads.get(document.contents);
    return lifecycleAdmissionAllowed()&&(!reload||!sameNativeAudioOwner(reload.owner,document));};
  const block=(record:LeaseRecord):void=>{
    if(active!==record)return;record.phase='blocked';
    if(pending)notify(pending.document,{type:'blocked',owner:ownerOf(pending.document),actionId:pending.actionId});
  };
  function retire(record:LeaseRecord,reason:'handoff'|'release'|'owner-change'|'shutdown'):Promise<boolean>{
    if(record.retirement)return record.retirement;
    record.phase='retiring';
    if(!record.granted)record.renderer.resolve();
    else notify(record.document,{type:'revoke',lease:record.lease,reason});
    const command:NativeAudioCommand={type:'native-audio:retire',version:1,requestId:randomUUID(),owner:record.lease.owner,
      actionId:record.lease.actionId,leaseId:record.lease.leaseId};
    if(backendExitConfirmed())record.backend.resolve();
    else try{
      void options.request(command,()=>block(record)).then(reply=>{
        if(reply.status==='retired'&&reply.backendId===options.backendId&&reply.leaseId===record.lease.leaseId&&reply.requestId===command.requestId)record.backend.resolve();
        else if(backendExitConfirmed())record.backend.resolve();else block(record);
      },()=>{if(backendExitConfirmed())record.backend.resolve();else block(record);});
    }catch{if(backendExitConfirmed())record.backend.resolve();else block(record);}
    // IPC failure remains an unknown backend half, not a permanently rejected
    // combined proof. A later trusted exact-process exit can still settle it.
    record.retirement=Promise.all([record.backend.promise,record.renderer.promise]).then(()=>{if(active===record)active=null;return true;});
    return record.retirement;
  }
  function acquire(document:NativeAudioDocument,request:Extract<ReturnType<typeof nativeAudioRequestSchema.parse>,{action:'acquire'|'acquireContinuous'}>):Promise<NativeAudioAcquireResult>{
    if(request.input.projectId!==document.projectId)return Promise.resolve(publicResult('unavailable'));
    let known=actions.get(document.contents);
    if(!known||known.contextId!==document.contextId){known={contextId:document.contextId,seen:new Set()};actions.set(document.contents,known);}
    if(!admissionAllowed(document)){
      // A denied action cannot be replayed as a new gesture when Quit is
      // cancelled. The same bounded document ledger also covers these denials.
      if(known.seen.size<1024)known.seen.add(request.actionId);
      if(pending&&sameNativeAudioOwner(pending.document,document)&&pending.actionId===request.actionId)pending.cancelled=true;
      return Promise.resolve(publicResult('unavailable'));
    }
    if(pending){if(sameNativeAudioOwner(pending.document,document)&&pending.actionId===request.actionId)return samePlan(pending,request)?pending.promise:Promise.resolve(publicResult('unavailable'));return Promise.resolve(publicResult('busy'));}
    if(active&&sameNativeAudioOwner(active.lease.owner,document)&&active.lease.actionId===request.actionId){
      return Promise.resolve(!samePlan(active.lease,request)?publicResult('unavailable'):active.phase==='active'?{status:'granted',lease:active.lease}:publicResult('blocked'));
    }
    if(known.seen.has(request.actionId))return Promise.resolve(publicResult('cancelled'));
    // Never evict an identifier and thereby turn a replay into a fresh action.
    if(known.seen.size>=1024)return Promise.resolve(publicResult('unavailable'));
    known.seen.add(request.actionId);
    const attempt:Attempt={document,actionId:request.actionId,input:request.input,planHash:request.planHash,
      ...(request.action==='acquireContinuous'?{sessionId:request.sessionId}:{}),cancelled:false,promise:Promise.resolve(publicResult('unavailable'))};pending=attempt;
    const current=()=>admissionAllowed(document)&&pending===attempt&&!attempt.cancelled&&trusted(document,document.frame);
    attempt.promise=(async()=>{
      const previous=active;
      if(previous){notify(document,{type:'waiting',owner:ownerOf(document),actionId:attempt.actionId,waitingForWindowId:previous.lease.owner.windowId});
        if(!await retire(previous,'handoff'))return publicResult('blocked');}
      if(!current())return publicResult('cancelled');
      const record:LeaseRecord={lease:{owner:ownerOf(document),actionId:request.actionId,leaseId:randomUUID(),input:request.input,
        planHash:request.planHash,admittedBytes:AUDIO_PREVIEW_LIMITS.memoryBytes,...(request.action==='acquireContinuous'?{version:2 as const,sessionId:request.sessionId}:{})},document,phase:'reserving',granted:false,sequence:0,generation:0,deleting:false,proofs:new Map(),
        renderer:completion(),backend:completion(),retirement:null};
      // Suppress an unhandled rejection while a failed local retirement awaits its backend peer.
      void record.renderer.promise.catch(()=>{});active=record;
      const command:NativeAudioCommand={type:'native-audio:reserve',requestId:randomUUID(),owner:record.lease.owner,
        actionId:record.lease.actionId,leaseId:record.lease.leaseId,input:request.input,planHash:request.planHash,
        ...(request.action==='acquireContinuous'?{version:2 as const,sessionId:request.sessionId}:{version:1 as const})};
      try{
        const reply=await options.request(command,()=>{
          if(active===record&&pending===attempt)notify(document,{type:'blocked',owner:record.lease.owner,actionId:request.actionId});
        });
        if(reply.status==='rejected'&&['INVALID','UNAVAILABLE','STALE'].includes(reply.code)&&reply.requestId===command.requestId&&reply.leaseId===record.lease.leaseId&&reply.backendId===options.backendId&&record.phase==='reserving'&&!record.retirement){
          record.renderer.resolve();if(active===record)active=null;return publicResult('unavailable');
        }
        if(reply.status!=='reserved'||reply.backendId!==options.backendId||reply.leaseId!==record.lease.leaseId||reply.requestId!==command.requestId||reply.planHash!==request.planHash||
          !Number.isSafeInteger(reply.admittedBytes)||reply.admittedBytes<AUDIO_PREVIEW_LIMITS.transportReserveBytes||reply.admittedBytes>AUDIO_PREVIEW_LIMITS.memoryBytes||
          request.action==='acquireContinuous'&&reply.admittedBytes!==CONTINUOUS_AUDIO_LIMITS.memoryBytes)throw Error('Native reservation unavailable');
        record.lease=Object.freeze({...record.lease,admittedBytes:reply.admittedBytes});
        if(!current()){await retire(record,'release');return publicResult('cancelled');}
        record.granted=true;record.phase='active';return {status:'granted',lease:record.lease} as NativeAudioAcquireResult;
      }catch{
        // A lost reserve reply may conceal a real backend reservation. Only an
        // exact retirement proof can release that uncertain record.
        const clean=await retire(record,'release');return publicResult(clean&&!current()?'cancelled':'blocked');
      }
    })().finally(()=>{if(pending===attempt)pending=null;});
    return attempt.promise;
  }
  function retireOwnerForReload(document:NativeAudioDocument,signal:AbortSignal):Promise<boolean>{
    // Navigation must not begin before this exact current document has retired.
    // Main/native-close owns the sole observation deadline through this signal;
    // abort releases only the attempt's admission fence, never resource proof.
    if(signal.aborted||!lifecycleAdmissionAllowed()||!trusted(document,document.frame))return Promise.resolve(false);
    const captured=lookup({sender:document.contents,senderFrame:document.frame});
    if(!captured||!sameNativeAudioOwner(captured,document))return Promise.resolve(false);
    reloads.get(document.contents)?.release();
    let released=false,finishObservation!:(value:false)=>void;
    const interrupted=new Promise<false>(resolve=>{finishObservation=resolve;});
    const record={owner:ownerOf(document),release:():void=>{
      if(released)return;released=true;signal.removeEventListener('abort',record.release);
      if(reloads.get(document.contents)===record)reloads.delete(document.contents);
      finishObservation(false);
    }};
    reloads.set(document.contents,record);signal.addEventListener('abort',record.release,{once:true});
    if(signal.aborted){record.release();return Promise.resolve(false);}
    const waiting=pending&&sameNativeAudioOwner(pending.document,document)?pending:null;
    if(waiting)waiting.cancelled=true;
    const owned=active&&sameNativeAudioOwner(active.lease.owner,document)?active:null;
    const retiring=owned?retire(owned,'owner-change'):Promise.resolve(true);
    const retired=Promise.all([retiring,waiting?.promise]).then(()=>!released&&reloads.get(document.contents)===record&&
      lifecycleAdmissionAllowed()&&trusted(document,document.frame)&&
      !(active&&sameNativeAudioOwner(active.lease.owner,document))&&!(pending&&sameNativeAudioOwner(pending.document,document)),()=>false);
    // Keep the fence after true: P0 capture/confirmation/commit are still ahead.
    // Only this native attempt's terminal signal can release its own fence.
    return Promise.race([retired,interrupted]);
  }
  const shutdownUnconfirmed=()=>Object.assign(new Error('The previous native sound audition has not confirmed retirement.'),{code:'NATIVE_AUDIO_UNCONFIRMED'});
  const fenceAdmission=():void=>{admissionFenced=true;if(pending)pending.cancelled=true;};
  async function shutdown({timeoutMs=10000}:{timeoutMs?:number}={}):Promise<void>{
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw shutdownUnconfirmed();
    fenceAdmission();
    if(!draining){
      const previous=active,waiting=pending?.promise;
      const retiring=previous?retire(previous,'shutdown'):Promise.resolve(true);
      draining=(async()=>{
        if(!await retiring)throw shutdownUnconfirmed();
        await waiting;
        // A provisional reserve may have been awaiting its exact utility reply
        // when shutdown fenced it. Its original action owns that final cleanup.
        if(active&&!await retire(active,'shutdown'))throw shutdownUnconfirmed();
        if(active||pending)throw shutdownUnconfirmed();
        disposed=true;
      })();
      void draining.catch(()=>{/* The owner remains charged; no replacement epoch is authorized. */});
    }
    let timer:ReturnType<typeof setTimeout>|undefined;
    const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(shutdownUnconfirmed()),timeoutMs);});
    try{await Promise.race([draining,deadline]);}finally{if(timer!==undefined)clearTimeout(timer);}
  }
  return {
    shutdown,
    retireOwnerForReload,
    async dispatch(event:Event,raw:unknown):Promise<NativeAudioAcquireResult|NativeAudioOwner|boolean|null>{
      const parsed=nativeAudioRequestSchema.safeParse(raw);if(!parsed.success)return false;
      const request=parsed.data,document=lookup(event);if(!document)return request.action==='describe'?null:request.action==='acquire'||request.action==='acquireContinuous'?publicResult('unavailable'):false;
      if(request.action==='describe')return ownerOf(document);
      if(request.contextId!==document.contextId)return request.action==='acquire'||request.action==='acquireContinuous'?publicResult('unavailable'):false;
      if(request.action==='acquire'||request.action==='acquireContinuous')return acquire(document,request);
      if(request.action==='cancel'){
        let matched=false;if(pending&&sameNativeAudioOwner(pending.document,document)&&pending.actionId===request.actionId){pending.cancelled=true;matched=true;}
        if(active&&sameNativeAudioOwner(active.lease.owner,document)&&active.lease.actionId===request.actionId){void retire(active,'release');matched=true;}
        return matched;
      }
      if(!active||!['retiring','blocked'].includes(active.phase)||!sameNativeAudioOwner(active.lease.owner,document)||!sameLease(active,request.actionId,request.leaseId))return false;
      if(request.status==='retired')active.renderer.resolve();else{
        active.phase='blocked';if(pending)notify(pending.document,{type:'blocked',owner:ownerOf(pending.document),actionId:pending.actionId});
      }
      return true;
    },
    beforeSendHeaders(details:RequestDetails):{cancel:boolean;requestHeaders?:Record<string,string|string[]>}{
      const headers:Record<string,string|string[]>={};let claimedLease:string|undefined;
      for(const [key,value] of Object.entries(details.requestHeaders)){
        const name=key.toLowerCase();if(name===NATIVE_AUDIO_LEASE_HEADER.toLowerCase()){if(typeof value==='string')claimedLease=value;continue;}
        if(name===NATIVE_AUDIO_PROOF_HEADER.toLowerCase()||name===NATIVE_AUDIO_SIGNATURE_HEADER.toLowerCase())continue;headers[key]=value;
      }
      let url:URL;try{url=new URL(details.url);}catch{return {cancel:true};}
      if(!url.pathname.startsWith('/api/timeline-audio-preview'))return {cancel:false,requestHeaders:headers};
      const record=active,document=details.webContents&&!destroyedContents.has(details.webContents)?options.ownerForContents(details.webContents):null;
      const cleanup=details.method==='DELETE'&&url.pathname===CONTINUOUS_AUDIO_ENDPOINT;
      if(!record||(!cleanup&&record.phase!=='active')||!document||!cleanup&&!admissionAllowed(document)||!trusted(document,details.frame)||!sameNativeAudioOwner(record.lease.owner,document)||claimedLease!==record.lease.leaseId||
        url.origin!==options.origin||url.username||url.password||url.hash||details.resourceType!=='xhr'||details.url.length>2048)return {cancel:true};
      if(!Number.isSafeInteger(details.id)||details.id<0)return {cancel:true};
      if('sessionId' in record.lease){
        if(url.pathname!==CONTINUOUS_AUDIO_ENDPOINT||details.method!=='GET'&&details.method!=='DELETE')return {cancel:true};
        const raw=Object.fromEntries(url.searchParams),parsed=continuousAudioBlockInputSchema.safeParse({...raw,
          expectedRevision:Number(raw.expectedRevision),startFrame:Number(raw.startFrame),generation:Number(raw.generation),sequence:Number(raw.sequence),blockStartFrame:Number(raw.blockStartFrame)});
        if(!parsed.success||url.search.slice(1)!==continuousAudioQuery(parsed.data))return {cancel:true};
        const input=parsed.data,expected=record.lease.input;
        if(input.projectId!==expected.projectId||input.timelineId!==expected.timelineId||input.expectedRevision!==expected.expectedRevision||
          input.startFrame!==expected.startFrame||input.planHash!==record.lease.planHash||input.sessionId!==record.lease.sessionId)return {cancel:true};
        let signed=record.proofs.get(details.id);
        if(signed&&(signed.query!==url.search||signed.method!==details.method))return {cancel:true};
        if(!signed){
          if(details.method==='GET'){
            if(record.deleting||input.sequence<=record.sequence||input.generation<record.generation||record.sequence>=CONTINUOUS_AUDIO_LIMITS.requests)return {cancel:true};
          }else if(record.deleting)return {cancel:true};
          const proof:NativeAudioProof={version:2,backendId:options.backendId,leaseId:record.lease.leaseId,method:details.method,input};
          try{signed={query:url.search,method:details.method,proof:Buffer.from(JSON.stringify(proof)).toString('base64url'),signature:options.signer.sign(proof)};}catch{return {cancel:true};}
          if(details.method==='GET'){record.sequence=input.sequence;record.generation=input.generation;record.lastInput=input;}else record.deleting=true;
          // The ledger has a strict session cap (10,000 GET + one DELETE), so
          // repeat webRequest callbacks remain idempotent without an LRU replay.
          record.proofs.set(details.id,signed);
        }
        headers[NATIVE_AUDIO_PROOF_HEADER]=signed.proof;headers[NATIVE_AUDIO_SIGNATURE_HEADER]=signed.signature;
        return {cancel:false,requestHeaders:headers};
      }
      if(url.pathname!==NATIVE_AUDIO_PCM_PATH||details.method!=='GET')return {cancel:true};
      const raw=Object.fromEntries(url.searchParams),parsed=audioPreviewSourceInputSchema.safeParse({...raw,expectedRevision:Number(raw.expectedRevision),startFrame:Number(raw.startFrame)});
      if(!parsed.success||url.search.slice(1)!==nativeAudioSourceQuery(parsed.data))return {cancel:true};
      const input=parsed.data,expected=record.lease.input;
      if(input.projectId!==expected.projectId||input.timelineId!==expected.timelineId||input.expectedRevision!==expected.expectedRevision||input.startFrame!==expected.startFrame||input.planHash!==record.lease.planHash)return {cancel:true};
      let signed=record.proofs.get(details.id);
      if(signed&&(signed.query!==url.search||signed.method!==details.method))return {cancel:true};
      if(!signed){
        if(record.sequence>=AUDIO_PREVIEW_LIMITS.clips)return {cancel:true};
        const proof:NativeAudioProof={version:1,backendId:options.backendId,leaseId:record.lease.leaseId,sequence:record.sequence+1,input};
        try{signed={query:url.search,method:'GET',proof:Buffer.from(JSON.stringify(proof)).toString('base64url'),signature:options.signer.sign(proof)};}catch{return {cancel:true};}
        record.sequence++;record.proofs.set(details.id,signed);
      }
      headers[NATIVE_AUDIO_PROOF_HEADER]=signed.proof;
      headers[NATIVE_AUDIO_SIGNATURE_HEADER]=signed.signature;
      return {cancel:false,requestHeaders:headers};
    },
    revokeOwner(owner:NativeAudioOwner,destroyed=false):void{
      if(pending&&sameNativeAudioOwner(pending.document,owner)){if(destroyed)rememberDestroyed(pending.document);pending.cancelled=true;}
      if(!active||!sameNativeAudioOwner(active.lease.owner,owner))return;
      const record=active;if(destroyed){rememberDestroyed(record.document);record.renderer.resolve();}void retire(record,'owner-change');
    },
    revokeWindowDestroyed(windowId:string):void{
      if(pending?.document.windowId===windowId){rememberDestroyed(pending.document);pending.cancelled=true;}
      if(active?.lease.owner.windowId===windowId){const record=active;rememberDestroyed(record.document);record.renderer.resolve();void retire(record,'owner-change');}
    },
    notifyBackendExit():boolean{
      if(!backendExitConfirmed())return false;
      fenceAdmission();
      if(active){const record=active;record.backend.resolve();void retire(record,'shutdown');}
      return true;
    },
    /** Fences only. Backend replacement requires awaiting shutdown(), not this
     * nonblocking teardown request or a BrowserWindow close event. */
    dispose():void{fenceAdmission();if(active)void retire(active,'shutdown');},
  };
}

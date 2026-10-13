import type {TimelineExportRange} from './timeline-export-range.ts';
import type {TimelineExportSettings} from './timeline-export-float.ts';
import {z} from 'zod';

// Private, local export-title recovery only. Nothing in this companion format
// adds an operation, changes timeline.render, or grants dispatch authority.
export const LOCAL_DELIVERY_LIMITS = Object.freeze({
  slots:128,rowBytes:8192,envelopeBytes:2*1024*1024,httpBytes:12*1024,urlBytes:2048,
  rawTitleUnits:512,renderResponseBytes:4*1024*1024,executeResponseBytes:4*1024*1024+12*1024,
});
const id=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/);
const revision=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const stamp=z.string().datetime();
const unicode=z.string().regex(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u);
const authority={workspaceScope:hash,instanceId:id};
const encoder=new TextEncoder();
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value:object,key:PropertyKey):boolean=>Object.hasOwn(value,key);
function bytesWithin(value:unknown,limit:number):boolean {
  try{const text=JSON.stringify(value);return typeof text==='string'&&encoder.encode(text).byteLength<=limit;}catch{return false;}
}
function issue(context:z.RefinementCtx,message:string):void{context.addIssue({code:'custom',message});}

// This is raw UI input: empty, whitespace, controls and overlength render names
// remain recoverable. Valid render names are checked by the existing schema.
export const localDeliveryDraftRawSchema=z.object({deliveryName:unicode.max(LOCAL_DELIVERY_LIMITS.rawTitleUnits)}).strict();
export const localDeliveryDraftValueSchema=z.object({
  draftId:id,timelineId:id,baseRevision:revision.min(1),raw:localDeliveryDraftRawSchema,updatedAt:stamp,
}).strict();
export const localDeliveryDraftCaptureSchema=z.object({draftId:id,revision:revision.min(1),raw:localDeliveryDraftRawSchema}).strict();
export const localDeliveryProjectSchema=z.object({projectId:id}).strict();
export const localDeliveryDraftPutSchema=z.object({
  ...authority,projectId:id,expectedDraftRevision:revision,draftId:id,timelineId:id,
  baseRevision:revision.min(1),raw:localDeliveryDraftRawSchema,
}).strict();
export const localDeliveryDraftDeleteSchema=z.object({
  ...authority,projectId:id,expectedDraftRevision:revision.min(1),draftId:id,
}).strict();
export const localDeliveryExecuteSchema=z.object({
  ...authority,projectId:id,intentId:id,expectedIntentRevision:revision.min(1),
}).strict();
export const localDeliveryUnsupportedSchema=z.object({supported:z.literal(false),reason:z.literal('RESTORED_WORKSPACE_UNSUPPORTED')}).strict();
export const localDeliveryOutcomeSchema=z.discriminatedUnion('status',[
  z.object({status:z.literal('pending')}).strict(),
  z.object({status:z.literal('accepted'),exportId:id,responseSha256:hash,resolvedAt:stamp}).strict(),
  z.object({status:z.literal('not_applied'),code:z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/),resolvedAt:stamp}).strict(),
]);
const targetStatus=z.enum(['unset','matching','changed','missing']);

// Type-only spelling of the existing closed profile. The injected canonical
// timeline.render validator, rather than a second schema, is runtime authority.
export type LocalDeliveryExportSettings=TimelineExportSettings;
export type LocalDeliveryRenderInput={
  projectId:string;expectedRevision:number;requestId:string;purpose:'export';
  deliveryName?:string;exportSettings?:LocalDeliveryExportSettings;preflightSnapshotHash?:string;exportRange?:TimelineExportRange;
};
export type LocalDeliveryInputValidator=(value:unknown)=>boolean;
export type LocalDeliveryDraftRaw=z.infer<typeof localDeliveryDraftRawSchema>;
export type LocalDeliveryDraftValue=z.infer<typeof localDeliveryDraftValueSchema>;
export type LocalDeliveryDraftCapture=z.infer<typeof localDeliveryDraftCaptureSchema>;
export type LocalDeliveryDraftPut=z.infer<typeof localDeliveryDraftPutSchema>;
export type LocalDeliveryDraftDelete=z.infer<typeof localDeliveryDraftDeleteSchema>;
export type LocalDeliveryExecute=z.infer<typeof localDeliveryExecuteSchema>;
export type LocalDeliveryOutcome=z.infer<typeof localDeliveryOutcomeSchema>;

const requiredInput=['projectId','expectedRevision','requestId','purpose'] as const;
const optionalInput=['deliveryName','exportSettings','preflightSnapshotHash','exportRange'] as const;
function exactRenderInput(value:unknown,validate:LocalDeliveryInputValidator):value is LocalDeliveryRenderInput {
  if(!object(value)||!requiredInput.every(key=>own(value,key))||
    Object.keys(value).some(key=>![...requiredInput,...optionalInput].includes(key as typeof requiredInput[number]|typeof optionalInput[number]))||
    optionalInput.some(key=>own(value,key)&&value[key]===undefined)||value.purpose!=='export'||
    !id.safeParse(value.projectId).success||!revision.min(1).safeParse(value.expectedRevision).success||
    typeof value.requestId!=='string'||value.requestId.length<8||value.requestId.length>200||
    !bytesWithin(value,LOCAL_DELIVERY_LIMITS.rowBytes))return false;
  try{return validate(value)===true;}catch{return false;}
}
function boundIdentity(value:{projectId:string;timelineId:string;baseRevision:number;draft:LocalDeliveryDraftCapture|null;input:LocalDeliveryRenderInput},context:z.RefinementCtx):void {
  if(value.input.projectId!==value.projectId||value.input.expectedRevision!==value.baseRevision)issue(context,'Frozen render input must match its project and baseline');
  const raw=value.draft?.raw.deliveryName??'';
  if(raw===''?own(value.input,'deliveryName'):!own(value.input,'deliveryName')||value.input.deliveryName!==raw)issue(context,'Frozen render name must exactly match the captured draft');
}

/** Supply a checked adapter for the existing schemas['timeline.render'].
 * Reads parse data only: they never execute, repair, rebase, or consult today's
 * capabilities. Input is a custom validator so its bytes/key presence are not
 * reordered, defaulted or normalized by a second Zod object parser. */
export function createLocalDeliverySchemas(isRenderInput:LocalDeliveryInputValidator){
  if(typeof isRenderInput!=='function')throw new TypeError('A canonical timeline.render input validator is required');
  const input=z.custom<LocalDeliveryRenderInput>((value:unknown)=>exactRenderInput(value,isRenderInput));
  const intent=z.object({
    intentId:id,timelineId:id,baseRevision:revision.min(1),draft:localDeliveryDraftCaptureSchema.nullable(),
    input,createdAt:stamp,outcome:localDeliveryOutcomeSchema,
  }).strict();
  const prepare=z.object({
    ...authority,projectId:id,expectedIntentRevision:revision,expectedIntentId:id.nullable(),intentId:id,
    timelineId:id,baseRevision:revision.min(1),draft:localDeliveryDraftCaptureSchema.nullable(),input,
  }).strict().superRefine((value,context)=>{
    if((value.expectedIntentRevision===0)!==(value.expectedIntentId===null))issue(context,'Prior intent identity must match its CAS revision');
    if(value.expectedIntentId===value.intentId)issue(context,'A new preparation must have a new intent identity');
    boundIdentity(value,context);
  });
  const slot=z.object({
    projectId:id,draftRevision:revision,draft:localDeliveryDraftValueSchema.nullable(),
    intentRevision:revision,intent:intent.nullable(),
  }).strict().superRefine((value,context)=>{
    if(value.draft!==null&&value.draftRevision===0)issue(context,'A retained draft requires a positive revision');
    if((value.intentRevision===0)!==(value.intent===null))issue(context,'Intent revisions never reset or discard their latest identity');
    if(value.intent)boundIdentity({...value.intent,projectId:value.projectId},context);
    if(!bytesWithin(value,LOCAL_DELIVERY_LIMITS.rowBytes))issue(context,'Local delivery slot exceeds its byte limit');
  });
  const disk=z.object({version:z.literal(1),workspaceScope:hash,entries:z.array(slot).max(LOCAL_DELIVERY_LIMITS.slots)}).strict().superRefine((value,context)=>{
    if(new Set(value.entries.map(entry=>entry.projectId)).size!==value.entries.length)issue(context,'Project slots must be unique');
    if(value.entries.some(entry=>entry.draftRevision===0&&entry.intentRevision===0))issue(context,'Empty untouched project slots must not be persisted');
    if(!bytesWithin(value,LOCAL_DELIVERY_LIMITS.envelopeBytes))issue(context,'Local delivery companion exceeds its byte limit');
  });
  // Independent target status prevents a newer draft from disguising an older
  // frozen intent. A changed current revision does not deny original replay.
  const supportedEnvelope=z.object({
    supported:z.literal(true),...authority,projectId:id,draftRevision:revision,draft:localDeliveryDraftValueSchema.nullable(),
    intentRevision:revision,intent:intent.nullable(),draftTargetStatus:targetStatus,intentTargetStatus:targetStatus,
  }).strict().superRefine((value,context)=>{
    const result=slot.safeParse({projectId:value.projectId,draftRevision:value.draftRevision,draft:value.draft,intentRevision:value.intentRevision,intent:value.intent});
    if(!result.success)issue(context,'Invalid local delivery slot');
    if((value.draft===null)!==(value.draftTargetStatus==='unset')||(value.intent===null)!==(value.intentTargetStatus==='unset'))issue(context,'Target status must describe its retained identity');
    if(!bytesWithin(value,LOCAL_DELIVERY_LIMITS.httpBytes))issue(context,'Local delivery response exceeds its byte limit');
  });
  const envelope=z.union([localDeliveryUnsupportedSchema,supportedEnvelope]);
  // Unknown is deliberate. Only the existing authoritative render ACK guard,
  // with this intent's exact input and timelineId, can establish acceptance.
  const execution=z.object({envelope,response:z.unknown().nullable()}).strict().superRefine((value,context)=>{
    if(!own(value,'response')||value.response===undefined)issue(context,'An execution must explicitly return its response or null');
    if(value.response!==null&&(!value.envelope.supported||value.envelope.intent?.outcome.status!=='accepted'))issue(context,'Only an accepted intent can carry an original response');
    if(value.response!==null&&!bytesWithin(value.response,LOCAL_DELIVERY_LIMITS.renderResponseBytes))issue(context,'Render response exceeds the existing render byte limit');
    if(!bytesWithin(value,LOCAL_DELIVERY_LIMITS.executeResponseBytes))issue(context,'Execution response exceeds its byte limit');
  });
  return {project:localDeliveryProjectSchema,put:localDeliveryDraftPutSchema,discard:localDeliveryDraftDeleteSchema,
    prepare,execute:localDeliveryExecuteSchema,slot,disk,envelope,execution};
}
export type LocalDeliverySchemas=ReturnType<typeof createLocalDeliverySchemas>;
export type LocalDeliveryPrepare=z.infer<LocalDeliverySchemas['prepare']>;
export type LocalDeliverySlot=z.infer<LocalDeliverySchemas['slot']>;
export type LocalDeliveryIntent=NonNullable<LocalDeliverySlot['intent']>;
export type LocalDeliveryDisk=z.infer<LocalDeliverySchemas['disk']>;
export type LocalDeliveryEnvelope=z.infer<LocalDeliverySchemas['envelope']>;
export type LocalDeliveryExecution=z.infer<LocalDeliverySchemas['execution']>;

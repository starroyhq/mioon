import {z} from 'zod';

// Private, local title/prompt recovery only. This companion neither registers an
// operation nor changes the existing shot.update input or receipt bytes.
export const LOCAL_SHOT_TEXT_LIMITS = Object.freeze({
  slots:128,rowBytes:256*1024,envelopeBytes:16*1024*1024,httpBytes:256*1024,urlBytes:2048,
  rawTitleUnits:512,rawPromptUnits:6000,shotResponseBytes:1024*1024,
  executeResponseBytes:1024*1024+256*1024,
});
// JSON escapes one valid BMP control code unit as six ASCII bytes (\\u0000).
// Even the largest legal title+prompt alone therefore needs 30,900 bytes before
// keys/quotes. A retained slot can contain five text pairs: latest raw+baseline,
// captured raw+baseline, and frozen patch. 256 KiB covers their worst escapes
// (at most 162,672 text bytes) and bounded IDs/metadata, unlike an 8 KiB row.
const id=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/);
const revision=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const baselineRevision=revision.min(1).max(Number.MAX_SAFE_INTEGER-1);
const stamp=z.string().max(64).datetime();
const unicode=z.string().regex(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u);
const authority={workspaceScope:hash,instanceId:id};
const encoder=new TextEncoder();
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const plain=(value:unknown):value is Record<string,unknown>=>object(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const own=(value:object,key:PropertyKey):boolean=>Object.hasOwn(value,key);
function bytesWithin(value:unknown,limit:number):boolean {
  try{const text=JSON.stringify(value);return typeof text==='string'&&encoder.encode(text).byteLength<=limit;}catch{return false;}
}
function issue(context:z.RefinementCtx,message:string):void{context.addIssue({code:'custom',message});}

// Raw UI input deliberately admits empty/overlength title and overlength prompt,
// preserving invalid-but-bounded edits without granting permission to apply them.
export const localShotTextDraftRawSchema=z.object({
  title:unicode.max(LOCAL_SHOT_TEXT_LIMITS.rawTitleUnits),prompt:unicode.max(LOCAL_SHOT_TEXT_LIMITS.rawPromptUnits),
}).strict();
export const localShotTextBaseTextSchema=z.object({title:unicode.min(1).max(150),prompt:unicode.max(5000)}).strict();
export const localShotTextKeySchema=z.object({projectId:id,shotId:id}).strict();
export const localShotTextDraftValueSchema=z.object({
  draftId:id,baseRevision:baselineRevision,baseText:localShotTextBaseTextSchema,raw:localShotTextDraftRawSchema,updatedAt:stamp,
}).strict();
export const localShotTextDraftCaptureSchema=z.object({draftId:id,revision:revision.min(1),raw:localShotTextDraftRawSchema}).strict();
export const localShotTextDraftPutSchema=z.object({
  ...authority,...localShotTextKeySchema.shape,expectedDraftRevision:revision,draftId:id,
  baseRevision:baselineRevision,baseText:localShotTextBaseTextSchema,raw:localShotTextDraftRawSchema,
}).strict();
export const localShotTextDraftDeleteSchema=z.object({
  ...authority,...localShotTextKeySchema.shape,expectedDraftRevision:revision.min(1),draftId:id,
}).strict();
export const localShotTextExecuteSchema=z.object({
  ...authority,...localShotTextKeySchema.shape,intentId:id,expectedIntentRevision:revision.min(1),
}).strict();
export const localShotTextUnsupportedSchema=z.object({supported:z.literal(false),reason:z.literal('RESTORED_WORKSPACE_UNSUPPORTED')}).strict();
export const localShotTextOutcomeSchema=z.discriminatedUnion('status',[
  z.object({status:z.literal('pending')}).strict(),
  z.object({status:z.literal('applied'),responseSha256:hash,shotRevision:revision.min(1),resolvedAt:stamp}).strict(),
  z.object({status:z.literal('not_applied'),code:z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/),resolvedAt:stamp}).strict(),
]);
export const localShotTextProjectPendingIntentSchema=z.object({shotId:id,intentId:id}).strict();
const targetStatus=z.enum(['unset','matching','changed','missing']);

// Type-only narrow spelling. The injected canonical shot.update validator is
// still runtime authority. A custom schema preserves caller key order/omission.
export type LocalShotTextUpdateInput={requestId:string;shotId:string;expectedRevision:number;patch:{title?:string;prompt?:string}};
export type LocalShotTextInputValidator=(value:unknown)=>boolean;
export type LocalShotTextKey=z.infer<typeof localShotTextKeySchema>;
export type LocalShotTextDraftRaw=z.infer<typeof localShotTextDraftRawSchema>;
export type LocalShotTextBaseText=z.infer<typeof localShotTextBaseTextSchema>;
export type LocalShotTextDraftValue=z.infer<typeof localShotTextDraftValueSchema>;
export type LocalShotTextDraftCapture=z.infer<typeof localShotTextDraftCaptureSchema>;
export type LocalShotTextDraftPut=z.infer<typeof localShotTextDraftPutSchema>;
export type LocalShotTextDraftDelete=z.infer<typeof localShotTextDraftDeleteSchema>;
export type LocalShotTextExecute=z.infer<typeof localShotTextExecuteSchema>;
export type LocalShotTextOutcome=z.infer<typeof localShotTextOutcomeSchema>;
export type LocalShotTextProjectPendingIntent=z.infer<typeof localShotTextProjectPendingIntentSchema>;
export type LocalShotTextResponseTarget={baseRevision:number;baseText:LocalShotTextBaseText;input:LocalShotTextUpdateInput};
export type LocalShotTextMutationResponse=Record<string,unknown>&{id:string;projectId:string;revision:number;title:string;prompt:string};

const inputKeys=['requestId','shotId','expectedRevision','patch'] as const;
const textKeys=['title','prompt'] as const;
function narrowUpdateInput(value:unknown):value is LocalShotTextUpdateInput {
  if(!plain(value)||!inputKeys.every(key=>own(value,key))||Object.keys(value).some(key=>!inputKeys.some(allowed=>allowed===key))||
    !id.safeParse(value.shotId).success||!baselineRevision.safeParse(value.expectedRevision).success||
    !unicode.min(8).max(200).safeParse(value.requestId).success||!plain(value.patch))return false;
  const patch=value.patch,keys=Object.keys(patch);
  return keys.length>0&&keys.every(key=>textKeys.some(allowed=>allowed===key))&&
    textKeys.every(key=>!own(patch,key)||localShotTextBaseTextSchema.shape[key].safeParse(patch[key]).success)&&
    bytesWithin(value,LOCAL_SHOT_TEXT_LIMITS.httpBytes);
}
function exactUpdateInput(value:unknown,validate:LocalShotTextInputValidator):value is LocalShotTextUpdateInput {
  if(!narrowUpdateInput(value))return false;
  try{return validate(value)===true;}catch{return false;}
}
function boundIdentity(value:{shotId:string;baseRevision:number;baseText:LocalShotTextBaseText;draft:LocalShotTextDraftCapture;input:LocalShotTextUpdateInput},context:z.RefinementCtx):void {
  if(value.input.shotId!==value.shotId||value.input.expectedRevision!==value.baseRevision)issue(context,'Frozen shot input must match its target and baseline');
  let changed=false;
  for(const key of textKeys){
    if(own(value.input.patch,key)){
      if(value.input.patch[key]!==value.draft.raw[key])issue(context,'Frozen patch must exactly match its captured raw text');
      if(value.input.patch[key]!==value.baseText[key])changed=true;
    }else if(value.draft.raw[key]!==value.baseText[key])issue(context,'Omitted fields must remain unchanged in the captured draft');
  }
  if(!changed)issue(context,'A text intent must change at least one saved field');
}

/** The existing shot.update receipt is a complete historical shot. Preserve it
 * verbatim, but require the scoped identity, next revision and BOTH aftertexts.
 * Omitted patch fields are compared with the immutable saved baseline, never
 * today's shot. Broader shot ownership/replay-integrity checks remain backend
 * authority; this guard subsumes the existing minimum shot.update ACK guard. */
export function isLocalShotTextMutationResponse(projectId:string,intent:LocalShotTextResponseTarget,response:unknown):response is LocalShotTextMutationResponse {
  if(!id.safeParse(projectId).success||!object(intent)||!baselineRevision.safeParse(intent.baseRevision).success||
    !localShotTextBaseTextSchema.safeParse(intent.baseText).success||!narrowUpdateInput(intent.input)||
    intent.input.expectedRevision!==intent.baseRevision||!plain(response)||
    !['id','projectId','revision','title','prompt'].every(key=>own(response,key))||
    response.projectId!==projectId||response.id!==intent.input.shotId||response.revision!==intent.baseRevision+1||
    !localShotTextBaseTextSchema.shape.title.safeParse(response.title).success||
    !localShotTextBaseTextSchema.shape.prompt.safeParse(response.prompt).success||
    !bytesWithin(response,LOCAL_SHOT_TEXT_LIMITS.shotResponseBytes))return false;
  return textKeys.every(key=>response[key]===(own(intent.input.patch,key)?intent.input.patch[key]:intent.baseText[key]));
}

/** Supply a checked adapter for schemas['shot.update']. Reads never execute,
 * repair, rebase, normalize text, or consult current mutation capabilities. */
export function createLocalShotTextSchemas(isShotUpdateInput:LocalShotTextInputValidator){
  if(typeof isShotUpdateInput!=='function')throw new TypeError('A canonical shot.update input validator is required');
  const input=z.custom<LocalShotTextUpdateInput>((value:unknown)=>exactUpdateInput(value,isShotUpdateInput));
  const intent=z.object({
    intentId:id,baseRevision:baselineRevision,baseText:localShotTextBaseTextSchema,draft:localShotTextDraftCaptureSchema,
    input,createdAt:stamp,outcome:localShotTextOutcomeSchema,
  }).strict();
  const prepare=z.object({
    ...authority,...localShotTextKeySchema.shape,expectedIntentRevision:revision,expectedIntentId:id.nullable(),intentId:id,
    baseRevision:baselineRevision,baseText:localShotTextBaseTextSchema,draft:localShotTextDraftCaptureSchema,input,
  }).strict().superRefine((value,context)=>{
    if((value.expectedIntentRevision===0)!==(value.expectedIntentId===null))issue(context,'Prior intent identity must match its CAS revision');
    if(value.expectedIntentId===value.intentId)issue(context,'A new preparation must have a new intent identity');
    boundIdentity(value,context);
    if(!bytesWithin(value,LOCAL_SHOT_TEXT_LIMITS.httpBytes))issue(context,'Local shot text request exceeds its byte limit');
  });
  const slot=z.object({
    ...localShotTextKeySchema.shape,draftRevision:revision,draft:localShotTextDraftValueSchema.nullable(),
    intentRevision:revision,intent:intent.nullable(),
  }).strict().superRefine((value,context)=>{
    if(value.draft!==null&&value.draftRevision===0)issue(context,'A retained draft requires a positive revision');
    if((value.intentRevision===0)!==(value.intent===null))issue(context,'Intent revisions never reset or discard their latest identity');
    if(value.intent){
      boundIdentity({...value.intent,shotId:value.shotId},context);
      if(value.intent.draft.revision>value.draftRevision)issue(context,'Captured draft revision cannot exceed its retained slot revision');
      if(value.intent.outcome.status==='applied'&&value.intent.outcome.shotRevision!==value.intent.baseRevision+1)issue(context,'Applied outcome must identify the exact next shot revision');
    }
    if(!bytesWithin(value,LOCAL_SHOT_TEXT_LIMITS.rowBytes))issue(context,'Local shot text slot exceeds its byte limit');
  });
  const disk=z.object({version:z.literal(1),workspaceScope:hash,entries:z.array(slot).max(LOCAL_SHOT_TEXT_LIMITS.slots)}).strict().superRefine((value,context)=>{
    if(new Set(value.entries.map(entry=>`${entry.projectId}:${entry.shotId}`)).size!==value.entries.length)issue(context,'Project and shot slot pairs must be unique');
    if(new Set(value.entries.map(entry=>entry.shotId)).size!==value.entries.length)issue(context,'A stable shot cannot belong to multiple project slots');
    if(value.entries.some(entry=>entry.draftRevision===0&&entry.intentRevision===0))issue(context,'Empty untouched shot slots must not be persisted');
    const pendingProjects=value.entries.filter(entry=>entry.intent?.outcome.status==='pending').map(entry=>entry.projectId);
    if(new Set(pendingProjects).size!==pendingProjects.length)issue(context,'A project can retain only one pending text intent');
    if(!bytesWithin(value,LOCAL_SHOT_TEXT_LIMITS.envelopeBytes))issue(context,'Local shot text companion exceeds its byte limit');
  });
  const supportedEnvelope=z.object({
    supported:z.literal(true),...authority,...localShotTextKeySchema.shape,draftRevision:revision,draft:localShotTextDraftValueSchema.nullable(),
    intentRevision:revision,intent:intent.nullable(),draftTargetStatus:targetStatus,intentTargetStatus:targetStatus,
    projectPendingIntent:localShotTextProjectPendingIntentSchema.nullable(),
  }).strict().superRefine((value,context)=>{
    const result=slot.safeParse({projectId:value.projectId,shotId:value.shotId,draftRevision:value.draftRevision,draft:value.draft,intentRevision:value.intentRevision,intent:value.intent});
    if(!result.success)issue(context,'Invalid local shot text slot');
    if((value.draft===null)!==(value.draftTargetStatus==='unset')||(value.intent===null)!==(value.intentTargetStatus==='unset'))issue(context,'Target status must describe its retained identity');
    if(value.intent?.outcome.status==='pending'){
      if(value.projectPendingIntent?.shotId!==value.shotId||value.projectPendingIntent.intentId!==value.intent.intentId)issue(context,'Pending project reference must identify this unresolved intent');
    }else if(value.projectPendingIntent?.shotId===value.shotId)issue(context,'Pending project reference cannot name a resolved or absent intent');
    if(!bytesWithin(value,LOCAL_SHOT_TEXT_LIMITS.httpBytes))issue(context,'Local shot text response exceeds its byte limit');
  });
  const envelope=z.union([localShotTextUnsupportedSchema,supportedEnvelope]);
  const execution=z.object({envelope,response:z.unknown().nullable()}).strict().superRefine((value,context)=>{
    if(!own(value,'response')||value.response===undefined)issue(context,'An execution must explicitly return its response or null');
    if(value.response!==null){
      if(!value.envelope.supported||value.envelope.intent?.outcome.status!=='applied')issue(context,'Only an applied intent can carry an original response');
      else if(!isLocalShotTextMutationResponse(value.envelope.projectId,value.envelope.intent,value.response))issue(context,'Shot response does not acknowledge this exact frozen text intent');
    }
    if(!bytesWithin(value,LOCAL_SHOT_TEXT_LIMITS.executeResponseBytes))issue(context,'Execution response exceeds its byte limit');
  });
  return {key:localShotTextKeySchema,put:localShotTextDraftPutSchema,discard:localShotTextDraftDeleteSchema,
    prepare,execute:localShotTextExecuteSchema,slot,disk,envelope,execution};
}
export type LocalShotTextSchemas=ReturnType<typeof createLocalShotTextSchemas>;
export type LocalShotTextPrepare=z.infer<LocalShotTextSchemas['prepare']>;
export type LocalShotTextSlot=z.infer<LocalShotTextSchemas['slot']>;
export type LocalShotTextIntent=NonNullable<LocalShotTextSlot['intent']>;
export type LocalShotTextDisk=z.infer<LocalShotTextSchemas['disk']>;
export type LocalShotTextEnvelope=z.infer<LocalShotTextSchemas['envelope']>;
export type LocalShotTextExecution=z.infer<LocalShotTextSchemas['execution']>;

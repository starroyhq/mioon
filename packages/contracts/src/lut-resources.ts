import {z} from 'zod';

/** Resource admission only. A normalized Cube does not establish colour suitability. */
export const LUT_RESOURCE_PROFILE = 'mioon-cube3d-normalized-tetrahedral-v1';
export const LUT_RESOURCE_LIMITS = Object.freeze({sourceBytes:7*1024*1024,
  base64Characters:4*Math.ceil(7*1024*1024/3), projectBytes:64*1024*1024,
  workspaceBytes:128*1024*1024, projectResources:128, workspaceResources:512,
  receipts:4096, metadataBytes:4096, page:50, databaseBytes:512*1024*1024,
  databaseReserveBytes:1024*1024} as const);
const id=z.string().uuid(), hash=z.string().regex(/^[a-f0-9]{64}$/u);
const count=(max:number,min=0)=>z.number().int().min(min).max(max);
function scalarText(value:string):boolean {
  for(let index=0;index<value.length;index++){
    const unit=value.charCodeAt(index);
    if(unit>=0xd800&&unit<=0xdbff){const next=value.charCodeAt(++index);if(!(next>=0xdc00&&next<=0xdfff))return false;}
    else if(unit>=0xdc00&&unit<=0xdfff)return false;
  }
  return true;
}
const name=z.string().min(1).max(200).refine(scalarText,'Expected well-formed Unicode text.');
const requestId=z.string().min(8).max(200).refine(scalarText,'Expected a well-formed request ID.');
export const lutImportInputSchema=z.object({projectId:id,
  requestId, name,
  dataBase64:z.string().min(4).max(LUT_RESOURCE_LIMITS.base64Characters,
    'LUT import supports up to 7 MiB. Export a smaller compatible Cube; bytes are never rewritten automatically.'),
}).strict();
export const lutListInputSchema=z.object({projectId:id,limit:count(LUT_RESOURCE_LIMITS.page,1).default(25),after:id.optional()}).strict();
export const lutInspectInputSchema=z.object({projectId:id,lutId:id}).strict();
export const lutResourceSchemas=Object.freeze({'lut.import':lutImportInputSchema,'lut.list':lutListInputSchema,'lut.inspect':lutInspectInputSchema});
export type LutImportInput=z.infer<typeof lutImportInputSchema>;
export type LutListInput=z.infer<typeof lutListInputSchema>;
export type LutInspectInput=z.infer<typeof lutInspectInputSchema>;
export const lutMetadataSchema=z.object({profileId:z.literal(LUT_RESOURCE_PROFILE),size:count(65,2),
  title:z.string().max(250).regex(/^[\x20-\x21\x23-\x7e]*$/u).nullable(),
  domainMin:z.tuple([z.literal(0),z.literal(0),z.literal(0)]),domainMax:z.tuple([z.literal(1),z.literal(1),z.literal(1)]),
  rowCount:count(65**3,8),rowOrder:z.literal('red-fastest'),interpolation:z.literal('tetrahedral'),numericPrecision:z.literal('float64'),
}).strict().refine(value=>value.rowCount===value.size**3);
export const lutResourceSchema=z.object({id,projectId:id,name,
  kind:z.literal('cube3d'),sha256:hash,sizeBytes:count(LUT_RESOURCE_LIMITS.sourceBytes,1),
  profile:z.literal(LUT_RESOURCE_PROFILE),metadata:lutMetadataSchema,createdAt:z.string().max(40).datetime(),
  colourCompatibility:z.literal('unverified'),renderBinding:z.literal('not_implemented'),
}).strict();
export type LutResource=z.infer<typeof lutResourceSchema>;
export const lutImportResponseSchema=z.object({requestId,resource:lutResourceSchema}).strict();
export const lutListResponseSchema=z.object({projectId:id,items:z.array(lutResourceSchema).max(LUT_RESOURCE_LIMITS.page),nextAfter:id.nullable()}).strict();
export const lutInspectResponseSchema=z.object({resource:lutResourceSchema,integrity:z.literal('verified')}).strict();
export type LutImportResponse=z.infer<typeof lutImportResponseSchema>;
export type LutListResponse=z.infer<typeof lutListResponseSchema>;
export type LutInspectResponse=z.infer<typeof lutInspectResponseSchema>;

const readEffect={readOnly:true,idempotent:true,destructive:false,openWorld:false,
  databaseWrite:false,fileWrite:false,externalIO:false,localProcess:false,paidGeneration:false} as const;
export const lutResourceEffects=Object.freeze({
  'lut.import':Object.freeze({...readEffect,readOnly:false,databaseWrite:true,
    notes:'Imports exact caller-supplied bounded Cube bytes into project-owned immutable database storage with a mandatory stable requestId and atomic receipt. Exact retries return the original resource; changed reuse conflicts. No arbitrary paths, playable media, rendering, clip binding, process, provider or network work. A normalized table does not establish colour compatibility. Unavailable in restored workspaces.'}),
  'lut.list':Object.freeze({...readEffect,notes:'Reads one bounded project-owned LUT metadata page. Returns no content bytes or paths; does not verify rendering eligibility, initialize resources or apply effects.'}),
  'lut.inspect':Object.freeze({...readEffect,notes:'Reads one project-owned immutable LUT, verifies its bounded stored bytes/hash/profile and parser metadata, and returns metadata only. No content delivery, paths, repair, renderer, clip binding or colour eligibility claim.'}),
});
export const lutResourceDescriptions=Object.freeze({
  'lut.import':'Import a project-owned normalized 3D Cube resource, maximum 7 MiB, with exact stable-request replay. This stores a resource; it does not apply a visual LUT.',
  'lut.list':'List a bounded page of project-owned LUT metadata without bytes or rendering.',
  'lut.inspect':'Verify one owned LUT resource and inspect its metadata/hash without returning its bytes or applying it.',
});

export function lutRestorePolicy(operation:string,schemaVersion:number):{operation:string;available:boolean;reason:'AVAILABLE'|'RESTORE_OPERATION_UNAVAILABLE'} {
  const available=!operation.startsWith('lut.')||(schemaVersion===29||schemaVersion===31||schemaVersion===33||schemaVersion===35||schemaVersion===37||schemaVersion===39||schemaVersion===41||schemaVersion===45||schemaVersion===49||schemaVersion===51)&&operation!=='lut.import';
  return {operation,available,reason:available?'AVAILABLE':'RESTORE_OPERATION_UNAVAILABLE'};
}

/** Structural ownership check. The Node shared-client additionally derives the
 * exact input SHA-256/size before accepting an import acknowledgement. */
export function isLutResponse(operation:string,input:unknown,value:unknown):boolean {
  if(operation==='lut.import'){
    const i=lutImportInputSchema.safeParse(input),v=lutImportResponseSchema.safeParse(value);
    return i.success&&v.success&&v.data.requestId===i.data.requestId&&v.data.resource.projectId===i.data.projectId&&v.data.resource.name===i.data.name;
  }
  if(operation==='lut.inspect'){
    const i=lutInspectInputSchema.safeParse(input),v=lutInspectResponseSchema.safeParse(value);
    return i.success&&v.success&&v.data.resource.projectId===i.data.projectId&&v.data.resource.id===i.data.lutId;
  }
  if(operation==='lut.list'){
    const i=lutListInputSchema.safeParse(input),v=lutListResponseSchema.safeParse(value);
    if(!i.success||!v.success||v.data.projectId!==i.data.projectId||v.data.items.length>i.data.limit)return false;
    const ids=v.data.items.map(row=>row.id);
    return v.data.items.every(row=>row.projectId===i.data.projectId)&&ids.every((id,index)=>id>(index?ids[index-1]!:i.data.after??''))&&
      (v.data.nextAfter===null||ids.length===i.data.limit&&v.data.nextAfter===ids.at(-1));
  }
  return false;
}

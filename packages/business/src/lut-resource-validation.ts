import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {LUT_RESOURCE_LIMITS,LUT_RESOURCE_PROFILE,lutResourceSchema} from '../../contracts/src/lut-resources.ts';
import type {LutResource} from '../../contracts/src/lut-resources.ts';
import {parseCube3D} from './cube-lut.ts';

export const lutResourceError=(code='LUT_RESOURCE_INVALID',status=409):Error&{code:string;status:number}=>
  Object.assign(new Error(code==='LUT_SOURCE_TOO_LARGE'?'LUT import supports up to 7 MiB. Export a smaller compatible Cube; original bytes are not changed.':
    code==='LUT_NOT_FOUND'?'The project-owned LUT resource was not found.':
    code==='LUT_CAPACITY'?'LUT storage capacity is full. Existing resources and receipts were not changed.':
    code==='IDEMPOTENCY_CONFLICT'?'This LUT request ID is already bound to different input. Replay the exact original input.':
    code==='LUT_OWNER_REQUIRED'?'A live owned workspace is required.':
    code==='LUT_IMPORT_UNCERTAIN'?'LUT import outcome is uncertain. Replay the exact original input and request ID.':
    'The LUT resource cannot be verified under the supported bounded Cube profile.'),{code,status});
function invalid():never {throw lutResourceError();}
export const lutHash=(bytes:Uint8Array|string):string=>createHash('sha256').update(bytes).digest('hex');
export const lutInputHash=(input:{projectId:string;requestId:string;name:string},sha256:string,sizeBytes:number):string=>
  lutHash(JSON.stringify({operation:'lut.import',projectId:input.projectId,requestId:input.requestId,name:input.name,profile:LUT_RESOURCE_PROFILE,sha256,sizeBytes}));

/** Enforce byte budget before strict decoding; do not strip BOM/rewrite CRLF. */
export function parseLutBytes(bytes:Uint8Array):ReturnType<typeof parseCube3D> {
  if(bytes.length>LUT_RESOURCE_LIMITS.sourceBytes)throw lutResourceError('LUT_SOURCE_TOO_LARGE',413);
  if(bytes.length===0)invalid();
  let text:string;
  try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{invalid();}
  try{return parseCube3D(text);}catch{throw lutResourceError('LUT_FORMAT_UNSUPPORTED',400);}
}

// Exact SQL projections bound each imported cell before it crosses into JS.
// Never SELECT *: even a malformed database cannot materialize an oversized BLOB.
const text=(name:string,max:number)=>`CASE WHEN typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${max} THEN ${name} END AS ${name}`;
export const LUT_RESOURCE_COLUMNS=[text('id',36),text('projectId',36),text('name',800),text('sha256',64),
  `CASE WHEN typeof(sizeBytes)='integer' AND sizeBytes BETWEEN 1 AND ${LUT_RESOURCE_LIMITS.sourceBytes} THEN sizeBytes END AS sizeBytes`,
  text('profile',80),text('metadata',LUT_RESOURCE_LIMITS.metadataBytes),text('createdAt',40)].join(',');
export function lutResourceFromRow(row:unknown):LutResource {
  if(!row||typeof row!=='object')invalid();
  const r=row as Record<string,unknown>;let metadata:unknown;
  try{if(typeof r.metadata!=='string')invalid();metadata=JSON.parse(r.metadata);}catch{invalid();}
  const parsed=lutResourceSchema.safeParse({id:r.id,projectId:r.projectId,name:r.name,sha256:r.sha256,sizeBytes:r.sizeBytes,
    profile:r.profile,metadata,createdAt:r.createdAt,kind:'cube3d',colourCompatibility:'unverified',renderBinding:'not_implemented'});
  if(!parsed.success)invalid();return parsed.data;
}
export function readLutResource(db:DatabaseSync,projectId:string,lutId:string,verifyBytes=false):LutResource {
  const row=db.prepare(`SELECT ${LUT_RESOURCE_COLUMNS} FROM main.project_lut_resources WHERE projectId=? AND id=?`).get(projectId,lutId);
  if(!row)throw lutResourceError('LUT_NOT_FOUND',404);
  const resource=lutResourceFromRow(row);
  if(resource.projectId!==projectId||resource.id!==lutId)invalid();
  if(verifyBytes){
    const cell=db.prepare(`SELECT CASE WHEN typeof(content)='blob' AND length(content) BETWEEN 1 AND ${LUT_RESOURCE_LIMITS.sourceBytes} THEN content END AS content FROM main.project_lut_resources WHERE projectId=? AND id=?`).get(projectId,lutId);
    const content=cell?.content;
    if(!(content instanceof Uint8Array)||content.length!==resource.sizeBytes||lutHash(content)!==resource.sha256)invalid();
    const parsed=parseLutBytes(content);
    if(JSON.stringify(parsed.metadata)!==JSON.stringify(resource.metadata))invalid();
  }
  return resource;
}

/** Ordinary startup and offline backup/restore gate. No writes or file I/O.
 * Count/size checks precede bounded BLOB reads, one resource at a time. */
export function validateLutResourceRows(db:DatabaseSync,{verifyBytes=true}:{verifyBytes?:boolean}={}):void {
  const rows=db.prepare(`SELECT ${LUT_RESOURCE_COLUMNS} FROM main.project_lut_resources LIMIT ${LUT_RESOURCE_LIMITS.workspaceResources+1}`).all();
  if(rows.length>LUT_RESOURCE_LIMITS.workspaceResources)invalid();
  let total=0;const projects=new Map<string,{count:number;bytes:number}>(),resources=new Map<string,LutResource>();
  for(const row of rows){
    const value=lutResourceFromRow(row);resources.set(value.id,value);total+=value.sizeBytes;
    const p=projects.get(value.projectId)??{count:0,bytes:0};p.count++;p.bytes+=value.sizeBytes;projects.set(value.projectId,p);
    if(total>LUT_RESOURCE_LIMITS.workspaceBytes||p.count>LUT_RESOURCE_LIMITS.projectResources||p.bytes>LUT_RESOURCE_LIMITS.projectBytes)invalid();
    if(!db.prepare('SELECT 1 FROM main.projects WHERE id=?').get(value.projectId))invalid();
  }
  const receipts=db.prepare(`SELECT ${text('requestId',800)},${text('projectId',36)},${text('inputHash',64)},${text('resourceId',36)} FROM main.lut_import_requests LIMIT ${LUT_RESOURCE_LIMITS.receipts+1}`).all();
  if(receipts.length>LUT_RESOURCE_LIMITS.receipts||receipts.length!==rows.length)invalid();
  const seen=new Set<string>();
  for(const receipt of receipts){
    if(typeof receipt.requestId!=='string'||receipt.requestId.length<8||receipt.requestId.length>200||typeof receipt.resourceId!=='string'||seen.has(receipt.resourceId))invalid();
    const resource=resources.get(receipt.resourceId);seen.add(receipt.resourceId);
    if(!resource||resource.projectId!==receipt.projectId||lutInputHash({projectId:resource.projectId,requestId:receipt.requestId,name:resource.name},resource.sha256,resource.sizeBytes)!==receipt.inputHash)invalid();
  }
  if(verifyBytes)for(const value of resources.values())readLutResource(db,value.projectId,value.id,true);
}

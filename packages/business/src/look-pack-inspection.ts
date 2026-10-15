import {isProxy} from 'node:util/types';
import type {DatabaseSync} from 'node:sqlite';
import {LUT_RESOURCE_LIMITS} from '../../contracts/src/lut-resources.ts';
import {isLookPackInspectInput,lookPackInspectResponseSchema} from '../../contracts/src/look-pack-inspection.ts';
import type {LookPackInspection} from '../../contracts/src/look-pack.ts';
import type {LookPackInspectInput,LookPackInspectResponse} from '../../contracts/src/look-pack-inspection.ts';
import {lutResourceError,lutHash,parseLutBytes,readLutResource} from './lut-resource-validation.ts';
import {isLookPackBytes,parseLookPackBytes} from './look-pack.ts';

export interface LookPackInspectRuntime {ownsLock():boolean;assertReadable():void}
export function assertLookPackInspectInput(value:unknown):LookPackInspectInput {
  if(isProxy(value)||!isLookPackInspectInput(value))throw lutResourceError('VALIDATION_ERROR',400);
  return value;
}
/** Exactly one bounded project-owned BLOB is inspected. Pack metadata lives in
 * the existing original Cube bytes; this service creates no state or receipt. */
export function createLookPackInspectionServices(store:{db:DatabaseSync},{runtime,signal}:{runtime:LookPackInspectRuntime;signal?:AbortSignal}){
  const {db}=store;
  async function inspectLookPack(value:unknown,context:{signal?:AbortSignal}={}):Promise<LookPackInspectResponse>{
    const owned=():void=>{runtime.assertReadable();if(signal?.aborted||context.signal?.aborted||!runtime.ownsLock())throw lutResourceError('LUT_OWNER_REQUIRED',503);};
    owned();const input=assertLookPackInspectInput(value);
    const projectOwned=():void=>{
      const project=db.prepare("SELECT id,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 16384 THEN data END AS data FROM main.projects WHERE id=?").get(input.projectId);
      if(!project)throw lutResourceError('LUT_NOT_FOUND',404);
      let projectData:unknown;
      try{if(typeof project.data!=='string')throw Error();projectData=JSON.parse(project.data);}catch{throw lutResourceError();}
      if(!projectData||typeof projectData!=='object'||!('id' in projectData)||projectData.id!==input.projectId||project.id!==input.projectId)throw lutResourceError();
    };
    projectOwned();
    const resource=readLutResource(db,input.projectId,input.lutId);
    const cell=db.prepare(`SELECT CASE WHEN typeof(content)='blob' AND length(content) BETWEEN 1 AND ${LUT_RESOURCE_LIMITS.sourceBytes} THEN content END AS content FROM main.project_lut_resources WHERE projectId=? AND id=?`).get(input.projectId,input.lutId);
    const bytes=cell?.content;
    if(!(bytes instanceof Uint8Array)||bytes.length!==resource.sizeBytes||lutHash(bytes)!==resource.sha256)throw lutResourceError();
    const cube=parseLutBytes(bytes);
    if(JSON.stringify(cube.metadata)!==JSON.stringify(resource.metadata))throw lutResourceError();
    if(!isLookPackBytes(bytes)){owned();return {resource,integrity:'verified',status:'not_pack',pack:null};}
    let pack:LookPackInspection;
    try{pack=await parseLookPackBytes(bytes);}catch(error){
      const codes=['LOOK_PACK_INPUT_INVALID','LOOK_PACK_RESOURCE_LIMIT','LOOK_PACK_ENCODING_INVALID','LOOK_PACK_MARKER_INVALID','LOOK_PACK_MANIFEST_INVALID','LOOK_PACK_DUPLICATE_KEY','LOOK_PACK_BODY_MISMATCH','LOOK_PACK_CUBE_INVALID','LOOK_PACK_CRYPTO_UNAVAILABLE'];
      const code=error instanceof Error&&'code' in error&&typeof error.code==='string'&&codes.includes(error.code)?error.code:'LOOK_PACK_UNAVAILABLE';
      throw Object.assign(new Error('The Look Pack declaration cannot be verified. No resource or project state was changed.'),{code,status:code==='LOOK_PACK_CRYPTO_UNAVAILABLE'||code==='LOOK_PACK_UNAVAILABLE'?503:400});
    }
    // WebCrypto yields: a stale lease or changed owned resource must not become
    // a successful current inspection, even after the declaration parsed.
    owned();projectOwned();
    const current=readLutResource(db,input.projectId,input.lutId,true);
    if(JSON.stringify(current)!==JSON.stringify(resource))throw lutResourceError();
    const response=lookPackInspectResponseSchema.safeParse({resource,integrity:'verified',status:'verified',pack});
    if(!response.success)throw lutResourceError();
    owned();return response.data;
  }
  return {handlers:{'lut.look.inspect':inspectLookPack},readers:{'lut.look.inspect':inspectLookPack}};
}

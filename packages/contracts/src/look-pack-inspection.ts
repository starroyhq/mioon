import {z} from 'zod';
import {lutResourceSchema} from './lut-resources.ts';
import {lookPackInspectionSchema} from './look-pack.ts';

/** This read reports a pack declaration, not independently certified provenance,
 * licensing, colour compatibility or permission to apply a look. */
export const lookPackInspectInputSchema=z.object({projectId:z.string().uuid(),lutId:z.string().uuid()}).strict();
export type LookPackInspectInput=z.infer<typeof lookPackInspectInputSchema>;
export const lookPackInspectResponseSchema=z.discriminatedUnion('status',[
  z.object({resource:lutResourceSchema,integrity:z.literal('verified'),status:z.literal('verified'),pack:lookPackInspectionSchema}).strict(),
  z.object({resource:lutResourceSchema,integrity:z.literal('verified'),status:z.literal('not_pack'),pack:z.null()}).strict(),
]).refine(value=>value.status==='not_pack'||value.pack.sizeBytes===value.resource.sizeBytes&&JSON.stringify(value.pack.cubeMetadata)===JSON.stringify(value.resource.metadata),
  'Pack inspection must match the owned resource byte size and Cube metadata.');
export type LookPackInspectResponse=z.infer<typeof lookPackInspectResponseSchema>;
export const lookPackInspectSchemas=Object.freeze({'lut.look.inspect':lookPackInspectInputSchema});
export const lookPackInspectDescriptions=Object.freeze({
  'lut.look.inspect':'Read one owned LUT and verify its bounded single-Look pack metadata. Plain Cube resources return not_pack. Source and licence claims remain declarations, not certification. No bytes, paths, active links, URL fetches, rendering or application.',
});
export const lookPackInspectEffects=Object.freeze({'lut.look.inspect':Object.freeze({
  readOnly:true,idempotent:true,destructive:false,openWorld:false,databaseWrite:false,
  fileWrite:false,externalIO:false,localProcess:false,paidGeneration:false,
  notes:'Reads one project-owned bounded immutable Cube BLOB, verifies current resource identity, hash and parser metadata, then checks the optional single-Look comment manifest. Returns metadata only with declared, not certified, source and licence claims. Malformed packs fail explicitly. No file/database writes, paths, content delivery, network, rendering, colour interpretation or built-in Agent authority.',
})});

/** Reject accessors before schema parsing. Node entry points additionally reject
 * proxies using util.types.isProxy before invoking this browser-safe helper. */
export function isLookPackInspectInput(value:unknown):value is LookPackInspectInput {
  try{
    if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
    const keys=Reflect.ownKeys(value);if(keys.length!==2)return false;
    for(const key of keys){
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if(typeof key!=='string'||!['projectId','lutId'].includes(key)||!descriptor?.enumerable||!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='string')return false;
    }
    return lookPackInspectInputSchema.safeParse(value).success;
  }catch{return false;}
}
export function isLookPackInspectResponse(value:unknown,input:unknown):value is LookPackInspectResponse {
  if(!isLookPackInspectInput(input))return false;
  const result=lookPackInspectResponseSchema.safeParse(value);
  return result.success&&result.data.resource.projectId===input.projectId&&result.data.resource.id===input.lutId;
}

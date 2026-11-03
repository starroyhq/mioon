import {schemas as modelSchemas} from './index.ts';
import {assetImportSchema,generationReferenceRevisionsSchema} from './asset-media.ts';

/** Public S1 extensions stay separate from the fixed model catalog. Reuse the
 * core object's exact fields and run its full refinement on the model input;
 * adding UI revision binding must not bypass connection/profile/role checks. */
const modelGeneration=modelSchemas['generation.submit'];
export const assetGenerationSubmitSchema=modelGeneration.innerType().extend({referenceRevisions:generationReferenceRevisionsSchema.optional()})
 .superRefine((value,context)=>{
  const {referenceRevisions:_referenceRevisions,...modelInput}=value;
  const parsed=modelGeneration.safeParse(modelInput);
  if(!parsed.success)for(const issue of parsed.error.issues)context.addIssue(issue);
 });
export const s1PublicOperationSchemas=Object.freeze({'asset.import':assetImportSchema,'generation.submit':assetGenerationSubmitSchema});
export const s1PublicOperationDescriptions=Object.freeze({'asset.import':'引用已获授权的本机媒体路径，或上传最多30MiB媒体字节'});
export type S1PublicOperation=keyof typeof s1PublicOperationSchemas;
export const isS1PublicOperation=(value:string):value is S1PublicOperation=>Object.hasOwn(s1PublicOperationSchemas,value);

import {z} from 'zod';

/** A `.mioon` file carries one project's saved content and the media it uses.
 * It is an exchange file: importing always creates a new project, and the file
 * never carries keys, authorizations, task receipts or undo history. */
export const PROJECT_PACKAGE_FORMAT='mioon-project';
export const PROJECT_PACKAGE_FORMAT_VERSION=1;
export const PROJECT_PACKAGE_EXTENSION='.mioon';
export const PROJECT_PACKAGE_MIME_TYPE='application/vnd.mioon.project';
const MiB=1024*1024,GiB=1024*MiB;
// File count and byte ceilings follow the workspace backup limits.
export const PROJECT_PACKAGE_LIMITS=Object.freeze({
 fileCount:20_000,fileBytes:8*GiB,totalBytes:64*GiB,manifestBytes:8*MiB,documentBytes:32*MiB,
 completeBytes:4096,headerBytes:1024,chunkBytes:MiB,
});
export const PROJECT_PACKAGE_MEDIA_EXTENSIONS=Object.freeze(['png','jpg','webp','mp4','webm','wav','mp3','m4a','cube'] as const);
export type ProjectPackageMediaExtension=typeof PROJECT_PACKAGE_MEDIA_EXTENSIONS[number];
export const PROJECT_PACKAGE_MANIFEST_PATH='manifest.json';
export const PROJECT_PACKAGE_DOCUMENT_PATH='project.json';
export const PROJECT_PACKAGE_COMPLETE_PATH='COMPLETE.json';
const mediaPathPattern=new RegExp(`^media/[0-9a-f]{64}\\.(${PROJECT_PACKAGE_MEDIA_EXTENSIONS.join('|')})$`,'u');
export const isProjectPackageMediaPath=(value:string):boolean=>mediaPathPattern.test(value);
export const projectPackageMediaPath=(sha256:string,extension:ProjectPackageMediaExtension):string=>`media/${sha256}.${extension}`;

export const PROJECT_PACKAGE_ERROR_CODES=Object.freeze([
 'PROJECT_PACKAGE_NOT_MIOON','PROJECT_PACKAGE_CORRUPT','PROJECT_PACKAGE_NEWER_FORMAT','PROJECT_PACKAGE_INVALID_CONTENT',
 'PROJECT_PACKAGE_MEDIA_REJECTED','PROJECT_PACKAGE_NO_SPACE','PROJECT_PACKAGE_CANCELLED',
 'PROJECT_PACKAGE_SOURCE_MISSING','PROJECT_PACKAGE_SOURCE_CHANGED','PROJECT_PACKAGE_BUSY','PROJECT_PACKAGE_NOT_FOUND',
] as const);
export type ProjectPackageErrorCode=typeof PROJECT_PACKAGE_ERROR_CODES[number];

const hex64=z.string().regex(/^[0-9a-f]{64}$/u);
const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const bytes=z.number().int().nonnegative().max(PROJECT_PACKAGE_LIMITS.fileBytes);
export const projectPackageFileSchema=z.object({path:z.string().max(200),bytes,sha256:hex64}).strict()
 .refine(file=>file.path===PROJECT_PACKAGE_DOCUMENT_PATH||isProjectPackageMediaPath(file.path),{message:'Unsupported package path.'})
 .refine(file=>!isProjectPackageMediaPath(file.path)||file.path.slice(6,70)===file.sha256,{message:'Media paths are named by their SHA-256.'});
export type ProjectPackageFile=z.infer<typeof projectPackageFileSchema>;

export const projectPackageCountsSchema=z.object({
 shots:count,assets:count,versions:count,clips:count,subtitles:count,subjects:count,luts:count,
}).strict();
export type ProjectPackageCounts=z.infer<typeof projectPackageCountsSchema>;
export const projectPackageOptionsSchema=z.object({media:z.enum(['all','used']),includeExports:z.boolean()}).strict();
export type ProjectPackageOptions=z.infer<typeof projectPackageOptionsSchema>;

/** The version check reads only these two fields, so a file from a newer
 * Mioon is reported as such instead of as corrupt. */
export const projectPackageFormatProbeSchema=z.object({format:z.literal(PROJECT_PACKAGE_FORMAT),formatVersion:z.number().int().min(1).max(1_000_000)}).passthrough();
export const projectPackageManifestSchema=z.object({
 format:z.literal(PROJECT_PACKAGE_FORMAT),
 formatVersion:z.literal(PROJECT_PACKAGE_FORMAT_VERSION),
 appVersion:z.string().min(1).max(40),
 createdAt:z.string().min(1).max(40),
 project:z.object({name:z.string().min(1).max(150)}).strict(),
 counts:projectPackageCountsSchema,
 options:projectPackageOptionsSchema,
 files:z.array(projectPackageFileSchema).min(1).max(PROJECT_PACKAGE_LIMITS.fileCount),
}).strict().superRefine((manifest,ctx)=>{
 const paths=new Set<string>();let total=0;
 for(const file of manifest.files){
  if(paths.has(file.path))ctx.addIssue({code:z.ZodIssueCode.custom,message:'Duplicate package path.'});
  paths.add(file.path);total+=file.bytes;
 }
 if(manifest.files[0]?.path!==PROJECT_PACKAGE_DOCUMENT_PATH)ctx.addIssue({code:z.ZodIssueCode.custom,message:'The project document must be listed first.'});
 if(total>PROJECT_PACKAGE_LIMITS.totalBytes)ctx.addIssue({code:z.ZodIssueCode.custom,message:'Package is too large.'});
});
export type ProjectPackageManifest=z.infer<typeof projectPackageManifestSchema>;

export const projectPackageCompleteSchema=z.object({
 format:z.literal(PROJECT_PACKAGE_FORMAT),formatVersion:z.literal(PROJECT_PACKAGE_FORMAT_VERSION),
 manifestSha256:hex64,fileCount:count,totalBytes:count,
}).strict();
export type ProjectPackageComplete=z.infer<typeof projectPackageCompleteSchema>;

import {z} from 'zod';
const id=z.string().uuid(),revision=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const projectRenameInputSchema=z.object({requestId:id,projectId:id,expectedRevision:revision,name:z.string().trim().min(1).max(150)}).strict();
/** Project notes (C6): plain text Mio reads with every run. At most 8192 UTF-8
 * bytes; newlines and tabs are the only control characters, and an unpaired
 * surrogate (which JSON cannot carry losslessly) is refused. */
export const PROJECT_NOTES_MAX_BYTES=8192;
export function projectNotesValid(value:string):boolean{
  return new TextEncoder().encode(value).length<=PROJECT_NOTES_MAX_BYTES&&!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value);
}
export const projectNotesSchema=z.string().max(PROJECT_NOTES_MAX_BYTES).refine(projectNotesValid,{message:'Project notes are at most 8192 bytes of plain text'});
export const projectNotesSetInputSchema=z.object({requestId:id,projectId:id,expectedRevision:revision,notes:projectNotesSchema}).strict();
export const projectDeleteInputSchema=z.object({requestId:id,projectId:id,expectedRevision:revision,confirmPermanentDeletion:z.literal(true)}).strict();
export const projectLifecycleSchemas={'project.rename':projectRenameInputSchema,'project.notes.set':projectNotesSetInputSchema,'project.delete':projectDeleteInputSchema};
export const projectLifecycleDescriptions={
  'project.rename':'按项目版本重命名；稳定requestId精确重放，不改时间线或镜头。',
  'project.notes.set':'按项目版本保存项目说明：不超过8192字节的纯文本，记录画幅、风格、角色设定、禁忌等，空白内容清除说明。稳定requestId精确重放；项目说明是资料，不改变档位或权限。',
  'project.delete':'危险操作：明确确认后永久删除无运行或待对账任务的项目及独占托管文件、项目草稿；保留外部源文件和原备份。清理未完成时返回pending，原requestId可安全查询并继续本地清理。',
};
export const projectDeleteResponseSchema=z.object({requestId:id,projectId:id,deleted:z.literal(true),cleanup:z.enum(['complete','pending'])}).strict();
const fileIdentity=z.object({relativePath:z.string().regex(/^(?:media|image-staging|frame-staging|agent-imports)\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u),dev:z.number().int().nonnegative(),ino:z.number().int().nonnegative(),size:z.number().int().nonnegative(),mtimeMs:z.number().nonnegative(),birthtimeMs:z.number().nonnegative()}).strict();
export const projectDeleteManifestSchema=z.object({version:z.literal(1),projectId:id,files:z.array(fileIdentity).max(8192),companions:z.boolean()}).strict();
export type ProjectDeleteManifest=z.infer<typeof projectDeleteManifestSchema>;
export type ProjectRenameInput=z.infer<typeof projectRenameInputSchema>;
export type ProjectNotesSetInput=z.infer<typeof projectNotesSetInputSchema>;
export type ProjectDeleteInput=z.infer<typeof projectDeleteInputSchema>;

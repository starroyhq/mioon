import {z} from 'zod';
import {isNormalizedAbsolutePath} from './media-reference.ts';
import {PROJECT_FILE_EXTENSION} from './project-file.ts';
import {projectFileIdentitySchema} from './project-registry.ts';
const id=z.string().uuid(),revision=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const projectFile=z.string().min(1).max(4096).refine(value=>isNormalizedAbsolutePath(value)&&value.endsWith(PROJECT_FILE_EXTENSION),'Choose a normalized absolute .mioon file.');
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
/** The confirmed registration identifies the file to recheck, never permission
 * to trash an arbitrary path or a later file with the same name. */
export const projectDeleteInputSchema=z.object({requestId:id,projectId:id,expectedRevision:revision,projectFile,fileIdentity:projectFileIdentitySchema,confirmTrash:z.literal(true)}).strict();
export const projectLifecycleSchemas={'project.rename':projectRenameInputSchema,'project.notes.set':projectNotesSetInputSchema,'project.delete':projectDeleteInputSchema};
export const projectLifecycleDescriptions={
  'project.rename':'按项目版本重命名；稳定requestId精确重放，不改时间线或镜头。',
  'project.notes.set':'按项目版本保存项目说明：不超过8192字节的纯文本，记录画幅、风格、角色设定、禁忌等，空白内容清除说明。稳定requestId精确重放；项目说明是资料，不改变档位或权限。',
  'project.delete':'危险操作：明确确认已登记的文件和项目版本后，仅由受信桌面主进程将关闭的 .mioon 移到废纸篓，确定成功才撤登记；素材和全部本机记录保留。拒绝打开窗口、会写回项目的工作及 Mio 等待回答或审批，S8 草稿不阻止。稳定requestId重放确定回执；结果不明不重做、不撤登记。网页、headless、CLI 和 MCP 暂不可用。',
};
export const projectDeleteResponseSchema=z.object({requestId:id,projectId:id,projectFile,trashed:z.literal(true),records:z.literal('retained')}).strict();
export type ProjectDeleteResponse=z.infer<typeof projectDeleteResponseSchema>;
export type ProjectRenameInput=z.infer<typeof projectRenameInputSchema>;
export type ProjectNotesSetInput=z.infer<typeof projectNotesSetInputSchema>;
export type ProjectDeleteInput=z.infer<typeof projectDeleteInputSchema>;

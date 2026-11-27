import {FCP_EXPORT_OPERATIONS,FCP_EXPORT_TASK_KIND,fcpExportStartInputSchema} from '../../../contracts/src/fcp-export.ts';
import {PREMIERE_EXPORT_OPERATIONS,PREMIERE_EXPORT_TASK_KIND} from '../../../contracts/src/premiere-export.ts';

export const MIO_EDITOR_EXPORT_OPERATIONS=[...FCP_EXPORT_OPERATIONS,...PREMIERE_EXPORT_OPERATIONS] as const;
type MioEditorExportOperation=(typeof MIO_EDITOR_EXPORT_OPERATIONS)[number];

export function isMioEditorExportOperation(operation:string):operation is MioEditorExportOperation{
 return MIO_EDITOR_EXPORT_OPERATIONS.some(candidate=>candidate===operation);
}

export const isMioEditorExportStart=(operation:string) =>
 operation==='export.fcpxml.start'||operation==='export.premiere.start';
export const isMioEditorExportGet=(operation:string) =>
 operation==='export.fcpxml.get'||operation==='export.premiere.get';
const isFcpOperation=(operation:MioEditorExportOperation) => operation.startsWith('export.fcpxml.');
export const mioEditorExportLabel=(operation:MioEditorExportOperation) => isFcpOperation(operation)?'Final Cut Pro':'Premiere Pro';
export const mioEditorExportKind=(operation:MioEditorExportOperation) => isFcpOperation(operation)?FCP_EXPORT_TASK_KIND:PREMIERE_EXPORT_TASK_KIND;

const projectDestination=fcpExportStartInputSchema.shape.destination.options.find(option=>option.shape.kind.value==='project');
if(!projectDestination)throw Error('Editor export schema lacks the project destination');
export const mioEditorExportStartSchema=fcpExportStartInputSchema.extend({destination:projectDestination});

export const MIO_EDITOR_EXPORT_DESCRIPTIONS:Readonly<Record<MioEditorExportOperation,string>>={
 'export.fcpxml.preview':'只读预览当前格式 5 时间线的 Final Cut Pro 导出：画幅、总时长、带不过去的片段、近似处理和复制媒体所需空间。',
 'export.fcpxml.start':'经用户确认后启动后台 Final Cut Pro 导出。destination 只能为 {kind:"project"}，文件写到当前项目的「导出」文件夹。用返回的 exportId 调用 mioon_export_fcpxml_get 查询原任务。',
 'export.fcpxml.get':'按 exportId 查询当前项目的 Final Cut Pro 导出状态、进度、结果或错误。',
 'export.fcpxml.cancel':'经用户确认后按 exportId 取消当前项目的 Final Cut Pro 导出。已完成的导出仍会保留。',
 'export.premiere.preview':'只读预览当前格式 5 时间线的 Premiere Pro 导出：画幅、总时长、带不过去的片段和字幕、近似处理和复制媒体所需空间。',
 'export.premiere.start':'经用户确认后启动后台 Premiere Pro XML 导出。destination 只能为 {kind:"project"}，文件写到当前项目的「导出」文件夹。用返回的 exportId 调用 mioon_export_premiere_get 查询原任务。',
 'export.premiere.get':'按 exportId 查询当前项目的 Premiere Pro 导出状态、进度、结果或错误。',
 'export.premiere.cancel':'经用户确认后按 exportId 取消当前项目的 Premiere Pro 导出。已完成的导出仍会保留。',
};

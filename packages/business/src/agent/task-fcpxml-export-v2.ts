import {FCP_EXPORT_OPERATIONS,fcpExportStartInputSchema,type FcpExportOperation} from '../../../contracts/src/fcp-export.ts';

export const MIO_FCP_EXPORT_OPERATIONS=FCP_EXPORT_OPERATIONS;

export function isMioFcpExportOperation(operation:string):operation is FcpExportOperation{
 return MIO_FCP_EXPORT_OPERATIONS.some(candidate=>candidate===operation);
}

const projectDestination=fcpExportStartInputSchema.shape.destination.options.find(option=>option.shape.kind.value==='project');
if(!projectDestination)throw Error('FCPXML export schema lacks the project destination');
export const mioFcpExportStartSchema=fcpExportStartInputSchema.extend({destination:projectDestination});

export const MIO_FCP_EXPORT_DESCRIPTIONS:Readonly<Record<FcpExportOperation,string>>={
 'export.fcpxml.preview':'只读预览当前格式 5 时间线的 Final Cut Pro 导出：画幅、总时长、带不过去的片段、近似处理和复制媒体所需空间。',
 'export.fcpxml.start':'经用户确认后启动后台 Final Cut Pro 导出。destination 只能为 {kind:"project"}，文件写到当前项目的「导出」文件夹。用返回的 exportId 调用 mioon_export_fcpxml_get 查询原任务。',
 'export.fcpxml.get':'按 exportId 查询当前项目的 Final Cut Pro 导出状态、进度、结果或错误。',
 'export.fcpxml.cancel':'经用户确认后按 exportId 取消当前项目的 Final Cut Pro 导出。已完成的导出仍会保留。',
};

import {schemas as modelSchemas, descriptions as modelDescriptions} from './index.ts';
import {assetMediaPublicSchemas, assetMediaDescriptions} from './asset-media.ts';
import {s1PublicOperationSchemas, s1PublicOperationDescriptions} from './asset-generation.ts';
import {previsPublicationSchemas, previsPublicationDescriptions} from './previs-publication.ts';
import {timelineFrameSetSchema} from './timeline-format.ts';
import {previsThumbnailPublicSchemas} from './previs.ts';
import {canvasEditingSchemas} from './canvas-editing.ts';
import {generationImageServiceSchemas} from './generation-image-services.ts';

/** Authoritative public operation schemas. MCP applies its explicit user-only
 * exclusions; Mio separately admits operations through its reviewed catalog. */
// Retain the core definition only for frozen model diagnostics and historical
// request decoding. Public discovery must not advertise the retired writer.
const {'project.notes.set': _retiredNotesSchema, ...currentModelSchemas} = modelSchemas;
const {'project.notes.set': _retiredNotesDescription, ...currentModelDescriptions} = modelDescriptions;
export const publicOperationSchemas = {...currentModelSchemas, ...assetMediaPublicSchemas, ...s1PublicOperationSchemas, ...previsPublicationSchemas, ...previsThumbnailPublicSchemas,'timeline.format.set':timelineFrameSetSchema,
  'canvas.copy.snapshot':canvasEditingSchemas['canvas.copy.snapshot'],
  'image.service.list':generationImageServiceSchemas['image.service.list'],
};
export const publicOperationDescriptions = {...currentModelDescriptions, ...assetMediaDescriptions, ...s1PublicOperationDescriptions, ...previsPublicationDescriptions,
  'canvas.copy.snapshot':'按白名单选择建立当前项目的有界画板复制快照，不返回快照内容',
  'image.service.list':'读取当前项目可用的图片服务及其公开配置元数据，不返回凭证',
  'generation.submit':'用稳定 requestId 向已配置的生成服务提交镜头任务',
  'timeline.format.get':'只读查询当前时间线输出规格、版本与修改资格',
  'timeline.format.set':'格式 4 项目可在同一短边档位内修改比例。项目与时间线双版本校验，精确回放，可撤销。格式 3 保留初始空白时间线设置。',
};

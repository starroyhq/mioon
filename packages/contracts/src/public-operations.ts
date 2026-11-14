import {schemas as modelSchemas, descriptions as modelDescriptions} from './index.ts';
import {assetMediaPublicSchemas, assetMediaDescriptions} from './asset-media.ts';
import {s1PublicOperationSchemas, s1PublicOperationDescriptions} from './asset-generation.ts';
import {previsPublicationSchemas, previsPublicationDescriptions} from './previs-publication.ts';
import {timelineFrameSetSchema} from './timeline-format.ts';
import {previsThumbnailPublicSchemas} from './previs.ts';

/** Authoritative public discovery registry shared by CLI and MCP. The fixed
 * Mio catalog keeps using the core registry; public asset extensions never
 * add model tools or change their reviewed input schemas. */
// Retain the core definition only for frozen model diagnostics and historical
// request decoding. Public discovery must not advertise the retired writer.
const {'project.notes.set': _retiredNotesSchema, ...currentModelSchemas} = modelSchemas;
const {'project.notes.set': _retiredNotesDescription, ...currentModelDescriptions} = modelDescriptions;
export const publicOperationSchemas = {...currentModelSchemas, ...assetMediaPublicSchemas, ...s1PublicOperationSchemas, ...previsPublicationSchemas, ...previsThumbnailPublicSchemas,'timeline.format.set':timelineFrameSetSchema};
export const publicOperationDescriptions = {...currentModelDescriptions, ...assetMediaDescriptions, ...s1PublicOperationDescriptions, ...previsPublicationDescriptions,
  'generation.submit':'用稳定 requestId 向已配置的生成服务提交镜头任务',
  'timeline.format.get':'只读查询当前时间线输出规格、版本与修改资格',
  'timeline.format.set':'格式 4 项目可在同一短边档位内修改比例。项目与时间线双版本校验，精确回放，可撤销。格式 3 保留初始空白时间线设置。',
};

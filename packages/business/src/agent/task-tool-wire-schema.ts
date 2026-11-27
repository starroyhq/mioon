import {isDeepStrictEqual} from 'node:util';
import {agentChatError} from './chat-errors.ts';
import type {AgentConfiguration} from './config.ts';
import {LEGACY_TIMELINE_LIMITS,TIMELINE_LIMITS} from '@mioon/contracts/timeline-limits';

const deliveryNameSchema = {
  type: 'string', minLength: 1, maxLength: 120,
  allOf: [
    {pattern: '\\S'},
    {pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+$(?![\\s\\S])'},
    {pattern: '^(?:[^\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])*$'},
  ],
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exportTimelineTools=['mioon_timeline_export_preflight', 'mioon_timeline_render'];
const audioPreviewTools=['mioon_timeline_audioPreview_plan', 'mioon_timeline_audioPreview_continuousPlan'];

/** Released project formats retain the timeline range they can save and
 * replay. The generated schema advertises the native processing bounds. */
function legacyTimelineParameters(name: string, parameters: unknown): unknown {
  if (!object(parameters) || !object(parameters.properties)) return parameters;
  const {properties} = parameters;
  if (audioPreviewTools.includes(name) && object(properties.startFrame) &&
      properties.startFrame.maximum===TIMELINE_LIMITS.maxFrames-1) {
    return {...parameters,properties:{...properties,startFrame:{...properties.startFrame,maximum:LEGACY_TIMELINE_LIMITS.maxFrames-1}}};
  }
  if (!exportTimelineTools.includes(name) || !object(properties.exportRange) || !object(properties.exportRange.properties)) return parameters;
  const range=properties.exportRange,fields=range.properties;
  if (!object(fields) || !object(fields.startFrame) || !object(fields.endFrame) ||
      fields.startFrame.maximum!==TIMELINE_LIMITS.maxFrames-1 || fields.endFrame.maximum!==TIMELINE_LIMITS.maxFrames) return parameters;
  return {...parameters,properties:{...properties,exportRange:{...range,properties:{...fields,
    startFrame:{...fields.startFrame,maximum:LEGACY_TIMELINE_LIMITS.maxFrames-1},
    endFrame:{...fields.endFrame,maximum:LEGACY_TIMELINE_LIMITS.maxFrames},
  }}}};
}

/** DeepSeek rejects the compound delivery-name regex schema. Only these two
 * presentation fields use a textual format hint; host Zod validation keeps every
 * regex and strict field check. Never generalize this to unions or authority.
 * Exact matching makes future shared-contract changes fail closed. */
export function taskToolWireSchema(configuration: AgentConfiguration, name: string, parameters: unknown, nativeTimeline = true): unknown {
  if (!nativeTimeline) parameters=legacyTimelineParameters(name,parameters);
  if (configuration.presetId !== 'deepseek' || configuration.protocol !== 'chat_completions' ||
      !exportTimelineTools.includes(name)) return parameters;
  if (!object(parameters) || !object(parameters.properties) || !isDeepStrictEqual(parameters.properties.deliveryName, deliveryNameSchema)) throw agentChatError('AGENT_CHAT_PROFILE_UNSUPPORTED');
  return {...parameters, properties: {...parameters.properties, deliveryName: {
    type: 'string', minLength: 1, maxLength: 120,
    description: '导出显示名称：1 到 120 个字符，至少有一个非空白字符；不能含控制字符、换行、Unicode 行/段分隔符或未配对的 UTF-16 代理项。宿主会严格验证，名称不授予文件路径访问权限。',
  }}};
}

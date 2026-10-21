import {isDeepStrictEqual} from 'node:util';
import {agentChatError} from './chat-errors.ts';
import type {AgentConfiguration} from './config.ts';

const deliveryNameSchema = {
  type: 'string', minLength: 1, maxLength: 120,
  allOf: [
    {pattern: '\\S'},
    {pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+$(?![\\s\\S])'},
    {pattern: '^(?:[^\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])*$'},
  ],
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** DeepSeek rejects the compound delivery-name regex schema. Only these two
 * presentation fields use a textual format hint; host Zod validation keeps every
 * regex and strict field check. Never generalize this to unions or authority.
 * Exact matching makes future shared-contract changes fail closed. */
export function taskToolWireSchema(configuration: AgentConfiguration, name: string, parameters: unknown): unknown {
  if (configuration.presetId !== 'deepseek' || configuration.protocol !== 'chat_completions' ||
      !['mioon_timeline_export_preflight', 'mioon_timeline_render'].includes(name)) return parameters;
  if (!object(parameters) || !object(parameters.properties) || !isDeepStrictEqual(parameters.properties.deliveryName, deliveryNameSchema)) throw agentChatError('AGENT_CHAT_PROFILE_UNSUPPORTED');
  return {...parameters, properties: {...parameters.properties, deliveryName: {
    type: 'string', minLength: 1, maxLength: 120,
    description: '导出显示名称：1 到 120 个字符，至少有一个非空白字符；不能含控制字符、换行、Unicode 行/段分隔符或未配对的 UTF-16 代理项。宿主会严格验证，名称不授予文件路径访问权限。',
  }}};
}

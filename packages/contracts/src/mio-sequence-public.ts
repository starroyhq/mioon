import {z} from 'zod';
import {mioSequenceProjectSchemas} from './mio-sequence.ts';
import {sequenceCommitRequestSchema} from './sequence-edit-rpc.ts';

const uuid = z.string().uuid();
const requestId = z.string().min(8).max(200);
/** The stable request key is optional here because the Mio undo tool only
 * exposes the action id; CLI/MCP callers should pass one when they need exact
 * replay. */
export const sequenceUndoActionSchema = z.object({
  projectId: uuid,
  requestId: requestId.optional(),
  actionId: uuid.optional(),
}).strict();

export const sequenceActionSchemas = Object.freeze({
  ...mioSequenceProjectSchemas,
  'sequence.action.commit': sequenceCommitRequestSchema,
  'sequence.undo-action': sequenceUndoActionSchema,
});

export const sequenceActionDescriptions = Object.freeze({
  'sequence.action.edit': '预览格式 5 基础序列动作（连接/断开/插入/删除节点、成片内重排/移除/切开/跟随锁定/复制挪动）；返回计划摘要、共享 envelope 和计划凭据，不写画板、时间线、回执或历史。先用 sequence action commit 凭凭据提交。',
  'sequence.board.edit': '预览格式 5 画板动作（画板根/镜头/节点创建、更新、布局移动、归档恢复、复制）；返回计划摘要、共享 envelope 和计划凭据，不写画板、时间线、回执或历史。',
  'sequence.reference.edit': '预览格式 5 素材引用线动作（连接、改角色、断开、整组排序）；返回计划摘要、共享 envelope 和计划凭据。',
  'sequence.subject.edit': '预览格式 5 主体绑定与主体卡动作；返回计划摘要、共享 envelope 和计划凭据。',
  'sequence.previs.edit': '预览格式 5 预演新建与场景保存动作；返回计划摘要、共享 envelope 和计划凭据。',
  'sequence.timeline.edit': '预览格式 5 时间线动作（字幕、台词、画幅、场景切开、分离声音、轨道、素材入轨、剪辑里生成）；返回计划摘要、共享 envelope 和计划凭据。生成动作会产生费用，必须使用稳定的 generation requestId，不自动重试未知结果。',
  'sequence.clip.edit': '预览格式 5 片段属性动作（变换、转场、增益、淡入淡出、颜色、音频角色、音量包络、名称）；返回计划摘要、共享 envelope 和计划凭据。',
  'sequence.action.commit': '凭预览返回的 envelope 和 expectedPlanDigest 提交格式 5 序列动作；计划不匹配时拒绝。生成动作按 generation.submit 的稳定 requestId 和付费规则执行，未知结果只查原请求。',
  'sequence.undo-action': '按格式 5 统一历史撤销一步 Mio 动作；只在动作仍是栈顶时生效，省略 actionId 时撤销栈顶。稳定 requestId 可精确重放。',
});

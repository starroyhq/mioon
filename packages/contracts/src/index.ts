import {AppError} from './app-error.ts';
export * from './timeline-volume-envelope-capability.ts';
import {isVolumeEnvelope} from './timeline-volume-envelope-processing.ts';
import {clipAudioRoleSchema} from './timeline-audio-role.ts';
export * from './timeline-audio-role.ts';
export * from './comfy-availability.ts';
import {lookPackInspectSchemas,lookPackInspectDescriptions} from './look-pack-inspection.ts';
export * from './look-pack-inspection.ts';
import {clipColourSchema,timelineColourSchemas,timelineColourDescriptions} from './timeline-colour.ts';
export * from './timeline-colour.ts';
import {lutResourceSchemas,lutResourceDescriptions} from './lut-resources.ts';
export * from './lut-resources.ts';
import {audioPreviewSchemas} from './timeline-audio-preview.ts';
export * from './timeline-audio-preview.ts';
import {continuousAudioSchemas} from './timeline-audio-continuous.ts';
export * from './timeline-audio-continuous.ts';
import {timelineExportRangeSchema,isTimelineExportRangeInput} from './timeline-export-range.ts';
export * from './timeline-export-range.ts';
import {timelineDeliveryNameSchema,isTimelineDeliveryNameInput} from './timeline-delivery.ts';
export * from './timeline-delivery.ts';
import {workspaceBackupSchemas} from './workspace-backup.ts';
export * from './workspace-backup.ts';
import {workspaceRestoreSchemas} from './workspace-restore.ts';
export * from './workspace-restore.ts';
import {timelineExportSettingsSchema,timelineExportCapabilitySchemas} from './timeline-export-profile.ts';
export * from './timeline-export-profile.ts';
import {z} from 'zod';
import {timelineSubtitleSchemas} from './timeline-subtitles.ts';
export * from './timeline-subtitles.ts';
import {timelineFormatSchemas} from './timeline-format.ts';
import {agentAuthorizationSchemas,agentAuthorizationDescriptions} from './agent-authorization.ts';
import {projectLifecycleSchemas,projectLifecycleDescriptions} from './project-lifecycle.ts';
export * from './project-lifecycle.ts';
export * from './agent-authorization.ts';
import {timelineRippleRemoveSchema} from './timeline-ripple-remove.ts';
import {projectHomeSchemas,projectHomeDescriptions} from './project-home.ts';
export {projectHomeSchemas,projectHomeDescriptions,projectSummarySchema,projectSummaryListSchema} from './project-home.ts';
export {TIMELINE_RIPPLE_REMOVE_OPERATION,timelineRippleRemoveSchema,isTimelineRippleRemoveInput} from './timeline-ripple-remove.ts';
export * from './timeline-format.ts';
import {frameSchemas} from './frame-extraction.ts';
export * from './frame-extraction.ts';
import {imageSchemas} from './images.ts';
export * from './images.ts';
import {imageReviewSchemas} from './image-reviews.ts';
export * from './image-reviews.ts';
export * from './image-settings.ts';
import {comfyRemoteSchemas} from './comfy-images.ts';
export * from './comfy-images.ts';
import {getCapabilityProfile,getGenerationProfileRegion,INPUT_PROFILE_VERSION} from './generation-input-profiles.ts';
import {getGenerationProfileIssue} from './generation-input-validation.ts';
export {INPUT_PROFILE_VERSION,PROFILE_VERSION,FRAME_PAIR_PROFILE_VERSION,SUBJECT_REFERENCE_PROFILE_VERSION,ARCHIVED_CAPABILITY_PROFILES,getLegacyCapabilityProfile,GENERATION_INPUT_ROLES,INPUT_ROLES,GENERATION_INPUT_PROFILES,CAPABILITY_PROFILES,getCapabilityProfile,getGenerationProfileRegion} from './generation-input-profiles.ts';
export {validateGenerationInput,buildAdapterPlan,encodedImageDataUriBytes,evaluateCapabilityLifecycle,getGenerationProfileIssue} from './generation-input-validation.ts';
export {getShotGenerationReferenceSelection} from './video-frame-selection.ts';
import {getSubjectGenerationSnapshotIssue} from './subject-generation.ts';
export * from './subject-generation.ts';
import {subjectSchemas} from './subjects.ts';
export {SUBJECT_KINDS,SUBJECT_MUTATION_OPERATIONS,SUBJECT_LIMITS,subjectSchemas,subjectResponseSchema,subjectVersionResponseSchema,subjectBindingResponseSchema,isSubjectResponse,isSubjectVersionResponse,isSubjectBindingResponse,isSubjectMutationResponse,isSubjectListResponse} from './subjects.ts';
import {inspectionSchemas} from './inspection.ts';
import {sourceRangeSchemas} from './source-range.ts';
import {assetAnnotationSchemas} from './asset-annotations.ts';
import {assetDispositionSchemas} from './asset-disposition.ts';
import {waveformSchemas} from './waveforms.ts';
import {exportPreflightSchemas} from './export-preflight.ts';
import {exportSamplePeakSchemas} from './export-sample-peak.ts';
export * from './export-sample-peak.ts';
import {exportLoudnessSchemas} from './export-loudness.ts';
export * from './export-loudness.ts';
import {timelineLoudnessApplySchemas} from './timeline-loudness-apply.ts';
export * from './timeline-loudness-apply.ts';
import {timelineClipLoudnessSchemas} from './timeline-clip-loudness.ts';
import {timelineMixLoudnessSchemas} from './timeline-mix-loudness.ts';
export * from './timeline-mix-loudness.ts';
export * from './timeline-clip-loudness.ts';
import {assertOperationEffectCoverage} from './operation-effects.ts';
export {inspectionArgumentSchemas, inspectionSchemas} from './inspection.ts';
export {operationEffects, operationEffect, assertOperationEffectCoverage, effectAnnotations} from './operation-effects.ts';
export {AGENT_PROTOCOLS, deriveAgentEndpoint} from './agent-protocol.ts';
export * from './agent-timeline-move.ts';
export * from './agent-timeline-gain.ts';
import {createAgentTimelineGainContracts} from './agent-timeline-gain.ts';
import {isTimelineRecord as gainTimelineRecord} from './timeline-replacement.ts';
import {hasRequestNotAppliedProof as gainNotAppliedProof} from './timeline-acknowledgement.ts';
export const {isAgentTimelineGainTarget, isAgentTimelineGainProposal, agentTimelineGainTargetFromTimeline,
  agentTimelineGainPublicTarget, agentTimelineGainReviewTarget, agentTimelineGainModelContext, agentTimelineGainDiff} =
  createAgentTimelineGainContracts({isTimelineRecord: gainTimelineRecord, hasRequestNotAppliedProof: gainNotAppliedProof});
export {LOCAL_MUTATION_OPERATIONS, isLocalMutationResponse} from './local-mutations.ts';
export {SOURCE_RANGE_FPS, sourceFrameCount, isSourceRangeResponse, sourceRangeSchemas} from './source-range.ts';
export {ASSET_DISPOSITIONS, ASSET_DISPOSITION_BATCH_LIMIT, assetDispositionSchemas, isAssetDispositionResponse, isAssetDispositionListResponse} from './asset-disposition.ts';
export {WAVEFORM_ALGORITHM, WAVEFORM_FPS, WAVEFORM_SAMPLE_RATE, WAVEFORM_BINS_PER_SECOND, WAVEFORM_MAX_DURATION, WAVEFORM_MAX_SOURCE_FRAMES, WAVEFORM_MAX_POINTS, WAVEFORM_DEFAULT_POINTS, WAVEFORM_STATUSES, waveformSchemas, waveformResponseSchema, isWaveformResponse} from './waveforms.ts';
export {TIMELINE_FADE_MAX_FRAMES, getTimelineFadeIssue} from './timeline-fades.ts';
export {isTimelineReplacementResponse, isTimelineRecord, TIMELINE_RESPONSE_BYTES, TIMELINE_REPLACEMENT_RESPONSE_BYTES} from './timeline-replacement.ts';
export {TIMELINE_MUTATION_OPERATIONS, TIMELINE_RENDER_RESPONSE_BYTES, isTimelineMutationResponse, isTimelineRenderRecord, hasRequestNotAppliedProof} from './timeline-acknowledgement.ts';
export {REFERENCE_MUTATION_OPERATIONS, REFERENCE_RESPONSE_BYTES, isReferenceMutationResponse, isReferenceShotRecord, isReferenceEdgeRecord} from './reference-acknowledgement.ts';
export {exportPreflightSchemas, exportPreflightResponseSchema, isExportPreflightResponse, EXPORT_PREFLIGHT_LIMITS} from './export-preflight.ts';
export {DURABLE_EDIT_OPERATIONS, EDIT_TASK_LIMITS, EDIT_TASK_STATUSES, editTaskLane, isEditTask, isEditTaskEnvelope, isEditTaskListEnvelope} from './edit-tasks.ts';
const id=z.string().uuid(), key=z.string().min(8).max(200), position=z.object({x:z.number().finite(),y:z.number().finite()}).strict();
const mutationRequestId=key.optional().describe('Optional stable replay key (8–200 characters). Reuse the exact operation and caller-supplied input to recover the original response, even after later revisions. Changed reuse conflicts; without a key legacy mutation semantics apply.');
const params=z.object({scenario:z.enum(['success','failure','delay','timeout','unknown','reject','download_fail_once','rejected_before_accept','accepted_then_response_lost','poll_timeout_then_recover','terminal_failure']).optional(),delayMs:z.number().int().min(0).max(120000).optional(),seed:z.number().int().optional()}).strict();
const shotFields={title:z.string().min(1).max(150),prompt:z.string().max(5000),referenceAssetIds:z.array(id).max(8),lastFrameAssetId:id.nullable().describe('Optional saved last-frame image. Omission preserves the previous shape/selection; null explicitly clears it. First-frame references and reference edges are unchanged.'),aspectRatio:z.enum(['9:16','16:9','1:1','3:4','4:3','21:9']),duration:z.number().int().min(1).max(20),parameters:params,position};
const frame=z.number().int().min(0).max(18000), durationFrames=z.number().int().min(1).max(18000);
const sourceFrame=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-18000);
const even=(minimum: number, maximum: number)=>z.number().int().min(minimum).max(maximum).multipleOf(2);
// Syntax admits the maximum supported envelope. The aggregate and ACK validate
// against their own exact preset pair, including historical acknowledgements.
const rect=z.object({x:even(0,1918),y:even(0,1918),width:even(2,1920),height:even(2,1920)}).strict().refine(r=>r.x+r.width<=1920&&r.y+r.height<=1920,{message:'Rectangle exceeds the supported output envelope'});
const timelineMutation={projectId:id,expectedRevision:z.number().int().positive(),requestId:key};
// Validation preserves the submitted profile, point order and explicit null.
// An update without duration remains lexical; execution uses its original clip.
const volumeEnvelope=z.custom(value=>isVolumeEnvelope(value,18000),{message:'Invalid bounded clip volume envelope.'});
const clipFields={volumeEnvelope:volumeEnvelope.optional(),audioRole:clipAudioRoleSchema.optional(),colour:clipColourSchema.optional(),trackId:id,name:z.string().min(1).max(200),startFrame:frame,durationFrames,sourceInFrame:sourceFrame,rect,gain:z.number().finite().min(0).max(2),
 fadeInFrames:frame.describe('Optional audio fade-in in 30fps timeline frames. Omitted means zero without storing a new key. Positive fades require confirmed source audio; fade-in plus fade-out must not exceed clip duration.').optional(),
 fadeOutFrames:frame.describe('Optional audio fade-out in 30fps timeline frames. Omitted means zero without storing a new key. Positive fades require confirmed source audio; fade-in plus fade-out must not exceed clip duration.').optional()};
export const schemas={
...projectLifecycleSchemas,
...projectHomeSchemas,
...agentAuthorizationSchemas,
...lutResourceSchemas,
...lookPackInspectSchemas,
...timelineColourSchemas,
...workspaceBackupSchemas,
...workspaceRestoreSchemas,
...timelineFormatSchemas,
...timelineSubtitleSchemas,
...frameSchemas,
...imageSchemas,
...imageReviewSchemas,
...comfyRemoteSchemas,
...inspectionSchemas,
...subjectSchemas,
...sourceRangeSchemas,
...assetDispositionSchemas,
...assetAnnotationSchemas,
...waveformSchemas,
...exportPreflightSchemas,
...exportSamplePeakSchemas,
...exportLoudnessSchemas,
...timelineMixLoudnessSchemas,
...timelineClipLoudnessSchemas,
...timelineLoudnessApplySchemas,
...audioPreviewSchemas,
...continuousAudioSchemas,
...timelineExportCapabilitySchemas,
'project.create':z.object({name:z.string().min(1).max(150),description:z.string().max(2000).optional(),timelinePresetId:z.enum(['portrait_1080','landscape_1080','square_1080']).optional()}).strict(),
'project.list':z.object({}).strict(),
'project.get':z.object({projectId:id}).strict(),
'asset.import':z.object({projectId:id,name:z.string().min(1).max(200),mimeType:z.enum(['image/png','image/jpeg','image/webp','video/mp4','video/webm','audio/wav','audio/mpeg','audio/mp4']),dataBase64:z.string().max(40*1024*1024)}).strict(),
'asset.list':z.object({projectId:id}).strict(),
'shot.create':z.object({requestId:mutationRequestId,projectId:id,...Object.fromEntries(Object.entries(shotFields).map(([k,v])=>[k,k==='title'?v:v.optional()]))}).strict(),
'shot.update':z.object({requestId:mutationRequestId,shotId:id,expectedRevision:z.number().int().positive(),patch:z.object(Object.fromEntries(Object.entries(shotFields).map(([k,v])=>[k,v.optional()]))).strict().refine(v=>Object.keys(v).length>0)}).strict(),
'shot.reorder':z.object({requestId:mutationRequestId,projectId:id,expectedRevision:z.number().int().positive(),shotIds:z.array(id)}).strict(),
'node.create':z.object({requestId:mutationRequestId,projectId:id,type:z.enum(['text','image','video','audio']),label:z.string().max(150).optional(),text:z.string().max(5000).optional(),assetId:id.optional(),position}).strict(),
'node.update':z.object({requestId:mutationRequestId,nodeId:id,expectedRevision:z.number().int().positive(),patch:z.object({label:z.string().max(150).optional(),text:z.string().max(5000).optional(),position:position.optional()}).strict()}).strict(),
'edge.create':z.object({projectId:id,source:id,target:id}).strict(),
'edge.delete':z.object({edgeId:id}).strict(),
'reference.attach':z.object({projectId:id,sourceNodeId:id,targetShotId:id,expectedSourceRevision:z.number().int().positive(),expectedShotRevision:z.number().int().positive(),requestId:key,role:z.literal('first_frame')}).strict(),
'reference.detach':z.object({projectId:id,edgeId:id,expectedShotRevision:z.number().int().positive(),requestId:key}).strict(),
'provider.list':z.object({}).strict(),
'generation.submit':z.object({shotId:id,expectedRevision:z.number().int().positive(),requestId:key,providerId:z.enum(['mock','runway','ark','veo','minimax','vidu']),model:z.string().max(100).optional(),parameters:params.optional(),subjectVersionId:id.optional().describe('Explicit immutable subject version for one subject-reference image; the server resolves its identity and metadata. Omission preserves existing frame generation. Subject and first/last-frame inputs cannot be combined.')}).strict(),
'job.get':z.object({jobId:id}).strict(),
'job.list':z.object({projectId:id}).strict(),
'job.retry':z.object({jobId:id,requestId:key}).strict(),
'job.cancel':z.object({jobId:id}).strict(),
'job.reconcile':z.object({jobId:id,providerJobId:z.string().max(200).optional()}).strict(),
'version.list':z.object({shotId:id}).strict(),
'version.select':z.object({requestId:mutationRequestId,shotId:id,versionId:id,expectedRevision:z.number().int().positive()}).strict(),
'export.create':z.object({projectId:id,requestId:key}).strict(),
'export.get':z.object({exportId:id}).strict(),
'timeline.get':z.object({projectId:id}).strict(),
'timeline.history.get':z.object({projectId:id}).strict(),
'timeline.undo':z.object(timelineMutation).strict(),
'timeline.redo':z.object(timelineMutation).strict(),
'timeline.track.add':z.object({...timelineMutation,kind:z.enum(['video','audio']),name:z.string().min(1).max(150).optional()}).strict(),
'timeline.track.update':z.object({...timelineMutation,trackId:id,patch:z.object({name:z.string().min(1).max(150).optional(),hidden:z.boolean().optional(),muted:z.boolean().optional()}).strict().refine(p=>Object.keys(p).length>0)}).strict(),
'timeline.clip.add':z.object({...timelineMutation,assetId:id,...clipFields,name:clipFields.name.optional(),sourceInFrame:sourceFrame.optional(),rect:rect.optional(),gain:clipFields.gain.optional()}).strict().refine(value=>!Object.hasOwn(value,'volumeEnvelope')||isVolumeEnvelope(value.volumeEnvelope,value.durationFrames),{message:'Envelope points exceed the clip duration.',path:['volumeEnvelope']}),
'timeline.clip.update':z.object({...timelineMutation,clipId:id,patch:z.object(Object.fromEntries(Object.entries(clipFields).map(([k,v])=>[k,v.optional()]))).strict().refine(p=>Object.keys(p).length>0).refine(p=>!Object.hasOwn(p,'volumeEnvelope')||isVolumeEnvelope(p.volumeEnvelope,(p.durationFrames as number | undefined)??18000),{message:'Envelope points exceed the resulting clip duration.',path:['volumeEnvelope']})}).strict(),
'timeline.clip.replaceSource':z.object({...timelineMutation,clipId:id,assetId:id,versionId:id.optional().describe('Optional exact generated version to pin with its canonical shot. Must belong to the replacement asset and project. Omission keeps an asset-only fixed reference; no version is inferred.')}).strict(),
'timeline.clip.remove':z.object({...timelineMutation,clipId:id}).strict(),
'timeline.clip.rippleRemove':timelineRippleRemoveSchema,
'timeline.clip.split':z.object({...timelineMutation,clipId:id,atFrame:frame}).strict(),
'timeline.seed':z.object(timelineMutation).strict(),
'timeline.render':z.object({...timelineMutation,purpose:z.enum(['preview','export']),exportRange:timelineExportRangeSchema.optional().describe('Optional export-only half-open [startFrame,endFrame) interval at the saved 30fps clock; at least one frame, bounded by the saved timeline. The full frozen snapshot remains unchanged. Omission preserves full export and historical bytes.'),deliveryName:timelineDeliveryNameSchema.optional(),exportSettings:timelineExportSettingsSchema.optional(),preflightSnapshotHash:z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Optional exact snapshot digest returned by timeline.export.preflight. New renders verify it against current frozen content; exact replay still returns its original response first. Omission preserves the legacy input and response. A successful check does not guarantee future source availability or full decoding.')}).strict().refine(value=>value.exportSettings===undefined||value.purpose==='export',{message:'Export settings are available only for export renders',path:['exportSettings']}).refine(value=>isTimelineDeliveryNameInput(value,value.purpose),{message:'Delivery names are available only for export renders and must be explicitly valid',path:['deliveryName']}).refine(value=>isTimelineExportRangeInput(value,value.purpose),{message:'Export ranges are available only for export renders and must be explicitly valid',path:['exportRange']})
};
// A new operation must receive an audited effect descriptor before discovery
// or dispatch can initialize; never infer safety from an operation-name suffix.
assertOperationEffectCoverage(schemas);
export type OperationName = keyof typeof schemas;
export type OperationInput<K extends OperationName> = z.infer<(typeof schemas)[K]>;
export const descriptions: Record<string, string> = {
...projectHomeDescriptions,
'workspace.backup.inspect':'只读检查整个工作区的有界数据库计数；不复制文件、不恢复任务、不读取密钥。冷备份前必须正常关闭应用和同工作区后端。',
'workspace.restore.inspect':'只读查看工作区恢复分支身份、隔离计数与可用操作，可显式请求已验证的音频角色与音量包络能力；不接收路径、不恢复或执行旧任务、不授予模型或付费权限。',
'project.create':'创建持久化视频项目','project.list':'列出项目','project.get':'读取完整项目、画布和任务','asset.import':'导入授权的本地图片或视频字节（base64，最大30MiB）','asset.list':'读取项目素材','shot.create':'创建稳定ID镜头','shot.update':'按版本更新镜头，旧版本返回冲突','shot.reorder':'按项目版本原子调整镜头顺序','node.create':'创建文本、图片或视频画布节点','node.update':'按版本更新节点','edge.create':'连接同一项目节点','edge.delete':'移除连线','provider.list':'查询供应商能力与配置状态','generation.submit':'用稳定requestId提交生成（默认仅模拟）','job.get':'读取任务和可恢复错误','job.list':'读取项目任务','job.retry':'显式重试已明确失败任务，必须用新requestId','job.cancel':'停止本地等待，不声称已取消供应商任务','job.reconcile':'重新查询或对账已有任务，不重新提交','version.list':'列出不可变生成版本','version.select':'按镜头版本选择结果','export.create':'冻结已选版本并按镜头顺序导出真实9:16 MP4','export.get':'查询导出进度和文件'};
Object.assign(descriptions,{
 ...projectLifecycleDescriptions,
 ...agentAuthorizationDescriptions,
 ...lutResourceDescriptions,
 ...lookPackInspectDescriptions,
 ...timelineColourDescriptions,
 'timeline.audioPreview.plan':'只读规划当前已保存时间线最多20秒的声音试听区间；绑定项目、版本与素材哈希，返回有界PCM准备清单。此调用不解码、不播放、不初始化时间线、不写入；PCM另由固定已认证本地资源显式有界解码，不能作为完整成片或响度/真峰值检查。',
 'timeline.audioPreview.continuousPlan':'只读规划已保存时间线的连续音频预览会话；绑定完整版本与源身份，固定双秒块及全会话96MiB额度。不解码、不播放、不写入；显式播放后由固定认证本地资源按需准备完整多轨混音。不是内置Agent工具。',
 'timeline.subtitle.add':'按时间线版本添加一条手动字幕；固定字体排版，30fps时间，返回完整已保存时间线',
 'timeline.subtitle.update':'按时间线版本更新指定字幕文字或时间；不修改素材，不生成语音或转录',
 'timeline.subtitle.remove':'按时间线版本移除指定手动字幕，保留精确请求回执和撤销历史',
 'frame.extract':'用稳定请求键从本项目固定素材哈希与30fps源时点显式提取一张本地PNG；先持久化任务再解码，不修改原素材，不生成或付费；30fps标记不是原生或VFR帧号',
 'frame.request.get':'只读查询原抽帧操作的不可变受理回执；历史状态不触发执行，当前状态另查task.get',
 'frame.task.get':'只读查询本项目已有抽帧任务和安全结果元数据；不读取媒体或恢复任务',
 'frame.task.list':'按项目分页只读发现本地抽帧任务，默认20条、最多50条；重启和查询不会自动解码',
 'frame.task.cancelQueued':'按任务版本和稳定请求键仅取消排队或明确未启动的中断抽帧任务；已运行任务不伪称取消成功',
 'frame.task.recoverResult':'按任务版本和稳定请求键明确校验并发布已存在的完整PNG与任务凭据；不重新解码，不重新提交',
 'image.profile.list':'读取图像预设；includeSettingsRevision:true 可发现对应槽的非秘密配置版本，默认响应不变；不探测网络、解密密钥或授予生成批准',
 'image.review.prepare':'保存当前项目的精确图像请求供用户确认；官方 OpenAI 可编辑一张已验证的项目内 PNG，冻结原始字节哈希及来源；自定义兼容仅文本生成，本机 ComfyUI 冻结固定工作流。准备不批准、不生成、不发送请求',
 'image.review.get':'读取当前项目已保存的图像请求确认记录；不会批准、执行或重试',
 'image.review.list':'分页读取当前项目图像请求确认记录；不会批准或执行',
 'image.generate':'持久化精确 Mock 图像请求或重放原回执；Mock 与官方 OpenAI 可选择单张项目内 PNG 作为编辑来源，原图保留。新真实请求须先准备 review 并由用户界面批准；不自动替换镜头、引用或时间线',
 'image.request.get':'只读查找原图像请求的不可变受理回执；返回历史状态，不重试、不启动工作，当前状态另查 task.get',
 'image.task.get':'只读查询本项目图像任务与可恢复状态，不恢复或重新生成',
 'image.task.list':'分页只读列出项目或图像组任务，最新记录在前，不启动任务',
 'image.group.get':'只读查询已有图像组当前版本及待处理任务，不创建分组',
 'image.group.list':'分页只读列出项目图像组，最新创建记录在前',
 'image.version.list':'分页只读列出图像组的不可变结果，版本号降序；仅返回安全托管素材元数据',
 'image.task.cancelQueued':'用稳定请求 ID 和任务版本明确取消尚未分派的排队或中断任务，不代表供应商退款',
 'image.task.recoverResult':'用稳定请求 ID 明确核验并保存已存在的本地结果；缺失结果保持待确认，绝不重新调用图像供应商',
 'image.task.remote.get':'只读当前项目已有本机 ComfyUI 任务的本地远端状态记录和最近观察进度；不联网、不创建任务、不恢复或启动观察',
 'image.task.observeRemote':'按远端记录版本和稳定请求 ID 持久化一次观察；异步仅查询已冻结 ComfyUI 任务，验证完成身份后可取回一个固定 PNG；不提交、不重试生成、不自动轮询，原受理回执永久保留',
 'subject.create':'创建项目内版本化主体，仅固定已有托管图片及来源，不生成媒体；必须使用稳定请求 ID',
 'subject.version.add':'添加主体的不可变参考版本；已有绑定固定旧选择并提示复核，不自动更新镜头或生成',
 'subject.binding.set':'按独立绑定版本和主体版本明确固定、复核或解除主体/风格引用；不会修改首帧或时间线',
 'subject.list':'分页只读列出项目主体与当前参考版本，不创建记录，不返回媒体路径或 URL',
 'subject.version.list':'分页只读列出主体所有不可变参考版本，可明确重新选择旧版',
 'subject.binding.list':'按唯一镜头或主体过滤器分页只读列出绑定及保留的解绑版本，标记是否需复核',
 'timeline.export.capabilities':'显式检查所选 MP4/H264 导出配置的本地编码能力；运行有界本地计算，不修改项目或导出，不调用供应商；结果绑定项目和时间线版本，实际导出会再次验证',
 'timeline.export.preflight':'只读检查既有时间线的本地导出条件；按版本流式核验素材哈希并运行有界ffprobe元数据检查，不完整解码、不创建时间线、缓存或导出，不调用供应商；返回ready、blocked、incomplete或stale，检查结果不保证未来文件可用',
 'timeline.export.samplePeak':'已导出文件解码样本峰值：显式完整解码一个已成功导出的托管文件，返回绑定实际核验文件哈希的临时测量；单次有界本地计算，不排队、不保存、不重试、不修改项目或导出、不调用供应商；结果不保证其他播放或制作阶段的表现',
 'timeline.export.loudness':'已导出文件响度与真峰值估计：按显式文件哈希和固定测量配置完整解码一个已成功导出的托管 MP4，返回临时结果；仅显式自定义目标产生算术建议，不验证当前时间线、不授权应用增益；有界本地只读计算，不排队、不保存、不重试、不调用模型或供应商、不修改或阻止导出',
 'timeline.loudness.apply':'显式应用整片响度候选：按固定请求身份、版本、来源快照和候选摘要重新完整测量，仅在两个目标通过后原子修改可听片段增益并保存一次撤销历史及原始回执；旧请求先重放，不重新测量，不接受客户端增益，不自动限幅或切换导出模式，不调用模型或供应商。恢复副本仅可读取被保留历史回执，不允许新应用',
 'timeline.clip.loudness':'显式测量一个最多60秒（1800帧）的完整已保存选中片段，超过时拒绝且不自动截短；测量片段在源裁切、增益和淡入淡出后的独立声音；不混入其他轨道。绑定精确版本、片段及源哈希，固定配置、有界本地只读解码。无目标、候选、应用、持久报告、媒体写入、队列、自动重试或供应商调用',
 'timeline.loudness.prepare':'显式按已保存时间线版本、固定混音和测量配置及用户自选 LUFS/dBTP 目标，完整测量编码前浮点混音与实际固定增益候选；结果临时且 applyAllowed 始终为 false。有界高资源本地只读计算，不写文件或数据库、不排队、不默认目标、不编辑、不导出、不重试、不调用模型或供应商',
 'asset.waveform.request':'显式请求本地源音频波形缓存；重复请求复用排队、运行或就绪结果，失败或中断须显式retry；运行有界本地解码并写入可淘汰缓存，不调用生成供应商、不编辑素材或时间线',
 'asset.waveform.get':'只读查询指定项目素材的源音频波形；30fps源范围使用排他出点，最多返回2048个归一化峰值；不启动解码、不探测媒体、不修复或写入缓存；不表示时间线混音结果',
 'asset.disposition.list':'只读查询指定项目中1–100个不重复素材的共享标记，按请求顺序返回；未保存时为 neutral 和 revision 0；缺失或跨项目时整批失败，不创建记录',
 'asset.annotation.list':'读取明确批次中的项目素材标签和纯文本备注，不创建记录',
 'asset.annotation.set':'按独立版本保存项目素材标签和纯文本备注；必须使用稳定请求 ID 精确重放，不修改素材字节、生成版本或时间线',
 'asset.disposition.set':'按独立版本设置素材共享标记 neutral、favorite 或 rejected；重置仍保留版本；必须使用稳定requestId精确重放，不删除素材、不修改名称、字节、源范围或时间线',
 'asset.range.get':'只读查询已有视频或音频素材的独立源范围；未保存时返回 revision 0 和 range null，不创建记录；使用30fps时间线时基，非原生/VFR逐帧精度',
 'asset.range.set':'按独立范围版本保存素材入点和排他出点；至少1帧，可超过时间线18000帧上限；必须使用稳定requestId精确重放，不修改素材、版本或时间线',
 'project.inspect':'只读检查指定项目的有界安全元数据；不创建时间线，不返回路径、URL或媒体',
 'asset.inspect':'分页只读检查指定项目的安全素材元数据；默认10条、最多25条，不读取媒体',
 'shot.inspect':'分页只读检查指定项目的安全镜头元数据；默认10条、最多25条，提示词最多返回1000UTF-8字节并标明截断，不返回媒体',
 'timeline.inspect':'只读检查已存在的时间线安全元数据；不存在时如实报告，不创建空时间线',
 'project.get':'读取完整项目、画布和任务；旧项目首次读取时可创建空时间线',
 'edge.create':'创建同项目的视觉连线；不参与生成，也不传递提示词或素材',
 'edge.delete':'仅移除视觉连线；首帧参考连线须使用 reference_detach',
 'reference.attach':'原子连接同项目的托管图片节点与镜头作为首帧；须校验两端版本且镜头无手选参考图，使用稳定requestId',
 'reference.detach':'按镜头版本原子断开首帧参考连线并清除其专属参考选择；保留原素材、节点及历史任务快照，使用稳定requestId',
 'asset.import':'导入授权的本地图片、视频或音频字节（base64，最大30MiB）',
 'node.create':'创建文本、图片、视频或音频画布节点',
 'timeline.format.get':'只读查询当前时间线输出规格、版本与初始设置资格；不创建时间线',
 'timeline.format.set':'仅为初始空白时间线显式设置竖屏、横屏或方屏720规格，固定30fps；项目与时间线双版本校验，精确请求重放，不进入撤销历史',
 'timeline.get':'读取持久化30fps多轨时间线；旧项目首次读取时仅创建空轨道',
 'timeline.history.get':'只读查询时间线编辑历史与撤销/重做位置；不创建时间线，不包含媒体或生成任务',
 'timeline.undo':'按时间线版本撤销一次轨道或片段编辑；保留稳定ID并递增版本，不撤销生成、花费或导出',
 'timeline.redo':'按时间线版本重做一次已撤销的轨道或片段编辑；使用稳定requestId恢复原请求结果',
 'timeline.track.add':'按时间线版本新增视频或音频轨道，最多12轨',
 'timeline.track.update':'按时间线版本更新轨道名称、画面隐藏或静音',
 'timeline.clip.add':'在指定轨道与帧位置添加固定素材片段；同轨不可重叠',
 'timeline.clip.update':'按时间线版本移动、裁切或调整片段及音频角色分类，保留固定素材引用；角色不改变声音，可撤销',
 'timeline.clip.replaceSource':'按时间线版本显式替换片段的固定素材；仅同类视频、音频或图片互换，保留片段ID、位置、时长、源入点、画面、音量和淡入淡出；可选versionId须精确匹配新素材并固定来源镜头，不跟随镜头后续选用版本；使用必填稳定requestId精确重放，可撤销，不生成或处理媒体',
 'timeline.clip.remove':'按时间线版本移除指定片段',
 'timeline.clip.rippleRemove':'移除指定片段，并将同轨后续片段前移被删片段时长；其他轨道不动，一次撤销，保留稳定requestId以精确重放',
 'timeline.clip.split':'在所选片段内部的整数时间线帧原子分割；左段保留ID，右段固定新ID；保留素材和源范围，不移动其他片段，可一次撤销，使用稳定requestId',
 'timeline.seed':'仅向空时间线按镜头顺序复制当前所选版本，之后独立编辑',
 'timeline.render':'冻结完整多轨时间线和素材哈希，排队生成真实预览或导出；导出可指定30fps左闭右开的帧范围，快照保持完整；通过export_get查询'
});
export {AppError};
const operationSchemas = schemas as Record<string, z.ZodTypeAny>;
export function parse<K extends OperationName>(op: K, input: unknown): OperationInput<K> {
 if(!Object.hasOwn(schemas,op))throw new AppError('UNKNOWN_OPERATION','未知操作',404);
 const r=operationSchemas[op].safeParse(input);
 if(!r.success)throw new AppError('VALIDATION_ERROR','输入字段无效',400,{issues:r.error.issues.map(x=>({path:x.path,message:x.message}))});
 return r.data as OperationInput<K>;
}
export function publicValue(value: unknown): unknown {
 if(Array.isArray(value))return (value as unknown[]).map((item: unknown)=>publicValue(item));
 if(value&&typeof value==='object'){
  const result: Record<string, unknown> = Object.fromEntries(Object.entries(value).filter(([k])=>!['path','relativePath','requestHash'].includes(k)).map(([k,x])=>[k,publicValue(x)]));
  const record = value as {shotId?: unknown; providerId?: unknown; status?: unknown; requestId?: unknown};
  if(record.shotId&&record.providerId&&record.status&&record.requestId)result.allowedActions=record.status==='failed'?['retry']:record.status==='submission_unknown'?['reconcile','cancel']:record.status==='cancelled'?['reconcile']:record.status==='succeeded'?[]:['cancel'];
  return result;
 }
 return value;
}

// Pure provider capability checks shared by HTTP/CLI/MCP validation and the renderer.
// Reference bytes and paid authorization remain backend-only checks.
export function findModelCapabilities(capabilities: unknown, model?: unknown): Record<string, unknown> | null {
 const capabilityRecord = capabilities as Record<string, unknown> | null | undefined;
 const models=Array.isArray(capabilityRecord?.models)?capabilityRecord.models as unknown[]:[];
 const firstModel=models[0];
 const id=model||(typeof firstModel==='string'?firstModel:(firstModel as {id?: unknown} | null | undefined)?.id);
 if(Object.hasOwn(capabilityRecord||{},'inputProfiles')){
  const record = capabilityRecord as Record<string, unknown>;
  const region=getGenerationProfileRegion(record.id,record),profile=getCapabilityProfile(record.id,id,region);
  if(!profile||record.providerRegion!==region||record.inputProfileVersion!==INPUT_PROFILE_VERSION||!Array.isArray(record.inputProfiles))return null;
  const profileMatches=(record.inputProfiles as unknown[]).filter(item=>{
   const entry=item as {providerId?: unknown; model?: unknown; regions?: unknown} | null | undefined;
   if(!entry||entry.providerId!==record.id||entry.model!==id||!Array.isArray(entry.regions))return false;
   return (entry.regions as unknown[]).includes(region);
  });
  const match=profileMatches[0] as Record<string, unknown> | undefined;
  if(!match||profileMatches.length!==1||match.profileId!==profile.profileId||match.profileVersion!==profile.profileVersion)return null;
  const image=profile.inputs.roles.first_frame;
  const advertised=(Array.isArray(record.modelCapabilities)?record.modelCapabilities as unknown[]:[]).find(item=>(item as {id?: unknown} | null | undefined)?.id===id) as Record<string, unknown> | undefined;
  return {...advertised,id,name:advertised?.name||id,
   inputModes:profile.inputModes,aspectRatios:profile.aspectRatios,durations:profile.durationsSeconds,
   referenceImages:{min:profile.inputs.minReferences,max:profile.inputs.maxReferences,mimeTypes:image.mimeTypes,...(image.dimensions?{minDimension:image.dimensions.min,maxDimension:image.dimensions.max,matchAspectRatio:image.dimensions.matchAspectRatio}:{})},
   promptRequired:profile.prompt.required,maxPromptLength:profile.prompt.maxCodeUnits,parameters:Object.keys(profile.parameters),...(profile.parameters.seed?{seed:profile.parameters.seed}:{})};
 }
 // Legacy/custom capability fixtures retain their exact model lookup contract.
 // Production discovery uses the explicit profile branch above, never this union.
 const advertisedLegacy=(Array.isArray(capabilityRecord?.modelCapabilities)?capabilityRecord.modelCapabilities as unknown[]:[]).find(item=>(item as {id?: unknown} | null | undefined)?.id===id);
 if(advertisedLegacy!==undefined)return advertisedLegacy as Record<string, unknown>;
 return models.some(item=>(typeof item==='string'?item:(item as {id?: unknown} | null | undefined)?.id)===id)
  ?{...capabilityRecord,id,referenceImages:{min:(capabilityRecord?.inputModes as unknown[] | undefined)?.includes('text')?0:1,max:(capabilityRecord?.maxReferenceImages as number | undefined)??1}}
  :null;
}
export interface GenerationIssue {code: string; message: string}
interface GenerationReferenceMetadata {mimeType?: unknown; width?: unknown; height?: unknown; role?: unknown}
interface ReferenceImageConstraints {min: number; max: number; mimeTypes?: unknown[]; minDimension?: number; maxDimension?: number | null; matchAspectRatio?: boolean}
export function getGenerationIssue(snapshot: unknown, capabilities: unknown): GenerationIssue | null {
 const issue=(code: string,message: string): GenerationIssue=>({code,message});
 const dataRecord=(value: unknown): boolean=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&!Object.getOwnPropertySymbols(value).length&&Object.values(Object.getOwnPropertyDescriptors(value)).every(d=>!d.get&&!d.set&&d.enumerable));
 const denseArray=(value: unknown): value is unknown[]=>{if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>8)return false;const descriptors=Object.getOwnPropertyDescriptors(value);return Reflect.ownKeys(descriptors).length===value.length+1&&Reflect.ownKeys(descriptors).every(key=>key==='length'||typeof key==='string'&&/^(0|[1-9]\d*)$/.test(key)&&Number(key)<value.length&&!descriptors[key].get&&!descriptors[key].set&&descriptors[key].enumerable);};
 if(!dataRecord(snapshot))return issue('INVALID_INPUT','生成输入必须为对象');
 const request = snapshot as Record<string, unknown>;
 const subjectIssue=getSubjectGenerationSnapshotIssue(snapshot);
 if(subjectIssue)return issue(subjectIssue.code,subjectIssue.message);
 // Keep the same legacy first-error pass as authoritative service validation.
 // Profile-only restrictions must not change established error precedence.
 const capabilityRecord = capabilities as Record<string, unknown> | null | undefined;
 const {inputProfiles: ignoredProfiles,...legacyCapabilities}=capabilityRecord||{};
 const model=findModelCapabilities(legacyCapabilities,request.model);
 if(!model)return issue('UNSUPPORTED_MODEL','此供应商不支持所选模型');
 const aspectRatios = model.aspectRatios as unknown[] | undefined;
 const durations = model.durations as unknown[] | undefined;
 if(!aspectRatios?.includes(request.aspectRatio)||!durations?.includes(request.duration))return issue('UNSUPPORTED_PARAMETERS','此模型不支持所选画幅或时长');
 const assets = request.referenceAssets;
 const refs = (assets===undefined||assets===null?[]:assets) as unknown[];
 if(!denseArray(refs)||request.referenceAssetIds!==undefined&&!denseArray(request.referenceAssetIds))return issue('UNSUPPORTED_INPUT','参考素材必须为完整且有界的数组');
 const referenceAssetIds = Array.isArray(request.referenceAssetIds)?request.referenceAssetIds as unknown[]:undefined;
 const count=referenceAssetIds?.length??refs.length;
 const mode=count?'image':'text';
 const inputModes = model.inputModes as unknown[] | undefined;
 if(!inputModes?.includes(mode))return issue('UNSUPPORTED_INPUT',mode==='text'?'此模型需要一张首帧参考图':'此模型不支持参考图输入');
 const declaredConstraints=(model.referenceImages||{min:mode==='text'?0:1,max:1}) as ReferenceImageConstraints;
 const typedHead=(value: unknown): GenerationReferenceMetadata=>value as GenerationReferenceMetadata;
 const typedTail=refs.some(asset=>dataRecord(asset)&&typedHead(asset).role==='last_frame')||(denseArray(request.referenceBindings)&&request.referenceBindings.some(binding=>dataRecord(binding)&&typedHead(binding).role==='last_frame'));
 const activeProfile=getCapabilityProfile(capabilityRecord?.id,model.id,getGenerationProfileRegion(capabilityRecord?.id,capabilityRecord));
 // A larger new pair envelope cannot relax the legacy first-only count pass.
 // In particular an old second reference never becomes an implicit tail.
 const subjectImage=Object.hasOwn(request,'subjectReference')?activeProfile?.inputs.roles.subject_reference:null;
 if(Object.hasOwn(request,'subjectReference')&&!subjectImage?.implemented)return issue('UNSUPPORTED_INPUT_ROLE','此供应商尚未实现主体参考生成');
 const subjectConstraints=subjectImage?.implemented?{min:1,max:1,mimeTypes:subjectImage.mimeTypes,...(subjectImage.dimensions?{minDimension:subjectImage.dimensions.min,maxDimension:subjectImage.dimensions.max,matchAspectRatio:subjectImage.dimensions.matchAspectRatio}:{})}:null;
 const constraints: ReferenceImageConstraints=subjectConstraints??(activeProfile?.inputs.roles.last_frame.implemented&&!typedTail?{...declaredConstraints,max:Math.min(declaredConstraints.max,1)}:declaredConstraints);
 if(count<constraints.min||count>constraints.max)return issue('UNSUPPORTED_INPUT',`此模型支持 ${constraints.min}–${constraints.max} 张参考图片`);
 if(refs.some(asset=>!dataRecord(asset)))return issue('UNSUPPORTED_INPUT','参考素材必须为普通数据对象');
 if(refs.some(asset=>{const reference=typedHead(asset);return !asset||typeof reference.mimeType!=='string'||!reference.mimeType.startsWith('image/');}))return issue('UNSUPPORTED_INPUT','首帧参考素材必须为图片');
 if(constraints.mimeTypes&&refs.some(asset=>!constraints.mimeTypes!.includes(typedHead(asset).mimeType)))return issue('UNSUPPORTED_INPUT','此模型不支持所选参考图片格式');
 if(constraints.minDimension&&refs.some(asset=>{const reference=typedHead(asset);return (reference.width as number)<constraints.minDimension!||(reference.height as number)<constraints.minDimension!;}))return issue('UNSUPPORTED_INPUT',`参考图宽高均须至少 ${constraints.minDimension} 像素`);
 if(constraints.maxDimension&&refs.some(asset=>{const reference=typedHead(asset);return (reference.width as number)>constraints.maxDimension!||(reference.height as number)>constraints.maxDimension!;}))return issue('UNSUPPORTED_INPUT',`参考图宽高均须不超过 ${constraints.maxDimension} 像素`);
 if(constraints.matchAspectRatio&&refs.length){const [w,h]=(request.aspectRatio as string).split(':').map(Number);if(refs.some(asset=>{const reference=typedHead(asset);return (reference.width as number)*h!==(reference.height as number)*w;}))return issue('UNSUPPORTED_INPUT','此模型首帧参考图须与所选画幅比例一致');}
 const maxPromptLength=(model.maxPromptLength as number | undefined)??5000;
 if(model.promptRequired&&(typeof request.prompt!=='string'||!request.prompt.trim()||request.prompt.length>maxPromptLength))return issue('INVALID_PROMPT',`请填写 1–${maxPromptLength} 字符的画面描述`);
 const parameters=(request.parameters??{}) as Record<string, unknown>;
 if(!dataRecord(parameters))return issue('UNSUPPORTED_PARAMETER','此模型不支持所选高级参数');
 const modelParameters = model.parameters as unknown[] | undefined;
 if(modelParameters&&Object.keys(parameters).some(key=>!modelParameters.includes(key)))return issue('UNSUPPORTED_PARAMETER','此模型不支持所选高级参数');
 const seedRule = model.seed as {min: number; max: number} | undefined;
 if(parameters.seed!==undefined&&seedRule&&(typeof parameters.seed!=='number'||!Number.isInteger(parameters.seed)||parameters.seed<seedRule.min||parameters.seed>seedRule.max))return issue('INVALID_SEED',`随机种子须为 ${seedRule.min}–${seedRule.max} 之间的整数`);
 if(Object.hasOwn(capabilityRecord||{},'inputProfiles')){const rich=getGenerationProfileIssue({...request,model:model.id},capabilities);if(rich)return issue(rich.code,rich.message);}
 return null;
}

export {ASSET_ANNOTATION_LIMITS,assetAnnotationSchemas,isAssetAnnotationResponse,isAssetAnnotationListResponse} from './asset-annotations.ts';

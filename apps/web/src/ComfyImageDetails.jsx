import React from 'react';

/** The exact server-frozen workflow is visible before private UI approval. */
export function ComfyImageReviewDetails({ review }) {
  const execution = review.execution;
  return <div className="image-generation-comfy-details" data-testid="image-comfy-review-details">
    <div className="image-generation-review-details"><span>{review.configuration.profileId} · ComfyUI v0.39.0</span><span>种子 {execution.seed} · 20 steps · CFG 8 · euler / normal · denoise 1</span><span>负向描述为空 · 固定 7 个内置节点</span><span className="image-generation-id">远端任务 {execution.promptId}</span><span className="image-generation-id">工作流 SHA-256 {execution.graphHash}</span></div>
    <details><summary>完整冻结工作流（审批后按此发送）</summary><pre className="image-generation-frozen-graph" data-testid="image-comfy-review-graph">{JSON.stringify(execution.graph, null, 2)}</pre></details>
    <p className="image-generation-charge">批准后向所列本机地址提交最多 1 次，可能占用 GPU、内存与磁盘。停止观察或关闭应用不会取消远端工作，GPU 工作可能继续。该地址与模型名称不保证免费、可信或完全离线。保留原始描述，不会自动重试。</p>
  </div>;
}

export function ComfyImageTaskDetails({ task, review, remoteState }) {
  return <div className="image-generation-comfy-details" data-testid="image-comfy-task-details">
    <div className="image-generation-review-details"><span>{task.model}</span>{review ? <><span>{review.destination}</span><span>原审批配置 r{review.settingsRevision} · {review.configuration.profileId}</span><span className="image-generation-id">远端任务 {review.execution.promptId}</span><span className="image-generation-id">冻结工作流 SHA-256 {review.execution.graphHash}</span></> : <span>此页未载入任务关联的原始审批，当前连接设置不代表此任务。</span>}</div>
    <p>远端身份状态：{remoteStatusLabel(remoteState?.remote)}</p>
    <p data-testid="image-comfy-graph-status">完整工作流：{remoteState?.remote?.contentVerified === true ? '已核验与冻结工作流一致' : '尚未核验；仅任务 ID 或排队状态不能证明内容一致'}</p>
    {remoteState?.observation && <p data-testid="image-comfy-observation-status">{{ queued: '本次查询等待执行', running: '正在查询并取回', finished: '本次查询已结束；以核验结果为准', interrupted: '本次查询已中断；需要再次明确查询，不会重提生成' }[remoteState.observation.state]}{remoteState.observation.errorCode ? '。未能取回可核验结果，请查看身份与内容状态。' : ''}</p>}
    <p>“查询并取回”只查询此任务并核验后取回结果，不重提生成。关闭面板或停止读取不会停止 ComfyUI 的 GPU 工作。</p>
  </div>;
}

export function remoteStatusLabel(remote) {
  return ({ prepared: '已保存身份，尚未发送', submitted: '已记录发送边界；是否送达待确认', submission_unknown: '发送结果未知', queued: '已找到相同任务 ID · 等待执行', running: '已找到相同任务 ID · 正在执行', completed: '已找到已完成任务', failed: '已找到失败任务', unavailable: '未取得可核验证据；不证明未执行' }[remote?.state] || '尚未核验');
}

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Badge } from '@mioon/ui/components/badge';
import { Button } from '@mioon/ui/components/button';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';
import { FRAME_PROFILE, frameCaptureBusy, frameCanCancel, frameCanRecover, frameTaskLabel } from './frame-extraction.js';
import './frame-extraction.css';

const active = task => ['queued', 'running', 'persisting'].includes(task.state);
export default function FrameExtractionPanel({ controller, visible = true }) {
  const ancestorVisible = useWorkspaceVisibility();
  visible = visible && ancestorVisible;
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot());
  const live = useRef(null);
  useLayoutEffect(() => {
    const token = { controller, visible, projectId: controller.getSnapshot().projectId, sourceScope: controller.getSnapshot().sourceScope };
    live.current = token;
    const update = () => setSnapshot(controller.getSnapshot());
    const unsubscribe = visible ? controller.subscribe(update) : () => {}; update();
    return () => { if (live.current === token) live.current = null; unsubscribe(); };
  }, [controller, visible, snapshot.projectId, snapshot.sourceScope]);
  const state = controller.getSnapshot();
  useEffect(() => { if (visible && state.visible && !state.blocked && state.projectId) void controller.refreshTasks(); }, [controller, visible, state.visible, state.blocked, state.projectId, state.sourceScope]);
  useEffect(() => {
    if (!visible || !state.visible || !state.tasks.some(active)) return;
    const timer = setTimeout(() => { if (live.current?.visible) void controller.refreshActive(); }, 2000);
    return () => clearTimeout(timer);
  }, [controller, visible, state.visible, state.tasks]);
  const capturedProject = state.projectId, capturedScope = state.sourceScope;
  const run = action => {
    const current = controller.getSnapshot(), binding = live.current;
    if (!binding || !binding.visible || binding.controller !== controller || binding.projectId !== capturedProject || binding.sourceScope !== capturedScope || !current.visible || current.projectId !== capturedProject || current.sourceScope !== capturedScope) return;
    return action();
  };
  const busy = !visible || frameCaptureBusy(state);
  const source = state.sourceAsset;
  const resultAsset = task => state.assets.find(asset => asset.projectId === task.projectId && asset.id === task.result?.assetId && asset.sha256 === task.result?.sha256 && asset.mimeType === 'image/png' && asset.provenance === 'extracted-frame');
  return <section className="frame-extraction-panel" aria-label="源视频抽帧" data-testid="frame-extraction-panel">
    <div className="frame-extraction-heading"><h3>源视频抽帧</h3><Badge className="small-badge neutral">本地 · 单张 PNG</Badge></div>
    <p className="input-hint">在源素材预览中暂停，再点击“提取此帧”。按 30 fps 编辑时间点寻找首个不早于该时间的解码帧；不是原生/VFR 帧号。</p>
    <p className="frame-extraction-profile" data-testid="frame-extraction-profile">最长边 {FRAME_PROFILE.maxEdge} · 保持比例 · 不放大 · PNG</p>
    {source && <p className="input-hint">当前源：{source.name || source.id}</p>}
    <p className="input-hint">任务冻结点击时的源文件与时间点。结果保存到素材库后，可明确选用；不会自动绑定首帧或开始生成。</p>
    {!state.historyLoaded && <p className="notice" role="status">请先读取本项目任务，确认没有未完成的同一时间点提取。</p>}
    {state.pending && <div className="notice warning" data-testid="frame-extraction-unknown" role="status"><strong>原请求待确认</strong><p>{state.pending.sourceName || '原任务'} · {state.pending.sourceFrame} / 30 秒（第 {state.pending.sourceFrame} 个编辑时间点）</p><p>原操作：{state.pending.operation}</p><span className="frame-extraction-id">{state.pending.input.requestId}</span><p>完整输入保留在当前窗口中。重开窗口后先读取后端任务历史；未找到回执不代表原请求未受理。</p><div className="frame-extraction-actions"><Button type="button" variant="outline" size="sm" data-testid="frame-request-reconcile" disabled={!visible || state.phase === 'submitting'} onClick={() => run(() => controller.reconcileUnknown())}>核对原请求（只读）</Button><Button type="button" variant="ghost" size="sm" data-testid="frame-request-retry" disabled={!visible || state.phase === 'submitting'} onClick={() => run(() => controller.retryUnknown())}>重发原请求（同一标识）</Button></div></div>}
    {state.message && <p className="notice" role="status" data-testid="frame-extraction-message">{state.message}</p>}
    {state.error && <p className="notice warning" role="alert">{state.error}</p>}
    {state.acknowledged && state.currentTaskPending && <p className="notice">请求已受理，尚未核实任务当前状态。<Button type="button" variant="ghost" size="sm" disabled={!visible} onClick={() => run(() => controller.readTask(state.currentTaskPending))}>读取此任务</Button></p>}
    <div className="frame-extraction-heading"><h4>本项目任务</h4><Button type="button" variant="ghost" size="sm" data-testid="frame-task-refresh" disabled={!visible || state.phase === 'submitting'} onClick={() => run(() => controller.refreshTasks())}>读取最新任务</Button></div><p className="input-hint" role="status" data-testid="frame-task-page">{state.loading ? '正在读取…' : `历史第 ${state.pageTrail.length + 1} 页`}</p>
    {!state.tasks.length && state.historyLoaded && !state.loading && <p className="input-hint">暂时没有抽帧任务。</p>}
    {state.tasks.map(task => {
      const asset = task.result && resultAsset(task);
      return <article className="frame-extraction-task" key={task.id} data-testid="frame-extraction-task" data-task-id={task.id} data-state={task.state}><div className="frame-extraction-heading"><strong>时间点 {task.sourceFrame} · {(task.sourceFrame / task.fps).toFixed(3)} 秒</strong><Badge className={`small-badge ${task.state === 'succeeded' ? 'success' : 'neutral'}`}>{frameTaskLabel(task.state)}</Badge></div><p className="input-hint">30 fps 编辑时基 · rev {task.revision} · {task.started ? '已开始提取' : '尚未开始提取'}</p>
        {['failed', 'interrupted'].includes(task.state) && <p className="notice">此任务不会自动重新提取。需要新 PNG 时，请在源预览重新确认时间点并明确点击提取。</p>}
        {task.state === 'local_result_error' && <p className="notice">已记录本地结果，仍需核验是否完整。建议先恢复已有 PNG；恢复不会再次解码。也可在源预览明确新建提取，旧任务保留。</p>}
        {task.state === 'interrupted' && task.started && <p className="notice">中断后可能留有本地 PNG。可明确检查并恢复已有字节；缺失或校验失败会报错，不会再次解码源视频。</p>}
        {task.errorCode && <p className="input-hint">错误代码：{task.errorCode}</p>}
        {task.result && <div className="frame-extraction-result" data-testid="frame-extraction-result"><strong>{asset?.name || '已保存 PNG · 名称待素材库刷新'}</strong><span>{task.result.width} × {task.result.height} · image/png · {Math.ceil(task.result.byteLength / 1024)} KB</span><span className="frame-extraction-id">素材 {task.result.assetId}</span><span className="frame-extraction-id">SHA-256 {task.result.sha256}</span><span>来源：源视频抽帧（extracted-frame）</span><Button type="button" variant="outline" size="sm" data-testid="frame-result-reveal" disabled={!visible || Boolean(state.pending || state.actionTaskId)} onClick={() => run(() => controller.revealResult(task))}>在素材库查看 PNG</Button></div>}
        <details><summary>源文件与请求记录</summary><span className="frame-extraction-id">源素材 {task.sourceAssetId}</span><span className="frame-extraction-id">源 SHA-256 {task.sourceHash}</span><span className="frame-extraction-id">任务 {task.id}</span><span className="frame-extraction-id">请求 {task.requestId}</span><span className="frame-extraction-id">提取配置 {task.profileId}</span></details>
        <div className="frame-extraction-actions">{frameCanCancel(task) && <Button type="button" variant="outline" size="sm" data-testid="frame-task-cancel" disabled={busy} onClick={() => run(() => controller.cancelQueued(task))}>取消尚未开始的任务</Button>}{frameCanRecover(task) && <Button type="button" variant="outline" size="sm" data-testid="frame-task-recover" disabled={busy} onClick={() => run(() => controller.recoverResult(task))}>{task.state === 'interrupted' ? '检查并恢复已有 PNG' : '恢复同一份本地 PNG'}</Button>}</div>
      </article>;
    })}
    <div className="frame-extraction-actions">{state.pageTrail.length > 0 && <Button type="button" variant="ghost" size="sm" data-testid="frame-task-previous" disabled={!visible || state.loading} onClick={() => run(() => controller.previousTasks())}>较新一页</Button>}{state.nextCursor && <Button type="button" variant="ghost" size="sm" data-testid="frame-task-more" disabled={!visible || state.loading} onClick={() => run(() => controller.loadMoreTasks())}>更早一页</Button>}</div>
    <p className="input-hint">历史每页 20 项，可翻阅全部保留任务；加上当前任务，面板最多显示 50 项。关闭面板不会取消已受理任务。</p>
  </section>;
}

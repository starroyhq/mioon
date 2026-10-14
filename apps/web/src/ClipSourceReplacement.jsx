import React, { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from './WorkspaceControls.jsx';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';
import { clipReplacementBlockedReason, clipReplacementCandidates, clipReplacementReviewIssue, clipSelectedVersionCandidate, createClipReplacementController } from './clip-source-replacement.js';

const durationLabel = asset => asset.mimeType?.startsWith('image/') ? '静态图片' : Number.isFinite(asset.duration) ? `${asset.duration.toFixed(2)} 秒` : '时长未知';

export default function ClipSourceReplacement({ context, getDirty, onReplace, onOpenRequests }) {
  const visible = useWorkspaceVisibility();
  const callbacks = useRef(null);
  callbacks.current = { context: { ...context, visible: visible && context.visible !== false }, getDirty, onReplace };
  const getContext = () => ({ ...callbacks.current.context, dirty: callbacks.current.getDirty() });
  const [state, setState] = useState(null), controllerRef = useRef(null);
  if (!controllerRef.current) controllerRef.current = createClipReplacementController({
    getContext, submit: review => callbacks.current.onReplace(review), onChange: setState,
  });
  const controller = controllerRef.current;
  useLayoutEffect(() => { controller.activate(); controller.setContext(getContext()); return () => controller.dispose(); }, []);
  useLayoutEffect(() => { controller.setContext(getContext()); }, [context, visible]);
  const current = getContext(), blocked = clipReplacementBlockedReason(current);
  const phase = state?.phase || 'idle', review = state?.review;
  const candidates = clipReplacementCandidates(current);
  const suggested = phase === 'idle' && !blocked ? clipSelectedVersionCandidate(current) : null;
  const issue = phase === 'stale' ? state.error : review && phase === 'review' ? clipReplacementReviewIssue(review, current) : '';
  const sending = phase === 'sending';
  const selected = candidates.some(candidate => candidate.key === state?.selectedKey);
  return <section className="clip-source-replacement" aria-labelledby="clip-replacement-title" data-testid="clip-source-replacement" data-phase={phase} aria-busy={sending}>
    <h3 id="clip-replacement-title">替换片段来源</h3>
    <p className="clip-replacement-note">只更新这个片段的来源。名称、位置、时长、入点、画面、音量及淡入/淡出保持原值。</p>
    {blocked && <p id="clip-replacement-blocked" className="clip-replacement-warning" role="status">{blocked}</p>}
    {suggested && <Button size="sm" type="button" data-testid="review-selected-version-replacement" onClick={() => { if (controller.begin() && controller.choose(suggested.key)) controller.review(); }}>核对改用镜头当前选用的 V{suggested.version.number}</Button>}
    {phase === 'idle' && <Button variant="outline" size="sm" type="button" data-testid="begin-clip-replacement" disabled={Boolean(blocked)} aria-describedby={blocked ? 'clip-replacement-blocked' : undefined} onClick={() => controller.begin(state)}>选择替换来源</Button>}
    {phase === 'choosing' && <>
      <Label className="field-label" htmlFor="clip-replacement-candidate">当前项目的兼容素材或版本</Label>
      <WorkbenchSelect id="clip-replacement-candidate" data-testid="clip-replacement-candidate" value={state.selectedKey} disabled={Boolean(blocked) || !candidates.length} aria-describedby="clip-replacement-candidate-help" onChange={event => controller.choose(event.target.value, state)}>
        <option value="" disabled>请选择来源</option>
        {candidates.map(candidate => <option key={candidate.key} value={candidate.key}>{candidate.label} · {durationLabel(candidate.source)}</option>)}
      </WorkbenchSelect>
      <p id="clip-replacement-candidate-help" className="clip-replacement-note">{candidates.length ? '仅列出可保留原范围与淡入/淡出的同类素材，最终由服务端验证。选择“仅素材”不会绑定镜头版本。' : '没有已知兼容的其他来源。需要同类素材覆盖原入点与片段时长；非零淡入/淡出还需已确认音轨。'}</p>
      <div className="clip-replacement-actions"><Button size="sm" type="button" data-testid="review-clip-replacement" disabled={Boolean(blocked) || !selected} onClick={() => controller.review(state)}>核对替换</Button><Button variant="ghost" size="sm" type="button" data-testid="cancel-clip-replacement" onClick={() => controller.cancel(state)}>取消</Button></div>
    </>}
    {review && <div className="clip-replacement-review" data-testid="clip-replacement-review">
      <h4>本次核对 · 时间线修订 {review.expectedRevision}</h4>
      <dl>
        <div><dt>目标片段</dt><dd>{review.clip.name || review.clip.id}</dd></div>
        <div><dt>当前来源</dt><dd>{review.previous.name || review.previous.id}<small>{durationLabel(review.previous)}</small></dd></div>
        <div><dt>替换为</dt><dd>{review.candidate.source.name || review.candidate.assetId}<small>{durationLabel(review.candidate.source)}</small><small>{review.candidate.version ? `${review.candidate.version.shotTitle} · V${review.candidate.version.number}` : '仅素材，不绑定镜头版本'}</small></dd></div>
        <div><dt>保留素材入点</dt><dd>{review.clip.sourceInFrame} 帧</dd></div>
        <div><dt>保留片段时长</dt><dd>{review.clip.durationFrames} 帧 · {(review.clip.durationFrames / 30).toFixed(2)} 秒</dd></div>
        <div><dt>保留时间线位置</dt><dd>{review.clip.startFrame} → {review.clip.startFrame + review.clip.durationFrames} 帧</dd></div>
      </dl>
      {review.clip.colour && <p className="clip-replacement-warning" data-testid="clip-replacement-colour-warning">LUT、启用状态与强度会保留；新来源的色彩解释将清除。替换后必须重新核对并确认 Rec.709 SDR 与范围，才能渲染。</p>}
      <p className="clip-replacement-note">不会自动裁短或清除淡入/淡出。不修改镜头选用版本、其他片段或已有导出。</p>
    </div>}
    {issue && <p className="clip-replacement-warning" id="clip-replacement-review-issue" role="alert">{issue}</p>}
    {phase === 'review' && <div className="clip-replacement-actions"><Button size="sm" type="button" data-testid="approve-clip-replacement" disabled={Boolean(issue || blocked)} aria-describedby={issue ? 'clip-replacement-review-issue' : blocked ? 'clip-replacement-blocked' : undefined} onClick={() => controller.approve(review)}>确认替换此片段来源</Button><Button variant="ghost" size="sm" type="button" data-testid="cancel-clip-replacement" onClick={() => controller.cancel(state)}>取消</Button></div>}
    {sending && <p className="clip-replacement-note" role="status">正在提交本次核对的替换请求…</p>}
    {phase === 'applied' && <p className="clip-replacement-success" role="status">本次来源替换已确认。后续编辑或撤销可能改变当前片段，请以上方来源为准。</p>}
    {['error', 'unknown'].includes(phase) && <p className="clip-replacement-warning" role="alert">{state.error}</p>}
    {phase === 'unknown' && <><p className="clip-replacement-note">原请求恢复记录只保留在当前浏览器会话中。关闭窗口或重建应用会话可能丢失记录，无法保证自动找回。</p><Button variant="outline" size="sm" type="button" data-testid="recover-clip-replacement" onClick={onOpenRequests}>在任务面板恢复原请求</Button></>}
    {['stale', 'error'].includes(phase) && <div className="clip-replacement-actions"><Button variant="outline" size="sm" type="button" data-testid="restart-clip-replacement" disabled={Boolean(blocked)} onClick={() => controller.begin(state)}>重新选择并核对</Button><Button variant="ghost" size="sm" type="button" onClick={() => controller.cancel(state)}>取消</Button></div>}
    {(phase === 'applied' || (phase === 'unknown' && !current.pending && !current.busy)) && <Button variant="ghost" size="sm" type="button" data-testid="close-clip-replacement" onClick={() => controller.cancel(state)}>结束本次核对</Button>}
  </section>;
}

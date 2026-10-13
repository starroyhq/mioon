import React from 'react';
import type { AgentTimelineGainProposal, AgentTimelineGainReviewTarget } from '../../../packages/contracts/src/agent-timeline-gain.ts';
import type { AgentTimelineGainPolicy } from './agent-timeline-gain-context.ts';
import { agentTimelineGainText } from './agent-timeline-gain-context.ts';

export const AGENT_GAIN_SEND_CONTEXT = '发送本条输入、范围内已完成的纯聊天文字，以及上方明确展示的片段名称与已保存音量、轨道名称与类型及静音状态、已知含音频与 0–2 音量范围。不含媒体、路径、ID、源指纹、其他片段、波形或响度测量。最多 2 次模型请求、1 次仅 gain 的提议工具调用、8 KiB 结果；续接关闭工具，提议不会自动应用。';
export const AGENT_GAIN_SEND_CONSENT = '我授权按以上项目、片段、保存版本、所展示的音量与轨道状态、协议、地址、模型和限额发送本条输入与纯聊天上下文，并保存记录；最多 2 次模型请求可能计费。这里只允许提出音量差异，应用仍需我另行明确批准。';
export function AgentTimelineGainWarnings({ muted, gain }: { muted: boolean; gain: number }) {
  return <>
    {muted && <p role="status" data-testid="agent-gain-track-muted">此轨道已静音。音量会保存，但轨道保持静音时仍听不到；不会自动取消轨道静音。</p>}
    {gain > 1 && <p role="status" data-testid="agent-gain-clipping-risk">音量倍率高于 1 可能增加削波失真风险；这里没有自动限幅或响度测量。</p>}
    <p data-testid="agent-gain-source-preview">混音、渲染预览及导出使用此音量。原始源素材预览不会改变；请自行使用普通渲染预览或导出控件核对，不会自动渲染或播放。</p>
  </>;
}
export function AgentTimelineGainDiff({ proposal, visible = true }: { proposal: AgentTimelineGainProposal; visible?: boolean }) {
  return <div className="agent-edit-diff agent-timeline-diff" data-testid="agent-timeline-gain-diff" tabIndex={visible ? 0 : -1} aria-label="不可修改的已保存片段音量差异">
    <section><h4>片段音量 · 线性振幅倍率</h4>
      <div className="agent-edit-diff-side"><span>修改前</span><p data-testid="agent-gain-before">{agentTimelineGainText(proposal.diff.before.gain)}</p></div>
      <div className="agent-edit-diff-arrow" aria-hidden="true">↓</div>
      <div className="agent-edit-diff-side is-after"><span>提议修改后</span><p data-testid="agent-gain-after">{agentTimelineGainText(proposal.diff.after.gain)}</p></div>
      <p>百分比仅供阅读，实际保存上方完整倍率。0 仅让此片段静音，不改变轨道静音状态。</p>
      <p data-testid="agent-gain-preserved">仅改变这个已保存片段的 gain。时间、时长、源素材、画面位置、其他片段、字幕、淡入淡出和轨道静音保持不变。</p>
      <AgentTimelineGainWarnings muted={proposal.target.trackMuted} gain={proposal.diff.after.gain} />
    </section>
  </div>;
}
export function AgentTimelineGainSelection({ target, policy, blockedReason = '', visible = true }: { target: AgentTimelineGainReviewTarget | null; policy?: AgentTimelineGainPolicy; blockedReason?: string; visible?: boolean }) {
  return <section className="agent-edit-selected agent-timeline-selected" data-testid="agent-gain-selected-target" aria-label="本次发送的已保存片段音量范围">
    <strong>只调整一个已保存有声片段的音量</strong>
    {target ? <>
      <p data-testid="agent-gain-target-summary">{target.clipName} · {target.trackName}（{target.trackKind === 'audio' ? '音频轨道' : '视频轨道'}）· 基准版本 {target.expectedRevision}</p>
      <p data-testid="agent-gain-selected-value">已保存音量：{agentTimelineGainText(target.gain)} · 轨道{target.trackMuted ? '已静音' : '未静音'} · 已知含音频 · 可提议倍率 0–2</p>
      <p>以上片段与轨道名称、类型、音量及静音状态是发给模型的全部项目资料。模型没有听过媒体，不能判断实际响度或是否清晰。</p>
      <AgentTimelineGainWarnings muted={target.trackMuted} gain={target.gain} />
      {policy && <p data-testid="agent-gain-policy">提议工具 v{policy.schemaVersion} · 目录 {policy.catalogHash.slice(0, 12)} · 最多 2 次模型请求 / 1 次提议 / 8 KiB 结果</p>}
      <details className="agent-edit-identity"><summary className="agent-chat-details-trigger" tabIndex={visible ? 0 : -1}>本地核对身份（不发送给模型）</summary><p>项目 {target.projectId}</p><p>时间线 {target.timelineId} · 片段 {target.clipId} · 轨道 {target.trackId}</p></details>
    </> : <p role="status">请选中一个已保存音频片段或已知含音频的视频片段。图片、无声视频和音频元数据未知的素材不能使用此模式。</p>}
    {blockedReason && <p role="status" data-testid="agent-gain-context-blocked">{blockedReason}</p>}
  </section>;
}
export function AgentTimelineGainActivity({ target, sourceCount }: { target: AgentTimelineGainReviewTarget; sourceCount: number }) {
  return <p className="agent-run-provenance" data-testid="agent-run-provenance">片段音量提议 · {target.clipName} · {target.trackName} · 保存版本 {target.expectedRevision} · 已保存音量 {agentTimelineGainText(target.gain)} · 轨道{target.trackMuted ? '已静音' : '未静音'}。{sourceCount ? `另包含 ${sourceCount} 轮已完成纯聊天文字。` : ''}不含媒体、源身份、其他片段或未保存编辑；只提出 gain 差异，不代表已应用。本轮文字不加入其他范围的项目上下文或纯聊天上下文，应用状态请查看独立审阅区。</p>;
}

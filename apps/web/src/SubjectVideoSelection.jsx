import React, { useEffect } from 'react';
import { Switch } from '@mioon/ui/components/switch';
import { Button } from '@mioon/ui/components/button';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from './WorkspaceControls.jsx';
import { SubjectPager } from './SubjectLibrary.jsx';
import { useSubjectInteraction } from './use-subjects.js';
import { subjectKindLabel } from './subject-state.js';
import SubjectVideoSummary from './SubjectVideoSummary.jsx';
import { subjectVideoProfileIssue } from './generation-settings.js';
import { subjectVideoChoice, subjectVideoConflictIssue, SUBJECT_VIDEO_KINDS, ARK_SUBJECT_WARNING, MOCK_SUBJECT_WARNING } from './subject-video.js';
import './subject-video-controls.css';

export default function SubjectVideoSelection({ shot, draft, subjects, assets = [], provider, model, options = {}, disabled, boundReference, onChange }) {
  const state = subjects?.state, controller = subjects?.controller, scope = state?.scope;
  const active = options.inputMode === 'subject';
  const reference = options.subjectReference;
  const subjectId = options.subjectId || reference?.subjectVersion?.subjectId || '';
  const subject = state?.subjects[subjectId];
  const versions = state?.versions[subjectId];
  const selectionKey = JSON.stringify([shot?.id, options, provider?.id, model, disabled, boundReference, shot?.revision, draft]);
  const interaction = useSubjectInteraction(scope, controller, selectionKey);
  useEffect(() => { if (interaction.visible && active && subjectId && scope && !versions) void controller.readVersions(subjectId, scope); }, [interaction.visible, active, subjectId, scope, controller, Boolean(versions)]);
  const conflict = subjectVideoConflictIssue(draft, { savedShot: shot, boundReference });
  const profileIssue = subjectVideoProfileIssue(provider, model);
  const libraryIssue = !state ? '主体库尚未加载，请等待当前项目读取完成。' : state.uncertain ? '有主体修改待确认，请先在任务中心核对。' : state.saving ? '主体修改正在保存，请稍候。' : ''; 
  const locked = disabled || !interaction.visible || !state || Boolean(state?.saving || state?.uncertain);
  const chooseLocked = locked || Boolean(conflict || profileIssue);
  const choices = [...(state?.list.items || []), ...(subject && !state?.list.items.some(item => item.id === subject.id) ? [subject] : [])];
  const knownVersions = subject ? [...new Map([subject.headVersion, ...Object.values(versions?.known || {})].map(version => [version.id, version])).values()].sort((a, b) => b.number - a.number) : [];
  const pinned = reference?.subjectVersion;
  if (pinned && !knownVersions.some(version => version.id === pinned.id)) knownVersions.push(pinned);
  const change = patch => interaction.admit(() => { if (!locked) onChange(patch); });
  return <section className="subject-video-selection" data-testid="subject-video-selection" aria-label="本次主体图片生成视频">
    <Label className="subject-video-toggle" htmlFor="subject-video-enabled"><Switch id="subject-video-enabled" data-testid="subject-video-enabled" checked={active} disabled={locked || !active && Boolean(conflict || profileIssue)} onCheckedChange={checked => { if (active || !chooseLocked) change({ inputMode: checked ? 'subject' : 'text' }); }} /><span>本次使用主体图片生成视频</span></Label>
    <p className="subject-helper">这次选择仅保留在当前页面会话中，不保存为镜头参数，也不保证跨重启保留。策划关联不会自动作为生成输入；提示词保持原样。</p>
    {(conflict || profileIssue || libraryIssue) && <p className="subject-warning" role="status" data-testid="subject-video-unavailable">{conflict || profileIssue || libraryIssue}</p>}
    {provider?.id === 'ark' && <p className="subject-warning" data-testid="subject-video-face-warning">{ARK_SUBJECT_WARNING}</p>}
    {provider?.mock && <p className="subject-helper" data-testid="subject-video-mock-warning">{MOCK_SUBJECT_WARNING}</p>}
    {active && <div className="subject-form">
      <Label htmlFor="subject-video-subject">选择主体（素材库当前页）</Label>
      <WorkbenchSelect id="subject-video-subject" data-testid="subject-video-subject" value={subjectId} disabled={chooseLocked || state?.list.phase !== 'ready'} onChange={event => change({ subjectId: event.target.value, subjectReference: null })}><option value="">明确选择角色、产品或场景</option>{choices.map(item => <option key={item.id} value={item.id} disabled={!SUBJECT_VIDEO_KINDS.includes(item.kind)}>{item.name} · {subjectKindLabel(item.kind)}{item.kind === 'look' ? ' · 仅供策划' : ''}</option>)}</WorkbenchSelect>
      <SubjectPager entry={state?.list} disabled={locked || state?.list.phase !== 'ready'} onPage={direction => interaction.admit(() => controller.subjectPage(direction, scope))} />
      {state?.list.phase === 'error' && <p className="subject-warning" role="alert">{state.list.error}</p>}
      <Button variant="ghost" size="sm" disabled={locked || state?.list.phase === 'loading'} onClick={() => interaction.admit(() => controller.read())}>刷新主体库</Button>
      {subjectId && <><Label htmlFor="subject-video-version">明确固定图片版本</Label><WorkbenchSelect id="subject-video-version" data-testid="subject-video-version" value={reference?.subjectVersionId || ''} disabled={chooseLocked || !subject} onChange={event => { const chosen = knownVersions.find(version => version.id === event.target.value); change({ subjectReference: chosen ? subjectVideoChoice(subject, chosen) : null }); }}><option value="">请选择固定版本，不会自动选用当前版本</option>{knownVersions.map(version => <option key={version.id} value={version.id}>V{version.number}{version.id === subject?.headVersionId ? ' · 主体库当前版本' : ' · 历史版本'}</option>)}</WorkbenchSelect>
        {versions?.phase === 'error' && <p className="subject-warning" role="alert">{versions.error}</p>}
        <SubjectPager label="主体版本" entry={versions} disabled={locked || versions?.phase !== 'ready'} onPage={direction => interaction.admit(() => controller.versionPage(subjectId, direction, scope))} />
        <Button variant="ghost" size="sm" disabled={locked || versions?.phase === 'loading'} onClick={() => interaction.admit(() => controller.readVersions(subjectId, scope))}>重新读取版本</Button>
      </>}
      <SubjectVideoSummary reference={reference} assets={assets} latestSubject={subject} />
      <p className="subject-helper">仅发送一个固定主体版本。PNG / JPEG 可使用方形图片，主体图片比例与输出画幅独立；具体大小与像素限制见模型输入限制。风格仅供策划，不参与生成。</p>
    </div>}
  </section>;
}

import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@mioon/ui/components/collapsible';
import Icon from './icons.jsx';
import { generationProfileSelection } from './generation-settings.js';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';
import './generation-input-summary.css';

const roles = [
  ['first_frame', '首帧参考图'], ['last_frame', '尾帧参考图'],
  ['subject_reference', '主体参考'], ['style_reference', '风格参考'], ['motion_reference', '动作参考'],
];
const countLabel = rule => `${rule.min === rule.max ? rule.max : `${rule.min}–${rule.max}`} ${rule.implemented ? '张' : '个'}`;
const bytesLabel = value => `${Number.isInteger(value / 1048576) ? `${value / 1048576} MiB · ` : ''}${value.toLocaleString('en-US')} bytes`;
const sourceUrl = value => typeof value === 'string' && /^https:\/\//.test(value) ? value : null;
// provider.list is polled. Fresh objects with the same displayed profile are
// the same disclosure scope, including when JSON property order changes.
const semanticKey = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const regionMeaning = profile => ({
  runway: '固定 Runway API 端点标签，不代表数据驻留保证',
  ark: '固定中国大陆方舟 API 端点',
  veo: 'Gemini Developer API，不是 Vertex AI；不代表数据驻留保证',
  minimax: '由服务器明确配置，账号和密钥须与 API 区域匹配',
  vidu: '由服务器明确配置，账号和密钥须与 API 区域匹配',
  mock: '本地模拟，不调用外部服务',
}[profile.providerId] || profile.regionMeaning || 'API 配置标签，不代表数据驻留保证');

function RoleLimits({ role, label, rule }) {
  const dimensions = rule?.dimensions;
  return <li data-testid={`generation-role-${role}`}>
    <div className="generation-input-role-heading"><strong>{label}</strong><span>{rule ? countLabel(rule) : '数量未确认'}</span></div>
    {!rule ? <p>尚未取得此模型的角色限制，请刷新服务商信息后核对。</p> : !rule.implemented ? <p>{!rule.reason || rule.reason === 'No mapping in the current Mioon adapter.' ? 'Mioon 当前适配器未接入此角色，尚无对应的生成输入映射。' : rule.reason}</p> : <>
      <p>格式：{rule.mimeTypes?.length ? rule.mimeTypes.map(type => type.replace('image/', '').toUpperCase()).join(' / ') : '未声明'}</p>
      <p>单张文件：{Number.isSafeInteger(rule.maxBytes) ? `最多 ${bytesLabel(rule.maxBytes)}` : '大小上限未声明'}</p>
      {Number.isSafeInteger(rule.maxDataUriBytes) && <p>编码后 data URI：最多 {bytesLabel(rule.maxDataUriBytes)}</p>}
      <p>尺寸：{[dimensions?.min && `宽高均至少 ${dimensions.min}px`, dimensions?.max && `宽高均不超过 ${dimensions.max}px`, dimensions?.matchAspectRatio && '须与镜头画幅比例一致', dimensions?.matchAspectRatio === false && '图片比例与输出画幅独立，可用方形图', dimensions?.minAspectRatio && `宽高比至少 ${dimensions.minAspectRatio}`, dimensions?.maxAspectRatio && `宽高比不超过 ${dimensions.maxAspectRatio}`].filter(Boolean).join('；') || '此适配配置未声明像素范围'}</p>
    </>}
  </li>;
}

// Read-only rendering of the selected server profile. Subject-library bindings
// never enter this component or become generation references implicitly.
export function GenerationInputDetails({ selection }) {
  const { profile, evaluation, region, evaluatedAsOf } = selection;
  const lifecycle = profile?.lifecycle;
  const source = sourceUrl(lifecycle?.source);
  return <div className="generation-input-details-body">
    <p>Mioon 当前适配器的已接入范围；不代表服务商全部能力。</p>
    {profile && <p>总参考图：{profile.inputs.minReferences}–{profile.inputs.maxReferences} 张。{profile.inputs.roles.last_frame?.implemented ? '支持单张首帧，或一张首帧加一张尾帧；尾帧不能单独提交。' : '只接入单张首帧，不组合多个参考角色。'}{profile.inputs.roles.subject_reference?.implemented && '另支持单张固定主体图片；不能与首帧、尾帧或连线组合。'}</p>}
    <ul className="generation-input-roles" aria-label="各参考角色的数量与限制">{roles.map(([role, label]) => <RoleLimits key={role} role={role} label={label} rule={profile?.inputs?.roles?.[role]} />)}</ul>
    <p className="generation-input-planning" data-testid="generation-subject-planning">主体与风格的策划关联不会自动作为生成输入。角色、产品或场景图片须在镜头属性中明确选择本次固定版本；此入口仅接入 Mock 与 Ark 的 doubao-seedance-2-5-260628。风格仍仅供策划。首帧仍由现有参考图选择或首帧连接提供。尾帧在镜头属性中单独保存；首尾帧组合仅接入 Ark 与 Mock，同一素材不可同时作为首尾帧（当前应用限制）。</p>
    {profile && <dl className="generation-input-provenance">
      <div><dt>适配配置</dt><dd>{profile.profileId} · {profile.profileVersion}</dd></div>
      <div><dt>配置核查</dt><dd>{profile.reviewedOn || '未提供核查日期'}</dd></div>
      <div><dt>服务端评估</dt><dd>{evaluatedAsOf || '尚未提供'}</dd></div>
      <div><dt>API 区域</dt><dd>{region} · {regionMeaning(profile)}</dd></div>
    </dl>}
    {lifecycle && <div className="generation-input-lifecycle-detail">
      <p>生命周期核查：{lifecycle.checkedOn}；最早关闭日期：{lifecycle.earliestShutdownDate}。到期需重新核验该精确模型，不会自动替换模型。</p>
      {source && <a href={source} target="_blank" rel="noreferrer">查看服务商生命周期说明</a>}
      {evaluation?.warnings?.filter(warning => warning.code !== 'MODEL_LIFECYCLE_WARNING').map(warning => <p key={warning.code}>{warning.message}</p>)}
    </div>}
  </div>;
}

export default function GenerationInputSummary({ provider, model }) {
  const selection = generationProfileSelection(provider, model);
  const { profile, state, message, region, evaluation, evaluatedAsOf } = selection;
  const visible = useWorkspaceVisibility();
  const selectionKey = semanticKey([provider?.id, model, provider?.inputProfileVersion, selection]);
  const scope = useMemo(() => ({ selectionKey, visible }), [selectionKey, visible]);
  const current = useRef(scope);
  const [disclosure, setDisclosure] = useState({ scope: null, open: false });
  useLayoutEffect(() => {
    current.current = scope;
    return () => { current.current = null; };
  }, [scope]);
  const open = visible && disclosure.scope === scope && disclosure.open;
  const lifecycleIssue = evaluation?.issues?.[0];
  const lifecycleMessage = lifecycleIssue?.code === 'MODEL_LIFECYCLE_REVALIDATION_REQUIRED' ? `服务端评估（${evaluatedAsOf}）：此 Veo 模型已到生命周期复核日期，已阻止新提交。` : lifecycleIssue?.message;
  const firstFrame = profile?.inputs?.roles?.first_frame;
  const lastFrame = profile?.inputs?.roles?.last_frame;
  return <section className="generation-input-summary" aria-label="Mioon 模型输入限制" data-testid="generation-input-summary" data-profile-state={state}>
    <p className="generation-input-model" data-testid="generation-input-model">{model || '尚未选择模型'}</p>
    <p className="generation-input-route" data-testid="generation-input-route">API：{profile?.apiFamily || '尚未确认'} · 区域：{region || '尚未确认'}</p>
    <p className="generation-input-brief" data-testid="generation-input-brief">{profile ? `Mioon 首帧 ${firstFrame ? countLabel(firstFrame) : '数量未确认'} · 尾帧 ${lastFrame?.implemented ? countLabel(lastFrame) : '未接入'} · 其他角色见限制` : message}</p>
    {lifecycleIssue ? <p className="generation-input-warning" role="status" data-testid="generation-input-lifecycle-blocked">{lifecycleMessage} 不会自动替换模型。</p> : profile?.lifecycle && <p className="generation-input-warning" role="status" data-testid="generation-input-lifecycle-warning">Veo 生命周期提示：最早 {profile.lifecycle.earliestShutdownDate} 关闭；核查于 {profile.lifecycle.checkedOn}，到期需重新核验。</p>}
    <Collapsible open={open} onOpenChange={next => {
      if (visible && current.current === scope) setDisclosure({ scope, open: Boolean(next) });
    }}>
      <CollapsibleTrigger render={<Button variant="ghost" size="sm" />} className="generation-input-toggle" data-testid="generation-input-toggle" disabled={!visible}><span>查看输入限制</span><Icon name="down" size={13} /></CollapsibleTrigger>
      <CollapsibleContent className="generation-input-details" data-testid="generation-input-details"><GenerationInputDetails selection={selection} /></CollapsibleContent>
    </Collapsible>
  </section>;
}

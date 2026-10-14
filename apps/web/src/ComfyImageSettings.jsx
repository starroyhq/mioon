import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@mioon/ui/components/badge';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from './WorkspaceControls.jsx';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';
import { closeSettingsAfterPermission, createSettingsNavigationReporter } from './settings-navigation-state.ts';
import { createComfyImageSettingsSession, initialComfyImageSettingsState, comfyImageSettingsEditable, comfyImageSettingsCanSave, comfyImageSettingsDirty, comfyImageDestination, comfyImageCheckLabel } from './comfy-image-settings.js';
import Icon from './icons.jsx';
import './image-settings.css';
import './comfy-image-settings.css';

const noop = () => {};
/** Independent local profile. Viewing and saving never check or start the runtime. */
export default function ComfyImageSettings({ active = false, contextKey, client, onSelectSlot = noop, onRequestSelectSlot, onClose = noop, onSnapshot = noop, onDirtyChange = noop, beforeClose, closeLabel, onNavigationStateChange }) {
  const [state, setState] = useState(initialComfyImageSettingsState);
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const ancestorVisible = useWorkspaceVisibility(), visible = ancestorVisible && active && pageVisible;
  const session = useRef(null), lifetime = useRef(null), callbacks = useRef({ onSnapshot, onDirtyChange }), navigation = useRef(null);
  const interaction = useMemo(() => ({ visible, contextKey }), [visible, contextKey]), interactionRef = useRef(interaction);
  if (!navigation.current) navigation.current = createSettingsNavigationReporter();
  const navigationInput = next => ({ dirty: comfyImageSettingsDirty(next), phase: next.phase, recovery: next.recovery });
  const reportNavigation = next => navigation.current.update(navigationInput(next));
  useLayoutEffect(() => {
    const owner = navigation.current.connect(onNavigationStateChange, navigationInput(session.current?.getState() || state));
    return () => navigation.current.disconnect(owner);
  }, [onNavigationStateChange]);
  useLayoutEffect(() => { callbacks.current = { onSnapshot, onDirtyChange }; });
  useLayoutEffect(() => {
    const owner = { closed: false }; lifetime.current = owner;
    const current = createComfyImageSettingsSession({ client, onChange: next => { if (!owner.closed && lifetime.current === owner) { reportNavigation(next); setState(next); } }, onSnapshot: next => { if (!owner.closed && lifetime.current === owner) callbacks.current.onSnapshot(next); } });
    session.current = current; void current.load();
    return () => { owner.closed = true; current.dispose(); if (session.current === current) session.current = null; callbacks.current.onDirtyChange(false); };
  }, [client]);
  useLayoutEffect(() => { interactionRef.current = interaction; session.current?.setVisible(visible); reportNavigation(session.current?.getState() || state); }, [interaction]);
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return;
    const changed = () => { const shown = document.visibilityState !== 'hidden'; if (!shown) { interactionRef.current = null; session.current?.setVisible(false); reportNavigation(session.current?.getState() || state); } setPageVisible(shown); };
    document.addEventListener('visibilitychange', changed); return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useLayoutEffect(() => { callbacks.current.onDirtyChange(comfyImageSettingsDirty(state)); }, [state.snapshot, state.draft]);
  const owner = lifetime.current;
  const usable = () => Boolean(visible && interactionRef.current === interaction && owner && !owner.closed && lifetime.current === owner && (typeof document === 'undefined' || document.visibilityState !== 'hidden'));
  const leave = (action, permission) => {
    if (!usable()) return;
    const captured = interactionRef.current, version = navigation.current.getState().version;
    return closeSettingsAfterPermission(permission, () => usable() && interactionRef.current === captured && navigation.current.getState().version === version, () => { interactionRef.current = null; session.current?.setVisible(false); action(); });
  };
  const { snapshot, draft, check } = state, editable = visible && comfyImageSettingsEditable(state);
  const checkedModels = check?.checkpoints || [], hasSavedModel = draft?.model && !checkedModels.includes(draft.model);
  return <section className="image-settings-page comfy-image-settings-page" data-testid="comfy-image-settings-page" data-phase={state.phase} hidden={!visible} inert={!visible} aria-label="本地 ComfyUI 图像设置">
    <header className="image-generation-heading"><div><span className="image-generation-eyebrow">IMAGE · LOCAL CONNECTION</span><h2>图像设置</h2><p>本地 ComfyUI · 逐次准备并审批</p></div><Button type="button" variant="ghost" className="button quiet" data-testid="comfy-image-settings-back" aria-label={closeLabel} disabled={!visible} onClick={() => leave(onClose, beforeClose)}><Icon name="left" size={14} />{closeLabel ?? '返回'}</Button></header>
    <div className="image-settings-slots" role="group" aria-label="图像连接槽位">{[['official', 'OpenAI 官方'], ['custom', '自定义兼容连接'], ['comfy', '本地 ComfyUI']].map(([slot, label]) => <Button key={slot} type="button" variant="ghost" className="button" data-testid={`comfy-image-settings-slot-${slot}`} aria-pressed={slot === 'comfy'} disabled={!visible} onClick={() => { if (slot !== 'comfy') { if (onRequestSelectSlot) { if (usable()) onRequestSelectSlot(slot); } else leave(() => onSelectSlot(slot)); } }}>{label}</Button>)}</div>
    <form className="image-settings-form" noValidate autoComplete="off" onSubmit={event => { event.preventDefault(); if (usable()) void session.current?.save(); }}>
      <p className="image-settings-help">仅连接你已安装并启动的 ComfyUI v0.39.0。不会安装或启动运行时，不会下载模型或自定义节点。打开设置和保存均不探测服务。</p>
      {!snapshot ? <div role="status"><p>{state.phase === 'loading' ? '正在读取本地连接设置…' : state.message}</p>{state.phase !== 'loading' && <Button type="button" variant="ghost" className="button" data-testid="comfy-image-settings-load" disabled={!visible} onClick={() => { if (usable()) void session.current?.load(); }}>重新读取</Button>}</div> : <>
        <Label className="image-settings-enable" htmlFor="comfy-image-settings-enable"><Input id="comfy-image-settings-enable" data-testid="comfy-image-settings-enable" type="checkbox" checked={draft.enabled} disabled={!editable} onChange={event => { if (usable()) session.current?.setEnabled(event.target.checked); }} /><span><strong>启用本地 ComfyUI 图像</strong><small>启用不批准任何生成；审批后可能使用 GPU、内存与磁盘</small></span></Label>
        <Label htmlFor="comfy-image-settings-base-url">运行中的本机地址</Label>
        <Input id="comfy-image-settings-base-url" data-testid="comfy-image-settings-base-url" type="text" value={draft.baseUrl} maxLength={64} disabled={!editable} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="http://127.0.0.1:8188" onChange={event => { if (usable()) session.current?.setBaseUrl(event.target.value); }} />
        <p className="image-settings-help">仅允许明确填写 HTTP 127.0.0.1 或 [::1] 与端口。不接受 localhost、局域网、路径、凭据或查询参数，也不能使用 Mioon 自己的端口。不支持认证。</p>
        <Button type="button" variant="ghost" className="button" data-testid="comfy-image-settings-check" disabled={!editable || !draft.baseUrl || Boolean(state.recovery)} onClick={() => { if (usable()) void session.current?.checkConnection(); }}>{state.phase === 'checking' ? '正在检查连接…' : '检查连接与已安装模型'}</Button>
        <p className="image-settings-help">仅点击检查才向上方地址发起有界只读查询，读取版本、内置节点和 checkpoint 名单，不发送图像描述或生成任务。</p>
        <p className="image-generation-notice" role="status" data-testid="comfy-image-settings-readiness">{comfyImageCheckLabel(check)}</p>
        <Label htmlFor="comfy-image-settings-model">已安装 checkpoint</Label>
        <WorkbenchSelect id="comfy-image-settings-model" data-testid="comfy-image-settings-model" value={draft.model} disabled={!editable || !check || !checkedModels.length} onChange={event => { if (usable()) session.current?.selectModel(event.target.value); }}><option value="">请先检查连接，再选择模型</option>{hasSavedModel && <option value={draft.model} disabled>{draft.model}（当前未核验）</option>}{checkedModels.map(model => <option key={model} value={model}>{model}</option>)}</WorkbenchSelect>
        <p className="image-settings-help">服务报告的模型与节点名称不证明兼容性、可信代码或离线运行。最终发送前仍会核验配置与本次连接检查记录；运行时之后可能变化，检查不保证可用。真实生成尚未验证。</p>
        <div className="image-settings-fixed" data-testid="comfy-image-settings-fixed"><strong>ComfyUI v0.39.0 · 固定 7 节点文生图</strong><span>{draft.profileId}</span><span>{comfyImageDestination(draft) || '填写有效地址后显示完整发送目标'}</span><span>512 × 512 · PNG · 1 张 · 20 steps · CFG 8 · euler / normal</span><span>负向描述固定为空；种子在准备请求时由后端生成</span><Badge className="small-badge neutral">外部运行时未沙箱化</Badge></div>
        <div className="image-settings-current"><span>当前配置：{snapshot.configuration.enabled ? '已启用' : '未启用'} · r{snapshot.revision}</span><span>仅保存连接与模型，不保存密钥</span></div>
        {state.recovery && <div className="image-generation-notice" data-testid="comfy-image-settings-recovery"><p>保存结果待核对，草稿保留，不会自动重试或检查服务。</p><div className="image-generation-actions"><Button type="button" variant="ghost" className="button" disabled={!editable} onClick={() => { if (usable()) void session.current?.reload(); }}>重新读取</Button><Button type="button" variant="ghost" className="button" disabled={!editable || state.phase === 'blocked'} onClick={() => { if (usable()) session.current?.useLatest(); }}>使用已保存设置</Button><Button type="button" variant="ghost" className="button" disabled={!editable || state.phase !== 'review'} onClick={() => { if (usable()) session.current?.acknowledge(); }}>核对后保留草稿</Button></div></div>}
        <Button type="submit" variant="ghost" className="button primary" data-testid="comfy-image-settings-save" disabled={!visible || !comfyImageSettingsCanSave(state)}>{state.phase === 'saving' ? '正在保存…' : '保存本地连接设置'}</Button>
      </>}
      {snapshot && state.message && <p className="image-generation-notice" role="status" data-testid="comfy-image-settings-message">{state.message}</p>}
    </form>
  </section>;
}

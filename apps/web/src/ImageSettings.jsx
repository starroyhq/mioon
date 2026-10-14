import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@mioon/ui/components/badge';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from './WorkspaceControls.jsx';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';
import { closeSettingsAfterPermission, createSettingsNavigationReporter } from './settings-navigation-state.ts';
import { IMAGE_SETTINGS_LIMITS, CUSTOM_IMAGE_ENDPOINT_LIMIT, imageSettingsBindingChanged, imageSettingsDestination, createImageSettingsSession, imageSettingsCanSave, imageSettingsDirty, imageSettingsEditable, initialImageSettingsState } from './image-settings.js';
import Icon from './icons.jsx';
import './image-settings.css';

const noop = () => {};
const storageLabel = value => ({ none: '未保存', session: '仅本次后端运行', persistent: '系统加密保存' }[value] || '请选择保存方式');
export const imageStorageReason = storage => ({ WEB_SESSION_ONLY: '当前服务器不提供系统安全存储。仅本次后端运行可用，后端退出后密钥清除。', LINUX_BASIC_TEXT: '系统仅提供 basic_text，不支持安全持久保存。可明确选择仅本次后端运行。', OS_SECRET_STORE_UNAVAILABLE: '系统安全存储不可用。可明确选择仅本次后端运行。' }[storage?.reasonCode] || '系统安全存储可用。持久保存需要你的明确选择；不会退回明文文件。');

/** Mounted across dock navigation. Only the write-only input ever holds a key. */
export default function ImageSettings({ active = false, contextKey, client, slot = 'official', onSelectSlot = noop, onRequestSelectSlot, onClose = noop, onSnapshot = noop, onDirtyChange = noop, beforeClose, closeLabel, onNavigationStateChange }) {
  if (!['official', 'custom'].includes(slot)) throw new TypeError('Unknown image settings slot');
  const custom = slot === 'custom', prefix = custom ? 'custom-image-settings' : 'image-settings';
  const [state, setState] = useState(initialImageSettingsState), [hasKey, setHasKey] = useState(false), [keyNotice, setKeyNotice] = useState('');
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const ancestorVisible = useWorkspaceVisibility(), visible = ancestorVisible && active && pageVisible;
  const keyInput = useRef(null), session = useRef(null), lifetime = useRef(null), callbacks = useRef({ onSnapshot, onDirtyChange }), navigation = useRef(null);
  const interaction = useMemo(() => ({ visible, contextKey }), [visible, contextKey]), interactionRef = useRef(interaction);
  if (!navigation.current) navigation.current = createSettingsNavigationReporter();
  const navigationInput = next => ({ dirty: imageSettingsDirty(next) || Boolean(keyInput.current?.value), phase: next.phase, recovery: next.recovery });
  const reportNavigation = next => navigation.current.update(navigationInput(next));
  useLayoutEffect(() => {
    const owner = navigation.current.connect(onNavigationStateChange, navigationInput(session.current?.getState() || state));
    return () => navigation.current.disconnect(owner);
  }, [onNavigationStateChange]);
  const clearKey = () => { if (keyInput.current) keyInput.current.value = ''; setHasKey(false); reportNavigation(session.current?.getState() || state); };
  useLayoutEffect(() => { callbacks.current = { onSnapshot, onDirtyChange }; });
  useLayoutEffect(() => {
    const owner = { closed: false }; lifetime.current = owner;
    const current = createImageSettingsSession({ client, slot, onChange: next => { if (!owner.closed && lifetime.current === owner) { reportNavigation(next); setState(next); } }, onSnapshot: next => { if (!owner.closed && lifetime.current === owner) callbacks.current.onSnapshot(next); } });
    session.current = current; void current.load();
    return () => { owner.closed = true; if (keyInput.current) keyInput.current.value = ''; current.dispose(); if (session.current === current) session.current = null; callbacks.current.onDirtyChange(false); };
  }, [client, slot]);
  useLayoutEffect(() => {
    interactionRef.current = interaction; session.current?.setVisible(visible); reportNavigation(session.current?.getState() || state);
    if (keyInput.current?.value) { clearKey(); setKeyNotice('隐藏设置或切换项目时已清空新输入的密钥；非秘密草稿仍保留。需要替换密钥时请重新输入。'); }
  }, [interaction]);
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return;
    const changed = () => { const shown = document.visibilityState !== 'hidden'; if (!shown) { interactionRef.current = null; session.current?.setVisible(false); reportNavigation(session.current?.getState() || state); if (keyInput.current?.value) { clearKey(); setKeyNotice('页面隐藏时已清空新输入的密钥；非秘密草稿仍保留。'); } } setPageVisible(shown); };
    document.addEventListener('visibilitychange', changed); return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useLayoutEffect(() => { callbacks.current.onDirtyChange(imageSettingsDirty(state) || hasKey); }, [state.snapshot, state.draft, state.secretAction, hasKey]);
  const owner = lifetime.current;
  const usable = () => Boolean(visible && interactionRef.current === interaction && owner && !owner.closed && lifetime.current === owner && (typeof document === 'undefined' || document.visibilityState !== 'hidden'));
  const close = () => {
    if (!usable()) return;
    const captured = interactionRef.current, version = navigation.current.getState().version;
    return closeSettingsAfterPermission(beforeClose, () => usable() && interactionRef.current === captured && navigation.current.getState().version === version, () => {
      if (keyInput.current?.value) setKeyNotice('离开设置时已清空新输入的密钥；非秘密草稿仍保留。'); clearKey(); interactionRef.current = null; session.current?.setVisible(false); onClose();
    });
  };
  function submit(event) { event.preventDefault(); if (!usable() || !imageSettingsCanSave(session.current?.getState() || state)) return; const value = keyInput.current?.value || ''; clearKey(); void session.current?.save(value); }
  const { snapshot, draft } = state, editable = visible && imageSettingsEditable(state), destination = imageSettingsDestination(draft), bindingChanged = imageSettingsBindingChanged(state);
  const selectSlot = next => { if (!usable() || next === slot) return; if (onRequestSelectSlot) { onRequestSelectSlot(next); return; } if (keyInput.current?.value) setKeyNotice('切换连接时已清空新输入的密钥；非秘密草稿仍保留。'); clearKey(); interactionRef.current = null; session.current?.setVisible(false); onSelectSlot(next); };
  return <section className="image-settings-page" data-testid={`${prefix}-page`} data-phase={state.phase} hidden={!visible} inert={!visible} aria-label="图像连接设置">
    <header className="image-generation-heading"><div><span className="image-generation-eyebrow">IMAGE · CONNECTION</span><h2>图像设置</h2><p>一次配置，逐次确认付费生成</p></div><Button type="button" variant="ghost" className="button quiet" data-testid={`${prefix}-back`} aria-label={closeLabel ?? '返回图像工坊'} disabled={!visible} onClick={close}><Icon name="left" size={14} />{closeLabel ?? '返回'}</Button></header>
    <div className="image-settings-slots" role="group" aria-label="图像连接槽位"><Button type="button" variant="ghost" className="button" data-testid={`${prefix}-slot-official`} aria-pressed={!custom} disabled={!visible} onClick={() => selectSlot('official')}>OpenAI 官方</Button><Button type="button" variant="ghost" className="button" data-testid={`${prefix}-slot-custom`} aria-pressed={custom} disabled={!visible} onClick={() => selectSlot('custom')}>自定义兼容连接</Button><Button type="button" variant="ghost" className="button" data-testid={`${prefix}-slot-comfy`} aria-pressed={false} disabled={!visible} onClick={() => selectSlot('comfy')}>本地 ComfyUI</Button></div>
    <form className="image-settings-form" noValidate autoComplete="off" onSubmit={submit}>
      <p className="image-settings-help">保存只更新本机图像设置，不发送描述、不生成图片。官方与自定义连接各自保存密钥，Agent 与视频设置也相互独立。</p>
      {!snapshot ? <div role="status"><p>{state.phase === 'loading' ? '正在读取图像设置…' : state.message}</p>{state.phase !== 'loading' && <Button type="button" variant="ghost" className="button" data-testid={`${prefix}-load`} disabled={!visible} onClick={() => { if (usable()) void session.current?.load(); }}>重新读取</Button>}</div> : <>
        <Label className="image-settings-enable" htmlFor={`${prefix}-enable`}><Input id={`${prefix}-enable`} data-testid={`${prefix}-enable`} type="checkbox" checked={draft.enabled} disabled={!editable} onChange={event => { if (usable()) session.current?.setEnabled(event.target.checked); }} /><span><strong>{custom ? '启用自定义兼容图像' : '启用 OpenAI 图像'}</strong><small>启用不代表授权任何一次付费请求</small></span></Label>
        {custom && <>
          <Label htmlFor={`${prefix}-base-url`}>兼容 API 基础地址</Label>
          <Input id={`${prefix}-base-url`} data-testid={`${prefix}-base-url`} type="text" value={draft.baseUrl} maxLength={CUSTOM_IMAGE_ENDPOINT_LIMIT} disabled={!editable} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="https://images.example.com/v1" onChange={event => { if (usable()) session.current?.setConfigurationField('baseUrl', event.target.value); }} />
          <p className="image-settings-help">仅支持 HTTPS 公网域名、443 端口和路径前缀。保存前会统一域名大小写、去除 :443 与末尾斜杠。不要输入密钥、查询参数或完整生成路径。</p>
          <Label htmlFor={`${prefix}-model`}>模型标识</Label>
          <Input id={`${prefix}-model`} data-testid={`${prefix}-model`} type="text" value={draft.model} maxLength={120} disabled={!editable} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="服务商提供的准确模型标识" onChange={event => { if (usable()) session.current?.setConfigurationField('model', event.target.value); }} />
          <p className="image-settings-help">仅支持固定 JSON 请求与 base64 单张 PNG 响应。并非所有 OpenAI 兼容服务都可用；不支持本地 ComfyUI、URL 下载、自动探测或回退。</p>
          {bindingChanged && snapshot.secret.configured && <p className="image-generation-notice" role="alert" data-testid={`${prefix}-binding-warning`}>地址或模型已变化。必须重新输入这个连接的新密钥，或点击移除密钥后保存。原密钥不会带到新地址。</p>}
        </>}
        <div className="image-settings-fixed" data-testid={`${prefix}-fixed`}><strong>{custom ? '自定义兼容 · JSON / base64 PNG' : 'OpenAI · Images'}</strong><span data-testid={`${prefix}-destination`}>{destination || '填写有效地址后显示完整发送目标'}</span><span>{draft.model || '尚未填写模型'}</span><span>1024 × 1024 · low · PNG · 不透明 · 1 张</span><Badge className="small-badge neutral">真实调用尚未验证</Badge></div>
        <Label htmlFor={`${prefix}-key`}>专用于图像的 API 密钥</Label>
        <Input ref={keyInput} id={`${prefix}-key`} data-testid={`${prefix}-key`} type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} maxLength={IMAGE_SETTINGS_LIMITS.secretBytes} disabled={!editable || state.secretAction === 'remove'} placeholder={state.secretAction === 'remove' ? '保存时移除已有密钥' : snapshot.secret.configured ? '留空保留；输入新密钥替换' : custom ? '输入此自定义连接的 API 密钥' : '输入 OpenAI API 密钥'} onChange={event => { if (usable()) { setHasKey(Boolean(event.target.value)); reportNavigation(session.current?.getState() || state); setKeyNotice(''); } else if (keyInput.current) keyInput.current.value = ''; }} aria-describedby={`${prefix}-key-help`} />
        <p id={`${prefix}-key-help`} className="image-settings-help">密钥写入后不回显，不进入项目、聊天、浏览器存储或日志。离开、隐藏或切换项目会清空尚未提交的密钥。</p>
        <Label htmlFor={`${prefix}-storage`}>密钥保存方式</Label>
        <WorkbenchSelect id={`${prefix}-storage`} data-testid={`${prefix}-storage`} value={state.storage} disabled={!editable || state.secretAction === 'remove'} onChange={event => { if (usable()) session.current?.setStorage(event.target.value); }}><option value="" disabled>请选择保存方式</option><option value="session">仅本次后端运行</option><option value="persistent" disabled={!snapshot.storage.persistentAvailable}>系统加密保存{snapshot.storage.persistentAvailable ? '' : '（当前不可用）'}</option></WorkbenchSelect>
        <p className="image-settings-help" data-testid={`${prefix}-storage-status`}>{imageStorageReason(snapshot.storage)}{snapshot.secret.configured && !hasKey ? ' 更改已有密钥的保存方式需重新输入密钥。' : ''}</p>
        <div className="image-settings-current" data-testid={`${prefix}-current`}><span>服务器当前设置：{snapshot.configuration.enabled ? '已启用' : '未启用'}</span><span>密钥：{snapshot.secret.configured ? storageLabel(snapshot.secret.storage) : '未配置'}</span><span>配置版本 r{snapshot.revision}</span></div>
        {snapshot.secret.configured && <Button type="button" variant="ghost" className="button" data-testid={`${prefix}-remove-key`} aria-pressed={state.secretAction === 'remove'} disabled={!editable} onClick={() => { if (usable()) { clearKey(); session.current?.removeKey(state.secretAction !== 'remove'); } }}>{state.secretAction === 'remove' ? '撤销移除密钥' : '移除图像密钥'}</Button>}
        <p className="image-settings-help" data-testid={`${prefix}-intent`}>此次保存：{hasKey ? `${snapshot.secret.configured ? '替换' : '写入'}密钥 · ${storageLabel(state.storage)}` : state.secretAction === 'remove' ? '移除已有密钥' : snapshot.secret.configured ? '保留已有密钥' : '仅保存连接设置，尚无密钥'}</p>
        {state.recovery && <div className="image-generation-notice" data-testid={`${prefix}-recovery`}><p>保存结果待核对，不会自动重试。</p><div className="image-generation-actions"><Button type="button" variant="ghost" className="button" data-testid={`${prefix}-reload`} disabled={!editable} onClick={() => { if (usable()) { clearKey(); void session.current?.reload(); } }}>重新读取</Button><Button type="button" variant="ghost" className="button" data-testid={`${prefix}-use-latest`} disabled={!editable || state.phase === 'blocked'} onClick={() => { if (usable()) { clearKey(); session.current?.useLatest(); } }}>使用已保存设置</Button><Button type="button" variant="ghost" className="button" data-testid={`${prefix}-keep-draft`} disabled={!editable || state.phase !== 'review'} onClick={() => { if (usable()) { clearKey(); session.current?.acknowledge(); } }}>核对后保留草稿</Button></div></div>}
        <Button type="submit" variant="ghost" className="button primary" data-testid={`${prefix}-save`} disabled={!visible || !imageSettingsCanSave(state) || hasKey && !state.storage || bindingChanged && snapshot.secret.configured && !hasKey && state.secretAction !== 'remove'}>{state.phase === 'saving' ? '正在保存…' : '保存图像设置'}</Button>
      </>}
      {keyNotice && <p className="image-generation-notice" role="status" data-testid={`${prefix}-key-notice`}>{keyNotice}</p>}
      {snapshot && state.message && <p className="image-generation-notice" role="status" data-testid={`${prefix}-message`}>{state.message}</p>}
    </form>
  </section>;
}

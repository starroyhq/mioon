import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@mioon/ui/components/badge';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect, WorkbenchTooltip } from './WorkspaceControls.jsx';
import Icon from './icons.jsx';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';
import { AGENT_PROTOCOLS, agentEndpointPreview, agentBindingChanged, agentSettingsBusy, agentSettingsCanSave, agentSettingsDirty, agentSettingsEditable,
  createAgentSettingsSession, initialAgentSettingsState } from './agent-settings.js';

const storageLabel = mode => ({ none: '未保存密钥', session: '仅本次运行', persistent: '系统加密保存' }[mode] || '未保存密钥');
const storageReason = storage => ({
  WEB_SESSION_ONLY: '当前为服务器模式，密钥仅保存在服务器内存；服务器退出后清除。',
  LINUX_BASIC_TEXT: '系统仅提供 basic_text，不能安全持久保存；密钥仅在本次应用运行中保留。',
  OS_SECRET_STORE_UNAVAILABLE: '系统安全存储不可用，不能持久保存；可选择仅本次运行。',
}[storage?.reasonCode] || (storage?.persistentAvailable ? '系统安全存储可用；持久密钥经系统加密保存在项目数据之外。' : '当前无法持久保存密钥；仅本次运行可用。'));

export default function AgentSettings({ onClose }) {
  const [state, setState] = useState(initialAgentSettingsState);
  const [hasKey, setHasKey] = useState(false);
  const [keyNotice, setKeyNotice] = useState('');
  const visible = useWorkspaceVisibility();
  const interaction = useMemo(() => ({ visible }), [visible]), interactionRef = useRef(interaction);
  const keyInput = useRef(null), session = useRef(null), dismissed = useRef(false);
  // The password lives only in the mounted input, never in a saved React state,
  // snapshot, browser store, project, or recovery payload.
  const clearKey = () => { if (keyInput.current) keyInput.current.value = ''; setHasKey(false); };
  useLayoutEffect(() => {
    dismissed.current = false;
    const current = createAgentSettingsSession({ onChange: next => { if (!dismissed.current) setState(next); } });
    session.current = current;
    void current.load();
    return () => { dismissed.current = true; if (keyInput.current) keyInput.current.value = ''; current.dispose(); if (session.current === current) session.current = null; };
  }, []);
  useLayoutEffect(() => {
    interactionRef.current = interaction; session.current?.setVisible(visible);
    if (!visible && keyInput.current?.value) { clearKey(); setKeyNotice('隐藏设置时已清空新输入的密钥；连接草稿仍保留。需要替换密钥时请重新输入。'); }
  }, [interaction]);
  const usable = () => !dismissed.current && visible && interactionRef.current === interaction;
  const dismiss = () => { if (!usable()) return; if (keyInput.current?.value) setKeyNotice('离开设置时已清空新输入的密钥；连接草稿仍保留。'); clearKey(); interactionRef.current = null; session.current?.setVisible(false); onClose(); };
  const withClearKey = action => { if (!usable()) return; clearKey(); action(); };
  const changeBinding = patch => withClearKey(() => session.current?.edit(patch));
  function submit(event) {
    event.preventDefault();
    if (!usable() || !agentSettingsCanSave(session.current?.getState() || state)) return;
    const value = keyInput.current?.value || '';
    clearKey(); // Clear the actual DOM synchronously, before dispatch or an await.
    void session.current?.save(value);
  }
  const { snapshot, draft, phase, recovery } = state;
  const busy = agentSettingsBusy(state), editable = visible && agentSettingsEditable(state);
  const preset = snapshot?.presets.find(item => item.id === draft?.presetId);
  const platform = preset?.platforms.find(item => item.id === draft?.platformId);
  const changedBinding = snapshot && draft && agentBindingChanged(snapshot.configuration, draft);
  const removesKey = state.secretAction === 'remove' || changedBinding;
  const dirty = agentSettingsDirty(state) || hasKey;
  const error = ['error', 'load_error', 'blocked', 'review'].includes(phase);
  const defaultsChanged = platform && (draft.baseUrl !== platform.baseUrl || draft.model !== platform.model || draft.protocol !== platform.defaultProtocol);
  const endpoint = agentEndpointPreview(draft);
  const modelHints = platform?.supportedModelHints?.[draft?.protocol] || [];
  const modelNeedsReview = modelHints.length > 0 && !modelHints.includes(draft.model);
  const protocolNote = platform?.protocolNotes?.[draft?.protocol];
  return <section className="agent-settings-page" data-testid="agent-settings-page" data-phase={phase} aria-label="Agent 连接设置" hidden={!visible} inert={!visible}>
      <header className="modal-header agent-settings-header">
        <div className="agent-settings-heading"><span className="agent-settings-symbol"><Icon name="sparkle" size={22} /></span><div>
          <div className="agent-settings-eyebrow">AGENT · CONNECTION</div><h2>Agent 连接设置</h2>
          <p>连接设置不会发起模型请求；对话仅发送经确认的聊天文本，尚无工具执行。</p>
        </div></div>
        <Button type="button" variant="ghost" className="icon-button" aria-label="返回 Agent 对话" data-testid="agent-settings-back" disabled={!visible} onClick={dismiss}><Icon name="left" /></Button>
      </header>
      <form noValidate autoComplete="off" onSubmit={submit} className="agent-settings-form">
        <div className="agent-settings-body">
          <div className="agent-settings-disclosure"><Icon name="info" size={15} /><span>保存仅更新本机工作台设置，不发起模型请求，也不发送项目内容。</span><Badge className="small-badge neutral">尚未验证连接</Badge></div>
          {!snapshot ? <div className="agent-settings-loading" role="status">{phase === 'loading' ? <><span className="spinner" />正在读取连接设置…</> : <><Icon name="info" size={24} /><p data-testid="agent-settings-error" role="alert">{state.message}</p><Button type="button" variant="ghost" className="button" data-testid="agent-settings-reload" onClick={() => { if (usable()) void session.current?.load(); }}>重新读取</Button></>}</div> : <>
            <section className="agent-settings-section" aria-labelledby="agent-connection-heading">
              <div className="agent-settings-section-title"><h3 id="agent-connection-heading">模型服务</h3><span>预设是起点，地址与模型均可编辑</span></div>
              <div className="agent-settings-grid">
                <div className="agent-settings-field"><Label htmlFor="agent-preset">服务商预设</Label>
                  <WorkbenchSelect id="agent-preset" data-testid="agent-settings-preset" value={draft.presetId} disabled={!editable} onChange={event => withClearKey(() => session.current?.selectPreset(event.target.value))}>
                    {snapshot.presets.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </WorkbenchSelect>
                </div>
                <div className="agent-settings-field"><Label htmlFor="agent-platform">平台 / 地区</Label>
                  <WorkbenchSelect id="agent-platform" data-testid="agent-settings-platform" value={draft.platformId} disabled={!editable} onChange={event => withClearKey(() => session.current?.selectPlatform(event.target.value))}>
                    {(preset?.platforms || []).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </WorkbenchSelect>
                </div>
                <div className="agent-settings-field agent-settings-full"><Label htmlFor="agent-protocol">API 协议</Label>
                  <WorkbenchSelect id="agent-protocol" data-testid="agent-settings-protocol" value={draft.protocol} disabled={!editable} onChange={event => { if (usable()) session.current?.edit({ protocol: event.target.value }); }}>
                    {(platform?.availableProtocols || []).map(protocol => <option key={protocol} value={protocol}>{AGENT_PROTOCOLS[protocol].label}</option>)}
                  </WorkbenchSelect>
                  <p className="agent-settings-help">手动选择协议；不会自动探测、回退或更换模型。切换后需重新确认聊天发送。</p>
                </div>
                <div className="agent-settings-field agent-settings-full"><Label htmlFor="agent-base-url">服务地址 <span>Base URL</span></Label>
                  <Input id="agent-base-url" data-testid="agent-settings-base-url" value={draft.baseUrl} onChange={event => changeBinding({ baseUrl: event.target.value })} disabled={!editable} maxLength={2048} placeholder={platform?.baseUrlTemplate || 'https://api.example.com/v1'} type="url" spellCheck={false} autoCapitalize="none" aria-describedby="agent-endpoint-help" />
                  <p id="agent-endpoint-help" className="agent-settings-help">填写 API 基础地址，不含 /chat/completions 或 /responses。远程服务使用 HTTPS；本地服务请选 Ollama 预设。</p>
                </div>
                <div className="agent-settings-field agent-settings-full"><div className="agent-settings-label-row"><Label htmlFor="agent-model">模型名称 <span>Model ID</span></Label><Button type="button" variant="ghost" className="text-button" data-testid="agent-settings-reset" disabled={!editable || !defaultsChanged} onClick={() => withClearKey(() => session.current?.edit({ baseUrl: platform.baseUrl, model: platform.model, protocol: platform.defaultProtocol }))}><Icon name="refresh" size={12} />恢复此平台预设</Button></div>
                  <Input id="agent-model" data-testid="agent-settings-model" value={draft.model} onChange={event => { if (usable()) session.current?.edit({ model: event.target.value }); }} disabled={!editable} maxLength={200} placeholder="输入账户可用的模型 ID" spellCheck={false} autoCapitalize="none" />
                  {draft.protocol === 'responses' && <p className={`agent-settings-help ${modelNeedsReview ? 'agent-settings-model-warning' : ''}`} data-testid="agent-settings-model-guidance">{modelHints.length ? `${modelNeedsReview ? '当前模型不在此协议文本配置中，请手动填写：' : '此协议文本配置：'}${modelHints.join('、')}。` : '自定义服务：请手动填写支持 Responses 的精确模型 ID；兼容性未经验证。'}{protocolNote || '当前仅支持非思考文字对话，不支持工具。'}</p>}
                </div>
                <div className="agent-settings-endpoint agent-settings-full" data-testid="agent-settings-endpoint"><span>{AGENT_PROTOCOLS[draft.protocol]?.label} · 请求地址预览</span><p>{endpoint || '填写完整的 API 基础地址后显示请求地址。'}</p></div>
              </div>
              <div className="agent-settings-preset-note" data-testid="agent-settings-preset-note"><p>{platform?.notes || preset?.description || '请自行确认此地址、账户和模型的对应关系。'}</p><p>预设不代表服务商的所有模型均兼容，也不代表当前账户可用。</p>{Boolean(platform?.sources.length) && <div className="agent-settings-sources">{platform.sources.map(source => snapshot.storage.sessionScope === 'app' ? <span className="agent-settings-source-reference" key={source.url}><span>{source.label} · 可复制到外部浏览器打开</span><span>{source.url}</span></span> : <a href={source.url} key={source.url} target="_blank" rel="noopener noreferrer">{source.label}<Icon name="arrow" size={10} /></a>)}</div>}</div>
            </section>
            <section className="agent-settings-secret-section" aria-labelledby="agent-secret-heading">
              <div className="agent-settings-section-title"><h3 id="agent-secret-heading"><Icon name="lock" size={14} />API 密钥</h3><span data-testid="agent-settings-secret-status" data-configured={snapshot.secret.configured} data-storage={snapshot.secret.storage}>{snapshot.secret.configured ? `服务器已保存 · ${storageLabel(snapshot.secret.storage)}` : '服务器未保存密钥'}</span></div>
              <div className="agent-settings-field"><Label className="sr-only" htmlFor="agent-key">{snapshot.secret.configured ? '替换 API 密钥' : '输入 API 密钥'}</Label>
                <Input ref={keyInput} id="agent-key" data-testid="agent-settings-key" type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" disabled={!editable || state.secretAction === 'remove'} placeholder={state.secretAction === 'remove' ? '保存时将移除已有密钥' : snapshot.secret.configured && !changedBinding ? '留空保留已有密钥；输入新密钥以替换' : '输入新密钥（可留空，仅保存连接参数）'} maxLength={8192} onChange={event => { if (usable()) { setHasKey(Boolean(event.target.value)); setKeyNotice(''); } }} aria-describedby="agent-key-help" />
                <p id="agent-key-help" className="agent-settings-help">已保存的密钥不会回填。新输入仅临时保留，提交或关闭后清空；不会写入浏览器存储。</p>
              </div>
              {keyNotice && <p className="agent-settings-binding-warning" role="status" data-testid="agent-settings-key-cleared">{keyNotice}</p>}
              {changedBinding && <div className="agent-settings-binding-warning" data-testid="agent-settings-binding-warning"><Icon name="info" size={14} /><span>服务商、地区或地址已改变。保存时会清除原密钥；请确认目标后重新输入新密钥。</span></div>}
              <div className="agent-settings-key-actions"><div className="agent-settings-field"><Label htmlFor="agent-storage">新密钥的保存方式</Label>
                <WorkbenchSelect id="agent-storage" data-testid="agent-settings-storage" value={state.storage} disabled={!editable || state.secretAction === 'remove'} onChange={event => { if (usable()) session.current?.setStorage(event.target.value); }}>
                  <option value="session">仅本次运行（{snapshot.storage.sessionScope === 'app' ? '应用退出后清除' : '服务器退出后清除'}）</option><option value="persistent" disabled={!snapshot.storage.persistentAvailable}>系统加密保存{!snapshot.storage.persistentAvailable ? '（不可用）' : ''}</option>
                </WorkbenchSelect>
              </div>{snapshot.secret.configured && <WorkbenchTooltip content={state.secretAction === 'remove' ? '撤销尚未提交的移除操作' : '下一次保存时移除已保存密钥'}><Button type="button" variant="ghost" className={`button small ${state.secretAction === 'remove' ? '' : 'danger-text'}`} data-testid="agent-settings-remove-key" aria-pressed={state.secretAction === 'remove'} disabled={!editable} onClick={() => withClearKey(() => session.current?.removeKey(state.secretAction !== 'remove'))}>{state.secretAction === 'remove' ? '撤销移除' : '移除密钥'}</Button></WorkbenchTooltip>}</div>
              <p className="agent-settings-storage-note" data-testid="agent-settings-storage-status">{storageReason(snapshot.storage)} {!hasKey && snapshot.secret.configured && !removesKey ? '更改保存方式需重新输入密钥。' : ''}</p>
              <div className="agent-settings-key-intent" data-testid="agent-settings-key-intent">{hasKey ? `此次保存：${snapshot.secret.configured ? '替换' : '写入'}密钥 · ${storageLabel(state.storage)}` : removesKey && snapshot.secret.configured ? '此次保存：移除已有密钥' : snapshot.secret.configured ? '此次保存：保留已有密钥' : draft.presetId === 'ollama' ? '此次保存：仅连接参数；本地 Ollama 通常无需密钥' : '此次保存：仅连接参数；未配置 API 密钥'}</div>
            </section>
            {state.message && <div className={`agent-settings-message ${error ? 'is-warning' : phase === 'saved' ? 'is-success' : ''}`} role={error ? 'alert' : 'status'} data-testid={error ? 'agent-settings-error' : 'agent-settings-status'} data-phase={phase}><Icon name={phase === 'saved' ? 'check' : 'info'} size={15} /><div><p>{state.message}</p>{recovery && <>
              <div className="agent-settings-current" data-testid="agent-settings-current"><span>服务器当前设置</span><strong>{snapshot.configuration.model}</strong><span>{AGENT_PROTOCOLS[snapshot.configuration.protocol].label}</span><span>{agentEndpointPreview(snapshot.configuration)}</span><span>{snapshot.secret.configured ? `已保存密钥 · ${storageLabel(snapshot.secret.storage)}` : '未保存密钥'}</span></div>
              <div className="agent-settings-recovery-actions">{phase === 'blocked' ? <Button type="button" variant="ghost" className="button small" data-testid="agent-settings-reload" onClick={() => { if (usable()) void session.current?.reload(); }}>重新读取状态</Button> : <><Button type="button" variant="ghost" className="button small" data-testid="agent-settings-review" disabled={busy} onClick={() => { if (usable()) session.current?.acknowledge(); }}>已核对，继续编辑草稿</Button><Button type="button" variant="ghost" className="text-button" data-testid="agent-settings-use-latest" disabled={busy} onClick={() => withClearKey(() => session.current?.useLatest())}>使用服务器设置</Button></>}</div>
            </>}</div></div>}
          </>}
        </div>
        <footer className="agent-settings-footer"><span>{phase === 'saving' ? '返回对话不会撤回已提交的保存。' : dirty ? '有尚未保存的更改' : '当前仅管理一个连接配置'}</span><div><Button type="button" variant="ghost" className="button" data-testid="agent-settings-cancel" disabled={!visible} onClick={dismiss}>返回对话</Button><Button type="submit" variant="ghost" className="button primary" data-testid="agent-settings-save" disabled={!visible || !agentSettingsCanSave(state) || !dirty}>{phase === 'saving' ? <span className="spinner" /> : <Icon name="check" size={15} />}{phase === 'saving' ? '保存中…' : '保存设置'}</Button></div></footer>
      </form>
  </section>;
}

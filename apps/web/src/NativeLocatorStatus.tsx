import React from 'react';
import { Button } from '@mioon/ui/components/button';
import type { ProjectWindowBridge, ProjectWindowContext } from './desktop-window-client.ts';
/** Editors show the one global writer's status; only the independent settings
 * surface forwards explicit recovery intents to that exact retained owner. */
export default function NativeLocatorStatus({ context, bridge, recovery = false }: {
  readonly context: ProjectWindowContext; readonly bridge: ProjectWindowBridge; readonly recovery?: boolean;
}) {
  const state = context.locatorStatus;
  const label = !state ? '正在核对位置记录…' : state.phase === 'saved' ? '位置已记住' : state.phase === 'pending' ? '记住位置中…'
    : state.phase === 'conflict' ? '位置记录冲突' : state.phase === 'unavailable' ? '位置暂不可用' : state.phase === 'error' ? '位置未确认'
      : state.phase === 'loading' ? '读取位置…' : '最近项目';
  return <section aria-label="最近项目位置" data-testid="native-last-project-status" data-phase={state?.phase ?? 'loading'} className={recovery ? 'project-home-notice' : 'native-locator-status'} style={recovery ? undefined : { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, whiteSpace: 'nowrap' }}>
    <span role="status" aria-live="polite">{label}</span>
    {recovery ? <>
      <p>最近项目由项目入口统一记录；查看或核对不会打开项目，也不会改写项目内容。</p>
      {state?.uncertain && <p role="alert">先前写入结果未确认，原请求仍保留。重新读取不会撤销或自动重试它。</p>}
      {state?.phase === 'conflict' && <p role="alert">位置记录发生冲突，已停止写入。请只读核对后再明确处理，不会自动覆盖。</p>}
      {state?.identityBlocked && <p>工作区或服务身份已变化，请保留当前窗口并核对。</p>}
      {state?.rechecked && <p>已读取服务器记录；先前未确认的写入仍保留，未恢复自动写入。</p>}
      {state?.canRetry && <Button type="button" variant="outline" disabled={context.quitting} onClick={() => { void bridge.requestLocatorAction('retry', state.statusVersion).catch(() => {}); }}>重试同一次写入</Button>}
      {state?.canRecheck && <Button type="button" variant="ghost" disabled={context.quitting || state.reading} onClick={() => { void bridge.requestLocatorAction('recheck', state.statusVersion).catch(() => {}); }}>只读核对</Button>}
      {state?.reading && <span role="status">正在只读核对…</span>}
    </> : <Button type="button" size="sm" variant="ghost" aria-label="查看最近项目位置记录" disabled={context.quitting} onClick={() => { void bridge.showSettings('agent').catch(() => {}); }}>详情</Button>}
  </section>;
}

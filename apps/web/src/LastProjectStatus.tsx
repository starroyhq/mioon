import React from 'react';
import { Button } from '@mioon/ui/components/button';
import type { LastProjectController, LastProjectState } from './last-project-state.ts';

export default function LastProjectStatus({ state, controller, restored = false }: { state: LastProjectState; controller: LastProjectController; restored?: boolean }) {
  if (restored) return <section className="input-hint" aria-label="最近项目位置" title="恢复分支暂不记住最近项目" data-testid="last-project-status" data-phase="unavailable"><span role="status">恢复分支不记位置</span></section>;
  const status = state.phase === 'saved' ? '位置已记住'
    : state.phase === 'pending' ? '记住位置中…'
      : state.phase === 'conflict' ? '位置记录冲突'
        : state.phase === 'unavailable' ? '位置暂不可用'
          : state.phase === 'error' ? '位置未确认'
            : state.phase === 'loading' ? '读取位置…'
              : state.targetStatus === 'missing' ? '上次项目缺失'
                : '最近项目';
  return <section aria-label="最近项目位置" title={`最近项目位置：${status}`} data-testid="last-project-status" data-phase={state.phase}
    style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, whiteSpace: 'nowrap' }}>
    <span role="status" aria-live="polite">{status}</span>
    <details style={{ position: 'relative' }}>
      <summary aria-label="最近项目位置详情">详情</summary>
      <div className="notice" style={{ position: 'absolute', top: '100%', right: 0, width: 280, zIndex: 30, whiteSpace: 'normal' }}>
        <p>仅本工作区的位置记忆。只记住下次打开的项目位置；项目内容和片段草稿分别保存。</p>
        {state.uncertain && <p role="alert">当前项目可能尚未记住。先前写入结果未确认，重新核对不会取消先前写入，也不会自动改写记录。</p>}
        {!state.uncertain && state.phase === 'conflict' && <p role="alert">已停止写入，请重新载入后明确打开项目。</p>}
        {state.identityBlocked && <p>工作区或服务身份已变化，请重新载入后明确打开项目。</p>}
        {state.phase === 'unavailable' && <p>仍可手动打开项目。</p>}
        {state.rechecked && (state.phase === 'error' || state.phase === 'conflict') && <p data-testid="last-project-rechecked">已读取服务器记录；先前未确认的写入仍保留，未恢复自动写入。</p>}
        {state.canRetry && <Button type="button" size="sm" variant="outline" data-testid="last-project-retry" onClick={() => { void controller.retry(); }}>重试同一次写入</Button>}
        {(state.phase === 'error' || state.phase === 'conflict' || state.phase === 'unavailable') && state.canRecheck &&
          <Button type="button" size="sm" variant="ghost" data-testid="last-project-recheck" onClick={() => { void controller.recheck(); }}>只读核对</Button>}
        {state.reading && state.phase !== 'loading' && <span role="status">正在只读核对…</span>}
      </div>
    </details>
  </section>;
}

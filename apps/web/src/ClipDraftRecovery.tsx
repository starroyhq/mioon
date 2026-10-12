import React, { useRef } from 'react';
import { Button } from '@mioon/ui/components/button';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import RecoveryStorageDetails from './RecoveryStorageDetails.tsx';
import type { ClipDraftController, ClipDraftState } from './clip-draft-state.ts';

export default function ClipDraftRecovery({ state, controller, pending, onOpenRequests }: { state: ClipDraftState; controller: ClipDraftController; pending: boolean; onOpenRequests?: () => void }) {
  const confirm = useConfirmation();
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const time = state.savedAt ? new Date(state.savedAt).toLocaleTimeString('zh-CN') : '';
  const canOfferAbandon = state.dirty && (state.autosavePaused || state.phase === 'error' || state.phase === 'saving' || state.submitting && !state.businessPending);
  async function abandon() {
    const captured = controller.capture();
    if (pendingRef.current || !controller.canAbandon(captured)) return;
    const accepted = await confirm('放弃当前输入，保留草稿记录？这只会重置当前属性表单，不会删除已保存的草稿，也不会取消正在处理的写入或时间线请求。已保存或稍后写入的草稿可能再次出现。');
    if (accepted && !pendingRef.current && controller.canAbandon(captured)) controller.abandonCurrentInput(captured);
  }
  const status = state.phase === 'unsupported' ? '恢复分支暂不支持本地草稿'
    : state.phase === 'loading' ? state.autosavePaused ? '正在重新核对本地草稿；自动保存仍暂停…' : '正在核对本地草稿…'
      : state.autosavePaused ? state.retainedRecord && !state.dirty ? '当前表单已重置；草稿记录保留，自动保存已暂停' : '本地草稿自动保存已暂停'
        : state.phase === 'saving' ? '正在保存本地草稿…'
          : state.phase === 'saved' ? `本地草稿已保存${time ? ` · ${time}` : ''}`
            : state.phase === 'error' ? '本地草稿尚未确认保存'
              : state.candidate ? `有可恢复的本地草稿${time ? ` · ${time}` : ''}`
                : state.dirty ? '输入尚未确认保存到本地' : '片段属性可自动保存为本地草稿';
  return <section className="notice" data-testid="clip-draft-recovery" aria-label="本地片段草稿">
    <p role="status" data-testid="clip-draft-status">{status}</p>
    <p className="input-hint">仅片段属性，本地明文；最后未确认输入可能丢失。草稿不会自动应用到时间线。</p>
    <RecoveryStorageDetails domain="clip" />
    {state.candidate && <div><Button type="button" size="sm" variant="outline" data-testid="restore-clip-draft" disabled={state.dirty || state.submitting} onClick={() => controller.restore()}>恢复到属性表单</Button><Button type="button" size="sm" variant="ghost" data-testid="discard-stored-clip-draft" disabled={state.submitting} onClick={() => { void controller.discardStored(); }}>放弃已保存草稿</Button>{state.dirty && <p className="input-hint">当前有新输入，未替换为旧草稿。放弃旧草稿后可继续保留当前输入。</p>}</div>}
    {state.failure && <p className="input-hint" data-testid="clip-draft-failure-kind">{state.failure.kind === 'refused' ? '服务明确拒绝了本次请求。' : state.failure.kind === 'conflict' ? '本地记录或服务身份发生冲突。' : '先前请求的结果可能仍未确认。'} 重新核对只读取记录，不会重新提交或自动恢复写入。</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {(state.phase === 'error' || state.autosavePaused) && <Button type="button" size="sm" variant="ghost" data-testid="reload-clip-draft" disabled={state.submitting} onClick={() => { void controller.load(); }}>重新核对本地草稿</Button>}
    {canOfferAbandon && <Button type="button" size="sm" variant="outline" data-testid="abandon-current-clip-input" disabled={pending || !controller.canAbandon()} onClick={abandon}>放弃当前输入，保留草稿记录</Button>}
    {pending && <p>时间线请求尚待确认；本地草稿不会重新提交。{onOpenRequests && <Button type="button" size="sm" variant="ghost" onClick={onOpenRequests}>查看任务</Button>}</p>}
  </section>;
}

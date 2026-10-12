import React from 'react';
import { Button } from '@mioon/ui/components/button';
import { LOCAL_SHOT_TEXT_LIMITS } from '@mioon/contracts/local-shot-text';
import type { LocalShotTextController, LocalShotTextState } from './local-shot-text-state.ts';

export interface ShotTextDraftRecoveryProps {
  state: LocalShotTextState; controller: LocalShotTextController; disabled?: boolean; canSave?: boolean; onInspect?: (shotId: string) => void;
}
const rawStyle = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as const;
/** No inputs, dialogs or effects: this recovery view operates the existing form. */
export default function ShotTextDraftRecovery({ state, controller, disabled = false, canSave = false, onInspect }: ShotTextDraftRecoveryProps) {
  const blocked = disabled || state.busy || state.phase === 'saving';
  const unconfirmed = Boolean(state.retainedPreparation && state.intent?.intentId !== state.retainedPreparation.intentId);
  const original = state.intent, retained = state.retainedPreparation, originalInput = original?.input ?? retained?.input;
  const originalRevision = original?.baseRevision ?? retained?.baseRevision;
  const other = state.projectPendingIntent && state.projectPendingIntent.shotId !== state.shotId ? state.projectPendingIntent : null;
  const status = state.phase === 'unsupported' ? '恢复分支暂不支持本地文字草稿'
    : state.phase === 'loading' ? '正在核对本地文字草稿…'
      : state.autosavePaused ? '本地文字自动保存已暂停'
        : state.phase === 'saving' ? '正在保存本地文字…'
          : state.candidate ? '发现可恢复的标题和提示词'
            : state.phase === 'saved' ? `文字草稿已保存在本地${state.savedAt ? ` · ${new Date(state.savedAt).toLocaleString('zh-CN')}` : ''}`
              : state.dirty ? '文字尚未确认保存到本地' : '标题和提示词已同步';
  return <section className="notice shot-text-draft-recovery" data-testid="shot-text-draft-recovery" aria-label="本地标题和提示词草稿">
    <p role="status" aria-live="polite" data-testid="shot-text-draft-status">{status}</p>
    {state.phase !== 'unsupported' && <Button type="button" size="sm" className="button primary" data-testid="save-shot-text" disabled={blocked || !canSave} onClick={() => { void controller.submit(); }}>保存标题和提示词</Button>}
    {state.dirty && (!state.raw.title.trim() || state.raw.title.length > 150 || state.raw.prompt.length > 5000) && <p className="input-hint" role="status">镜头保存需要 1–150 字符的有效标题，提示词最多 5000 字符。原始输入仍可保存在本地草稿。</p>}
    <details data-testid="shot-text-draft-disclosure"><summary>本地保存什么？</summary>
      <p>仅保存原始标题、提示词及原始保存版本，不保存参考图、生成参数、账号或认证设置。草稿在本机私有目录中以明文保存，不包含在工作区备份中；最后未收到确认的输入可能丢失。</p>
      <p>保存文字前会单独持久保存原请求编号与精确文字修改。打开面板、重新连接和读取记录都不会恢复文字或执行保存。恢复草稿只替换标题和提示词，其他输入保留。</p>
      <p>本工作区最多保留 {LOCAL_SHOT_TEXT_LIMITS.slots} 个镜头槽位，已有记录不会自动删除。</p>
    </details>
    {state.phase === 'unsupported' && <p className="input-hint">此恢复分支不读写本地文字记录，现有镜头编辑与保存仍可使用。</p>}
    {state.candidate && <div data-testid="shot-text-draft-candidate">
      <p>已保存标题：<strong style={rawStyle}>{state.candidate.raw.title || '（空标题）'}</strong></p>
      <details data-testid="shot-text-draft-provenance"><summary>查看提示词与草稿来源 · rev {state.candidate.baseRevision}</summary>
        <p style={rawStyle}>{state.candidate.raw.prompt || '（空提示词）'}</p><p style={rawStyle}>草稿 {state.candidate.draftId} · {state.candidate.updatedAt}</p>
        <p style={rawStyle}>原标题：{state.candidate.baseText.title}</p><p style={rawStyle}>原提示词：{state.candidate.baseText.prompt || '（空提示词）'}</p>
      </details>
      <div className="clip-form-actions">
        <Button type="button" size="sm" variant="outline" data-testid="restore-shot-text" disabled={blocked || state.pending} onClick={() => controller.restore()}>恢复文字，替换当前标题和提示词</Button>
        <Button type="button" size="sm" variant="ghost" data-testid="keep-current-shot-text" disabled={blocked || state.pending || state.autosavePaused || unconfirmed} onClick={() => { void controller.keepCurrent(); }}>保留当前文字，替换已保存草稿</Button>
        <Button type="button" size="sm" variant="ghost" data-testid="discard-shot-text-draft" disabled={blocked || state.pending || state.autosavePaused || unconfirmed} onClick={() => { void controller.discardStored(); }}>放弃已保存文字草稿</Button>
      </div>
    </div>}
    {state.baselineConflict && state.baseline && <div className="notice warning" data-testid="shot-text-baseline-conflict"><p>文字来自 rev {state.baseline.baseRevision}，当前镜头已变化。原版本仍保留，请核对当前保存内容后再继续。</p>
      <Button type="button" size="sm" variant="outline" disabled={blocked || state.pending || state.autosavePaused || unconfirmed} onClick={() => { void controller.keepCurrent(); }}>保留输入，明确以当前文字版本保存草稿</Button>
    </div>}
    {state.draftFailure && <p className="input-hint" data-testid="shot-text-failure-kind">{state.draftFailure.kind === 'refused' ? state.draftFailure.code === 'LOCAL_SHOT_TEXT_LOCAL_VALIDATION' ? '本地输入未通过校验，尚未发送保存请求。' : state.draftFailure.code === 'LOCAL_SHOT_TEXT_LOCAL_RETRY_LIMIT' ? '当前会话待确认草稿已达上限，尚未发送本次保存请求。' : '服务明确拒绝了本次草稿保存。' : state.draftFailure.kind === 'conflict' ? '草稿版本或服务身份发生冲突。' : '本次草稿保存结果未知；较晚完成的写入仍可能存在。'} 重新核对只读取记录，不会自动恢复写入。</p>}
    {unconfirmed && <p className="input-hint">原请求保存尚待确认，后续文字暂不写入本地。即使读取结果为空，也不能认定先前保存未发生。</p>}
    {state.retainedDraftWrite && state.autosavePaused && <details data-testid="shot-text-retry-provenance"><summary>查看待确认保存的原文字</summary><p style={rawStyle}>{state.retainedDraftWrite.raw.title || '（空标题）'}</p><p style={rawStyle}>{state.retainedDraftWrite.raw.prompt || '（空提示词）'}</p><p>重试保留同一草稿编号与保存版本，不会改用较新的当前输入。</p></details>}
    {state.autosavePaused && state.draftRetry && <Button type="button" size="sm" variant="outline" data-testid="retry-shot-text-draft" disabled={blocked || unconfirmed} onClick={() => { void controller.retryDraftSave(); }}>{state.draftRetry === 'same' ? '重试保存同一文字草稿' : '明确保存当前文字草稿'}</Button>}
    {state.autosavePaused && (state.draftFailure || state.retainedDeletion) && !state.draftRetry && <p className="input-hint">原草稿删除结果尚未确认，不能安全重建或覆盖。请重新核对本地记录。</p>}
    {state.retainedDeletion && <Button type="button" size="sm" variant="outline" data-testid="retry-shot-text-deletion" disabled={blocked} onClick={() => { void controller.retryDraftDeletion(); }}>重试同一草稿删除</Button>}
    {state.retainedDeletion && <Button type="button" size="sm" variant="outline" data-testid="accept-shot-text-current-state" disabled={blocked} onClick={() => { void controller.acceptCurrentAfterDeletion(); }}>核对并接受当前草稿状态</Button>}
    {state.draftError && <p role="alert">{state.draftError}</p>}
    {state.draftFailure?.kind === 'refused' && !state.leaveWithoutSaving && <Button type="button" size="sm" variant="outline" data-testid="leave-shot-text-unsaved" disabled={blocked} onClick={() => controller.allowLeaveWithoutSaving()}>允许离开，不保存当前本地草稿</Button>}
    {(state.phase === 'error' || state.autosavePaused || state.intentUncertain || state.intentFailure || state.retainedDeletion || other) && <Button type="button" size="sm" variant="ghost" data-testid="reload-shot-text" disabled={blocked} onClick={() => { void controller.load(); }}>重新核对本地记录</Button>}
    {other && <div role="status" data-testid="other-shot-text-pending"><p>本项目另一个镜头的文字保存结果待确认，请先处理原请求。</p>{onInspect && <Button type="button" size="sm" variant="outline" disabled={blocked} onClick={() => onInspect(other.shotId)}>查看原镜头</Button>}</div>}
    {(original || state.intentUncertain) && <div data-testid="shot-text-original-intent">
      <p role="status">{state.intentPhase === 'preparing' ? '正在持久保存原文字请求…' : state.intentPhase === 'executing' ? '正在核对并执行原文字请求…' : state.intentUncertain ? '原文字请求保存结果未知，新保存已暂停' : original?.outcome.status === 'applied' ? '原文字请求已确认应用' : original?.outcome.status === 'not_applied' ? '原文字请求已确认未应用' : '原文字请求结果待确认'}</p>
      {originalInput && <details data-testid="shot-text-intent-provenance"><summary>查看原请求与精确文字 · rev {originalRevision}</summary><p style={rawStyle}>请求 {originalInput.requestId}</p><pre style={{ ...rawStyle, fontSize: 'inherit' }}>{JSON.stringify(originalInput, null, 2)}</pre></details>}
      {(original?.outcome.status === 'pending' || state.intentUncertain) && <><p className="input-hint">恢复只使用原编号与原文字，可能首次执行尚未提交的文字保存；不会改用当前输入，也不会生成镜头。</p><Button type="button" size="sm" variant="outline" data-testid="recover-shot-text-request" disabled={blocked || Boolean(other)} onClick={() => { void controller.recover(); }}>确认恢复同一原文字请求</Button></>}
      {original?.outcome.status === 'not_applied' && !state.intentUncertain && <p className="input-hint">不会再次重试同一请求。当前输入仍保留，请核对后重新保存。</p>}
      {original?.outcome.status === 'applied' && !state.intentUncertain && <p className="input-hint">已刷新保存结果。恢复旧请求不会覆盖当前表单或继续生成。</p>}
    </div>}
    {state.intentError && <p role="alert">{state.intentError}</p>}
  </section>;
}

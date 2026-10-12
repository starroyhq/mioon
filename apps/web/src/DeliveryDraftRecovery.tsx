import React from 'react';
import { Button } from '@mioon/ui/components/button';
import RecoveryStorageDetails from './RecoveryStorageDetails.tsx';
import type { LocalDeliveryRenderInput } from '@mioon/contracts/local-delivery';
import type { LocalDeliveryController, LocalDeliveryState } from './local-delivery-state.ts';

export interface DeliveryDraftRecoveryProps {
  state: LocalDeliveryState;
  controller: LocalDeliveryController;
  disabled?: boolean;
}
const title = (value: string) => value === '' ? '留空，使用默认文件名' : value;
function frozenProfile(input: LocalDeliveryRenderInput): string {
  const settings = input.exportSettings;
  if (!settings) return '原有默认编码设置';
  const resolution = settings.resolution === 'native' ? '原时间线尺寸' : settings.resolution === 'short_360' ? '短边 360 像素' : '短边 1080 像素';
  const rate = settings.rateControl.mode === 'bitrate' ? `平均目标 ${settings.rateControl.targetKbps / 1000} Mb/s` : settings.rateControl.quality === 'compact' ? '紧凑 · CRF 28' : settings.rateControl.quality === 'high' ? '高画质 · CRF 18' : '标准 · CRF 23';
  return `MP4 · H.264 · ${resolution} · ${rate}`;
}

/** Passive right-dock presentation. Every write or execution has a named,
 * explicit control; rendering this panel never restores or submits anything. */
export default function DeliveryDraftRecovery({ state, controller, disabled = false }: DeliveryDraftRecoveryProps) {
  const blocked = disabled || state.busy;
  const unconfirmedPreparation = Boolean(state.retainedPreparation && state.intent?.intentId !== state.retainedPreparation.intentId);
  const savedTime = state.savedAt ? new Date(state.savedAt).toLocaleString('zh-CN') : '';
  const status = state.phase === 'unsupported' ? '恢复分支暂不支持本地交付草稿'
    : state.phase === 'loading' ? '正在核对本地交付草稿…'
      : state.autosavePaused ? '本地名称自动保存已暂停'
        : state.phase === 'saving' ? '正在保存本地名称…'
          : state.candidate ? '发现可恢复的成片名称'
            : state.phase === 'saved' ? `本地名称已保存${savedTime ? ` · ${savedTime}` : ''}`
              : state.phase === 'error' ? '本地名称未确认保存'
                : state.dirty ? '名称尚未确认保存到本地' : '本次名称可保存为本地草稿';
  const original = state.intent;
  const retained = state.retainedPreparation;
  const originalInput = original?.input ?? retained?.input;
  const originalTimelineId = original?.timelineId ?? retained?.timelineId;
  const originalRevision = original?.baseRevision ?? retained?.baseRevision;
  const intentLabel = state.intentPhase === 'preparing' ? '正在保存原导出请求，尚未确认可以提交'
    : state.intentPhase === 'executing' ? '正在核对并执行原导出请求…'
      : state.intentUncertain ? '原导出请求的保存结果待确认，新导出已暂停'
        : original?.outcome.status === 'pending' ? '已保存原导出请求，结果待确认'
          : original?.outcome.status === 'accepted' ? '原导出请求已确认接受'
            : original?.outcome.status === 'not_applied' ? '原导出请求已确认未应用' : '';
  return <section className="notice delivery-draft-recovery" data-testid="delivery-draft-recovery" aria-label="本地交付草稿与原导出请求">
    <p role="status" aria-live="polite" data-testid="delivery-draft-status">{status}</p>
    <RecoveryStorageDetails domain="delivery" />
    {state.phase === 'unsupported' && <p className="input-hint">此恢复分支不读写交付草稿或原请求记录。现有的明确确认本机导出流程仍可使用。</p>}
    {state.candidate && <div data-testid="delivery-draft-candidate">
      <p>已保存名称：<strong style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{title(state.candidate.raw.deliveryName)}</strong></p>
      <p className="input-hint">rev {state.candidate.baseRevision} · <time dateTime={state.candidate.updatedAt}>{new Date(state.candidate.updatedAt).toLocaleString('zh-CN')}</time></p>
      <details data-testid="delivery-draft-provenance"><summary>查看草稿来源</summary><p style={{ overflowWrap: 'anywhere' }}>原时间线 {state.candidate.timelineId} · 草稿 {state.candidate.draftId}</p></details>
      <div className="clip-form-actions">
        <Button type="button" size="sm" variant="outline" data-testid="restore-delivery-draft" disabled={blocked} onClick={() => controller.restore()}>恢复名称，替换当前输入</Button>
        <Button type="button" size="sm" variant="ghost" data-testid="keep-current-delivery-name" disabled={blocked || state.autosavePaused || unconfirmedPreparation} onClick={() => { void controller.keepCurrent(); }}>保留当前名称，替换已保存草稿</Button>
        <Button type="button" size="sm" variant="ghost" data-testid="discard-stored-delivery-draft" disabled={blocked || state.autosavePaused || unconfirmedPreparation} onClick={() => { void controller.discardStored(); }}>放弃已保存名称</Button>
      </div>
      <p className="input-hint">以上选择只处理名称草稿，不会删除或取消原导出请求。</p>
    </div>}
    {state.baselineConflict && state.baseline && <div className="notice warning" data-testid="delivery-draft-baseline-conflict">
      <p>此名称来自原时间线的 rev {state.baseline.baseRevision}，与当前时间线不同。原版本保留，不能直接用于当前检查。</p>
      <Button type="button" size="sm" variant="outline" data-testid="use-current-delivery-baseline" disabled={blocked || state.autosavePaused || unconfirmedPreparation} onClick={() => { void controller.keepCurrent(); }}>明确改用于当前时间线，再检查</Button>
    </div>}
    {state.draftFailure && <p className="input-hint" data-testid="delivery-draft-failure-kind">{state.draftFailure.kind === 'refused' ? state.draftFailure.code === 'LOCAL_DELIVERY_LOCAL_VALIDATION' ? '本地输入未通过校验，尚未发送保存请求。' : state.draftFailure.code === 'LOCAL_DELIVERY_LOCAL_RETRY_LIMIT' ? '当前会话的待确认名称已达上限，尚未发送本次保存请求。' : state.draftFailure.code === 'LOCAL_DELIVERY_CAPACITY' ? '交付记录已达本工作区 128 个项目槽位上限；已有记录不会自动删除。' : '服务明确拒绝了本次名称保存。' : state.draftFailure.kind === 'conflict' ? '本地草稿版本或服务身份发生冲突。' : '本次保存结果未知；较晚完成的写入仍可能存在。'} 重新核对只读取记录，不会自动恢复写入。</p>}
    {unconfirmedPreparation && <p className="input-hint">原请求保存尚待确认，后续名称暂不写入本地。请先明确恢复同一原请求；当前新输入仍保留。</p>}
    {state.retainedDraftWrite && state.autosavePaused && <p className="input-hint" data-testid="delivery-draft-retry-original">待确认保存的原名称：<strong style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{title(state.retainedDraftWrite.raw.deliveryName)}</strong> · rev {state.retainedDraftWrite.baseRevision}。重试保留同一草稿编号与保存版本，不会改用较新的当前输入。</p>}
    {state.autosavePaused && state.draftRetry && <Button type="button" size="sm" variant="outline" data-testid="retry-delivery-name-save" disabled={blocked || state.phase === 'saving' || unconfirmedPreparation} onClick={() => { void controller.retryDraftSave(); }}>{state.draftRetry === 'same' ? '重试保存同一名称' : '明确保存当前名称'}</Button>}
    {state.autosavePaused && state.draftFailure && !state.draftRetry && <p className="input-hint">原删除操作尚不能安全重试。请重新核对本地记录；当前输入仍保留，不会自动重建或覆盖草稿。</p>}
    {state.draftError && <p role="alert" data-testid="delivery-draft-error">{state.draftError}</p>}
    {state.draftFailure?.kind === 'refused' && !state.leaveWithoutSaving && <Button type="button" size="sm" variant="outline" data-testid="leave-without-saving-delivery-name" disabled={blocked || state.phase === 'saving'} onClick={() => controller.allowLeaveWithoutSaving()}>允许离开，不保存当前名称</Button>}
    {(state.phase === 'error' || state.autosavePaused || state.intentUncertain || state.intentFailure) && <Button type="button" size="sm" variant="ghost" data-testid="reload-local-delivery" disabled={blocked} onClick={() => { void controller.load(); }}>重新核对本地记录</Button>}
    {(original || state.intentUncertain || state.intentPhase === 'preparing') && <div data-testid="delivery-original-intent">
      <p role="status" aria-live="polite">{intentLabel}</p>
      {originalInput && <>
        <p>原请求名称：<strong style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{title(originalInput.deliveryName ?? '')}</strong></p>
        <p className="input-hint">原时间线 rev {originalRevision} · {frozenProfile(originalInput)}</p>
        <details data-testid="delivery-intent-provenance"><summary>查看原请求与完整参数</summary><p style={{ overflowWrap: 'anywhere' }}>请求 {originalInput.requestId} · 原时间线 {originalTimelineId}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 'inherit' }}>{JSON.stringify(originalInput, null, 2)}</pre></details>
        {(original?.outcome.status === 'pending' || state.intentUncertain) && <p className="input-hint">恢复只使用上方原编号、名称与已保存参数，可能首次执行之前尚未提交的导出。不会改用当前名称或输出规格。</p>}
        {original?.outcome.status === 'accepted' && !state.intentUncertain && <p className="input-hint">原请求回执已确认接受。是否完成渲染，请查看导出记录。</p>}
        {original?.outcome.status === 'not_applied' && !state.intentUncertain && <p className="input-hint">原请求已确认未应用，不会再次重试同一请求。请核对当前名称后重新检查。</p>}
        {(original?.outcome.status === 'pending' || state.intentUncertain) && <Button type="button" size="sm" variant="outline" data-testid="recover-original-delivery" disabled={blocked} onClick={() => { void controller.recover(); }}>确认恢复同一原请求</Button>}
      </>}
      {state.intentUncertain && !original && <p className="input-hint">尚未收到原请求的持久保存确认；即使读取结果为空，也不能认定先前保存未发生。明确恢复会用同一编号和原参数再次确认保存，再尝试原导出。</p>}
    </div>}
    {state.intentFailure && <p className="input-hint" data-testid="delivery-intent-failure-kind">{state.intentFailure.kind === 'refused' && !state.pending ? '服务明确拒绝了本次原请求保存，尚未开始导出。' : state.intentFailure.kind === 'conflict' ? '原请求记录或服务身份冲突；已阻止新导出。' : '原请求结果仍待核对，不能当作失败后重新创建。'}</p>}
    {state.intentError && <p role="alert" data-testid="delivery-intent-error">{state.intentError}</p>}
  </section>;
}

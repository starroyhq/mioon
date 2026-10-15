import LookPackControls, { LookPackDetails } from './LookPackControls.tsx';
import React, { useLayoutEffect, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { Separator } from '@mioon/ui/components/separator';
import type { ClipColour } from '../../../packages/contracts/src/timeline-colour.ts';
import { createClipDraftClient } from './clip-draft-client.ts';
import { clipLutSourceIssue, createClipLutController } from './clip-lut-state.ts';
import type { ClipLutContext, ClipLutController, ClipLutRpc, ClipLutState } from './clip-lut-state.ts';

type SelectProps = { id: string; 'data-testid': string; value: string; disabled?: boolean; children: ReactNode; onChange: (event: { target: { value: string } }) => void };
export interface ClipLutControlsProps {
  context: ClipLutContext; kind: string; restored?: boolean;
  onEdit: (key: 'colour', value: ClipColour | null) => void; rpc: ClipLutRpc; Select: ComponentType<SelectProps>;
}
export default function ClipLutControls({ context, kind, restored = false, onEdit, rpc, Select }: ClipLutControlsProps) {
  const latest = useRef({ context, onEdit, rpc }); latest.current = { context, onEdit, rpc };
  const [observed, setObserved] = useState<ClipLutState | null>(null), ref = useRef<ClipLutController | null>(null);
  if (!ref.current) ref.current = createClipLutController({ getContext: () => latest.current.context, readWorkspace: key => createClipDraftClient().get(key),
    rpc: (operation, input, options) => latest.current.rpc(operation, input, options), edit: value => latest.current.onEdit('colour', value), onChange: setObserved });
  const controller = ref.current;
  const identity = JSON.stringify([context.scope, context.projectId, context.timelineId, context.clipId, context.assetId, context.assetSha256]);
  useLayoutEffect(() => { controller.activate(); controller.refresh(); return () => controller.dispose(); }, [controller]);
  useLayoutEffect(() => { controller.refresh(); }, [controller, identity]);
  const state = observed ?? controller.getState(), colour = context.colour, blocked = context.blocked;
  if (kind === 'audio') return null;
  if (kind !== 'video' && kind !== 'image') return null;
  const image = kind === 'image', imageInspection = state.inspection && 'kind' in state.inspection ? state.inspection : null, videoInspection = state.inspection && !('kind' in state.inspection) ? state.inspection : null;
  const issue = clipLutSourceIssue(state.inspection, state.range), source = colour?.source, look = colour?.look;
  const importRecord = state.importRecord;
  const importUnavailable = state.recoveryPhase !== 'ready' || Boolean(state.recovery) || state.importing;
  const resourceName = look && state.resources.find(item => item.id === look.resourceId)?.name;
  const selectedLook = look && state.selected?.id === look.resourceId;
  return <section data-testid="clip-lut-controls" aria-labelledby="clip-lut-title">
    <Separator className="section-divider" />
    <div className="section-heading"><span id="clip-lut-title">Rec.709 SDR · 创意 LUT</span></div>
    <p className="input-hint" data-testid="clip-lut-render-disclosure">保存片段后，重新渲染的时间线预览与导出才会应用。源素材快速查看始终是原始、未调色画面。</p>
    {!colour && <p className="notice warning" data-testid="clip-lut-adoption-warning">当前保持原有色彩路径，不会自动迁移。明确启用后，整条时间线使用 Rec.709 SDR 流程：所有可见视频都必须逐一确认 Rec.709 解释，图片必须是已检查并明确声明为 sRGB 的受支持 PNG 或基线 JFIF JPEG。HDR / Log、ICC、EXIF（包括旋转信息）、渐进式 JPEG 与技术转换 LUT 不在此范围内。</p>}
    {colour && !source && <p className="notice warning" role="alert" data-testid="clip-lut-reconfirm-source">来源已替换，色彩解释已失效。LUT、启用状态与强度保留；请重新检查并确认新来源，否则不能渲染。</p>}
    {source && <p className="input-hint" data-testid="clip-lut-source-confirmed">{'evidence' in source ? `已声明：sRGB ${source.evidence.profileId === 'jfif-ycbcr8-srgb-v1' ? 'JFIF JPEG' : 'PNG'} · ${source.evidence.width} × ${source.evidence.height} · ${source.evidence.alphaMode === 'straight' ? '透明通道独立保留' : '不透明'}` : `已声明：Rec.709 SDR · ${source.range === 'limited' ? 'Limited' : 'Full'} · 视频流 ${source.streamIndex}`}。这是用户解释，文件检查不会自动替你声明。</p>}
    {image && <p className="input-hint" data-testid="clip-image-colour-disclosure">JPEG 仅支持无 EXIF、无 ICC 的基线 JFIF，标记本身不代表 sRGB。图片按 sRGB 解释，并转换到 Rec.709 / Gamma 2.4 相对参考显示（黑位 0、白位 1），再应用创意 LUT。透明度不参与调色，预乘后以双线性方式缩放。同一时段最多显示 2 个受管理的图片片段（PNG 与 JPEG 合计），可错开放置更多图片。当前合成是 8 位编码 RGB，不是线性光或 HDR；实际预览观感受播放器、系统和显示器设置影响。</p>}
    {restored && <p className="notice warning" role="status">恢复工作区中这里只显示已保存设置，不提供 LUT 导入或修改。</p>}
    {!state.opened ? <Button variant="outline" size="sm" type="button" data-testid="open-clip-lut" disabled={blocked} onClick={() => controller.open()}>{colour ? '检查来源与调整 LUT' : '检查并启用 Rec.709 SDR'}</Button> : <>
      <fieldset disabled={blocked} style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field-label">1. 明确源素材解释</legend>
        <Button variant="outline" size="sm" type="button" data-testid="inspect-clip-colour-source" disabled={state.sourcePhase === 'loading'} onClick={() => { void controller.inspectSource(); }}>{state.sourcePhase === 'loading' ? '正在检查来源…' : '重新检查当前来源'}</Button>
        {videoInspection && <p className="input-hint" data-testid="clip-lut-source-evidence">文件标签：原色 {videoInspection.evidence.primaries ?? '未标记'} · 转换 {videoInspection.evidence.transfer ?? '未标记'} · 矩阵 {videoInspection.evidence.matrix ?? '未标记'} · 范围 {videoInspection.evidence.range ?? '未标记'} · 像素 {videoInspection.evidence.pixelFormat ?? '未知'}{videoInspection.evidence.hdrMetadata ? ' · 含 HDR 元数据' : ''}</p>}
        {imageInspection && <p className="input-hint" data-testid="clip-image-source-evidence">{imageInspection.evidence.profileId === 'jfif-ycbcr8-srgb-v1' ? '已核验 JFIF JPEG 原始字节、完整编码结构与有边界的 RGB24 解码' : '已核验 PNG 原始字节与结构'}：{imageInspection.evidence.width} × {imageInspection.evidence.height} · 8 位 · {imageInspection.evidence.alphaMode === 'straight' ? 'Straight alpha' : '无透明通道'} · {imageInspection.evidence.colourTag === 'srgb' ? 'sRGB 标签' : '没有 sRGB 标签，必须由你明确解释'}。当前上限为 2,073,600 像素、单边 4096、文件 32 MiB。ICC / P3 / HDR、动画、16 位及未支持元数据不会被自动去除。</p>}
        {state.sourceError && <p className="notice warning" role="alert">{state.sourceError}</p>}
        {!image && <><Label className="field-label" htmlFor="clip-lut-source-range">源素材范围（必须明确选择）</Label>
        <Select id="clip-lut-source-range" data-testid="clip-lut-source-range" value={state.range} disabled={state.sourcePhase !== 'ready' || state.inspection?.status === 'unsupported'} onChange={event => controller.chooseRange(event.target.value)}>
          <option value="">请选择范围</option><option value="limited">Limited · 视频范围</option><option value="full">Full · 全范围</option>
        </Select></>}
        {state.inspection && issue && <p className="notice warning" role="status" data-testid="clip-lut-source-issue">{issue}</p>}
        <label className="field-label"><input type="checkbox" data-testid="clip-lut-source-declaration" checked={state.sourceDeclared} disabled={Boolean(issue)} onChange={event => controller.declareSource(event.target.checked)} />{image ? '我确认这张图片按 sRGB 解释；没有标签也不是自动推断，不把 ICC / P3 / HDR 当作 sRGB。' : '我确认此来源是 Rec.709 SDR，并确认以上范围；不把 HDR / Log 作为 SDR 解释。'}</label>
        <Button size="sm" type="button" data-testid="confirm-clip-colour-source" disabled={Boolean(issue) || !state.sourceDeclared || state.sourcePhase !== 'ready'} onClick={() => controller.confirmSource()}>{colour ? '将来源确认写入片段草稿' : '明确启用并写入片段草稿'}</Button>
      </fieldset>
      <fieldset disabled={blocked} style={{ border: 0, padding: 0, margin: '16px 0 0' }}>
        <legend className="field-label">2. 选择 Rec.709 → Rec.709 创意外观</legend>
        <p className="input-hint">资源格式验证不代表色彩适用性。只使用输入、输出均为 Rec.709 SDR 的创意 LUT，不使用 Log 转换或 HDR 色调映射 LUT。</p>
        <p className="input-hint" data-testid="clip-lut-domain-disclosure">创意 LUT 会将归一化 RGB 中小于 0 或大于 1 的值裁到 0–1 范围，不适合保留 HDR / Log 高光细节。关闭 LUT 或设为 0% 只绕过创意外观，已启用的 Rec.709 SDR 转换仍会执行。</p>
        <LookPackControls scope={identity} disabled={blocked || importUnavailable} adopt={file => controller.importFile(file, { lookPackConfirmed: true })} />
        <Label className="field-label" htmlFor="clip-lut-file">导入项目 LUT（.cube，最多 7 MiB）</Label>
        <Input id="clip-lut-file" data-testid="clip-lut-file" type="file" accept=".cube" disabled={importUnavailable} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void controller.importFile(file); }} />
        {state.importing && <p className="input-hint" role="status">正在读取或导入所选文件…</p>}
        {state.importError && <p className="notice warning" role="alert">{state.importError}</p>}
        {importRecord?.phase === 'imported' && <p className="notice" role="status" data-testid="clip-lut-import-success">资源“{importRecord.resource?.name}”已导入项目，尚未应用或保存到片段。请在下方选择、声明用途并保存片段。</p>}
        {importRecord?.phase === 'rejected' && <p className="notice warning" role="alert">文件未导入：{importRecord.error}</p>}
        <p className="input-hint" data-testid="clip-lut-recovery-disclosure">导入前会在当前站点的浏览器存储中保存原请求编号、文件名、大小、SHA-256 与项目/工作区标识，不保存 LUT 文件内容或路径。在同一站点地址关闭重开后，可重新选择同一文件，再明确重试原请求；不会自动导入或应用。清除浏览器数据或更换站点地址会丢失这条恢复记录。桌面应用完全退出后本地地址可能变化，暂不能保证跨应用重启找回。</p>
        {state.recoveryPhase === 'loading' && <p className="input-hint" role="status">正在核对工作区与原请求恢复记录…</p>}
        {state.recoveryError && <p className="notice warning" role="alert" data-testid="clip-lut-recovery-error">{state.recoveryError}</p>}
        {(state.recoveryPhase === 'error' || state.recovery) && <Button variant="outline" size="sm" type="button" data-testid="check-clip-lut-recovery" disabled={state.importing} onClick={() => { void controller.checkRecovery(); }}>重新检查恢复记录</Button>}
        {state.recovery && <>
          <p className="notice warning" role="status" data-testid="clip-lut-import-unknown">原导入请求待核对：{state.recovery.name} · {state.recovery.sizeBytes} 字节。{importRecord?.error} 不会创建新编号；先恢复这一条请求，再导入其他文件。</p>
          {!importRecord && <><Label className="field-label" htmlFor="clip-lut-reselect">重新选择原 .cube 文件（只核验，不会提交）</Label><Input id="clip-lut-reselect" data-testid="clip-lut-reselect" type="file" accept=".cube" disabled={state.importing || state.recoveryPhase !== 'ready'} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void controller.reselectImportFile(file); }} /></>}
          {importRecord?.phase === 'unknown' && <Button variant="outline" size="sm" type="button" data-testid="retry-clip-lut-import" disabled={state.importing || state.recoveryPhase !== 'ready'} onClick={() => { void controller.retryImport(); }}>用核验后的原文件与原编号重试</Button>}
          {importRecord && ['imported', 'rejected'].includes(importRecord.phase) && <Button variant="outline" size="sm" type="button" data-testid="clear-confirmed-clip-lut-recovery" disabled={state.importing} onClick={() => { void controller.clearConfirmedRecovery(); }}>清理已确认请求的恢复记录</Button>}
        </>}
        <Label className="field-label" htmlFor="clip-lut-resource">项目中的 LUT</Label>
        <Select id="clip-lut-resource" data-testid="clip-lut-resource" value={state.selectedId} disabled={state.listPhase === 'loading'} onChange={event => { void controller.selectResource(event.target.value); }}>
          <option value="">请选择 LUT</option>{state.resources.map(resource => <option key={resource.id} value={resource.id}>{resource.name} · {resource.metadata.size}³</option>)}
        </Select>
        <Button variant="ghost" size="sm" type="button" disabled={state.listPhase === 'loading'} onClick={() => { void controller.loadResources(); }}>刷新列表</Button>
        {state.nextAfter && <Button variant="ghost" size="sm" type="button" data-testid="clip-lut-more" disabled={state.listPhase === 'loading'} onClick={() => { void controller.loadResources(true); }}>加载更多</Button>}
        {state.listError && <p className="notice warning" role="alert">{state.listError}</p>}
        {state.resourcePhase === 'loading' && <p role="status" className="input-hint">正在核验所选 LUT…</p>}
        {state.resourceError && <p className="notice warning" role="alert">{state.resourceError}</p>}
        {state.selected && state.resourcePhase === 'ready' && <>
          <Button type="button" variant="ghost" size="sm" data-testid="inspect-project-look-pack" disabled={state.packPhase === 'loading'} onClick={() => { void controller.inspectSelectedPack(); }}>{state.packPhase === 'loading' ? '正在核验包声明…' : '查看此项目 LUT 的数据包声明'}</Button>
          {state.packPhase === 'ready' && !state.pack && <p className="input-hint" data-testid="project-lut-not-pack">这是普通 Cube 资源，没有单 Look 数据包声明。</p>}
          {state.pack && <LookPackDetails value={state.pack} />}
          {state.packError && <p className="notice warning" role="alert">{state.packError}</p>}
        </>}
        <label className="field-label"><input type="checkbox" data-testid="clip-lut-look-declaration" checked={state.lookDeclared} disabled={!state.selected || state.resourcePhase !== 'ready'} onChange={event => controller.declareLook(event.target.checked)} />我确认所选 LUT 是 Rec.709 SDR → Rec.709 SDR 创意外观，不是技术转换。</label>
        <Button size="sm" type="button" data-testid="apply-clip-lut" disabled={!source || source.assetSha256 !== context.assetSha256 || !state.selected || !state.lookDeclared || state.resourcePhase !== 'ready'} onClick={() => controller.applyLook()}>将所选 LUT 写入片段草稿</Button>
        {look && <>
          <p className="input-hint" data-testid="clip-lut-bound">当前片段外观：{resourceName || (selectedLook && state.selected?.name) || look.resourceId}</p>
          <label className="field-label"><input type="checkbox" data-testid="clip-lut-enabled" checked={look.enabled} onChange={event => controller.changeLook({ enabled: event.target.checked })} />启用此 LUT</label>
          <Label className="field-label" htmlFor="clip-lut-strength">LUT 强度 · {Math.round(look.strength * 100)}%</Label>
          <Input id="clip-lut-strength" data-testid="clip-lut-strength" type="range" min={0} max={100} step={1} value={look.strength * 100} onChange={event => controller.changeLook({ strength: Number(event.target.value) / 100 })} />
          <p className="input-hint">0% 为无创意外观，100% 为完整 LUT；关闭 LUT 不会取消已确认的 SDR 来源流程。</p>
          <Button variant="ghost" size="sm" type="button" data-testid="remove-clip-lut" onClick={() => controller.removeLook()}>从片段移除 LUT（保留项目资源）</Button>
        </>}
        {colour && <Button variant="ghost" size="sm" type="button" data-testid="disable-clip-colour" onClick={() => controller.disableColour()}>此片段返回原有色彩路径</Button>}
        <p className="input-hint" data-testid="clip-lut-save-reminder">所有片段设置仍是草稿。使用下方“保存片段”提交；保存后的调整可通过时间线撤销恢复。若其他片段仍启用 SDR，返回原有路径的可见片段会阻止整条时间线渲染。</p>
      </fieldset>
    </>}
  </section>;
}

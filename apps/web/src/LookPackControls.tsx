import React, { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import type { LookPackInspection } from '../../../packages/contracts/src/look-pack.ts';
import { createLookPackIntake } from './look-pack-intake.ts';
import type { LookPackFile, LookPackIntakeState } from './look-pack-intake.ts';

export function LookPackDetails({ value }: { value: LookPackInspection }) {
  const manifest = value.manifest;
  return <div className="look-pack-details" data-testid="look-pack-details">
    <p><strong>{manifest.title}</strong> · {manifest.version}</p>
    <p className="input-hint">包 ID：{manifest.id}<br />声明发布者：{manifest.publisher.name}（{manifest.publisher.id}）</p>
    <p className="input-hint">1 个创意 Look · Rec.709 SDR → Rec.709 SDR<br />Cube 正文：{manifest.asset.sizeBytes} 字节 · SHA-256：<span style={{ overflowWrap: 'anywhere' }}>{manifest.asset.sha256}</span></p>
    <p className="input-hint" style={{ overflowWrap: 'anywhere' }}>声明来源（仅文字，不自动访问）：{manifest.provenance.url}</p>
    <Label className="field-label">声明许可：{manifest.license.identifier}</Label>
    <p className="input-hint" data-testid="look-pack-license" style={{ maxHeight: 160, overflow: 'auto', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{manifest.license.text}</p>
    <p className="notice warning" data-testid="look-pack-claims-disclosure">已校验包结构和字节完整性；作者、来源、许可与色彩适用性是包内声明，未经 Mioon 认证。请自行确认有权使用。没有脚本、模型或运行时需要安装。</p>
  </div>;
}

export default function LookPackControls({ scope, disabled, adopt }: {
  scope: string; disabled: boolean; adopt: (file: LookPackFile) => Promise<boolean>;
}) {
  const latest = useRef({ scope, disabled, adopt }); latest.current = { scope, disabled, adopt };
  const [observed, setObserved] = useState<LookPackIntakeState | null>(null);
  const ref = useRef<ReturnType<typeof createLookPackIntake> | null>(null);
  if (!ref.current) ref.current = createLookPackIntake({ getScope: () => latest.current.scope, isBlocked: () => latest.current.disabled,
    adopt: file => latest.current.adopt(file), onChange: setObserved });
  const controller = ref.current, state = observed ?? controller.getState();
  useLayoutEffect(() => { controller.activate(); controller.refresh(); return () => controller.dispose(); }, [controller]);
  useLayoutEffect(() => { controller.refresh(); }, [controller, scope]);
  const busy = state.phase === 'reading' || state.phase === 'adopting';
  return <section data-testid="look-pack-controls" aria-label="单 Look 数据包" style={{ margin: '16px 0', padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
    <Label className="field-label" htmlFor="look-pack-file">预览单 Look 数据包（.mioon-look.cube，最多 7 MiB）</Label>
    <p className="input-hint">按需选取一个 Look，不安装预设库。预览只读取所选文件，不导入、不应用、不访问声明来源。普通 .cube 仍可用下方入口。</p>
    <Input id="look-pack-file" data-testid="look-pack-file" type="file" accept=".mioon-look.cube" disabled={disabled || state.phase === 'adopting'} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void controller.preview(file); }} />
    {state.phase === 'reading' && <p className="input-hint" role="status">正在校验数据包和 Cube 正文…</p>}
    {state.inspection && <LookPackDetails value={state.inspection} />}
    {state.phase === 'ready' && <>
      <label className="field-label"><input type="checkbox" data-testid="look-pack-acknowledge" disabled={disabled} checked={state.acknowledged} onChange={event => controller.acknowledge(event.target.checked)} />我已查看声明许可，并确认有权将这个 Look 复制到当前项目。</label>
      <Button type="button" size="sm" data-testid="adopt-look-pack" disabled={disabled || !state.acknowledged} onClick={() => { void controller.adopt(); }}>采用到项目 LUT（不自动应用）</Button>
    </>}
    {state.phase === 'adopting' && <p className="input-hint" role="status">正在采用到当前项目，请等待原请求结果…</p>}
    {state.phase === 'adopted' && <p className="notice" role="status" data-testid="look-pack-adopted">已按原字节采用。源数据包移走后，项目仍保有 Look 与包内声明。请在项目 LUT 列表选择，再声明用途并保存片段。</p>}
    {state.error && <p className="notice warning" role="alert" data-testid="look-pack-error">{state.error}</p>}
    {state.phase !== 'idle' && <Button type="button" variant="ghost" size="sm" data-testid="cancel-look-pack" disabled={state.phase === 'adopting'} onClick={() => controller.cancel()}>{busy ? '取消预览' : '关闭包预览'}</Button>}
    <p className="input-hint">整份文件与来源/许可声明随项目 LUT 保存并参与现有备份。采用不会接受新的服务协议，也不会证明第三方拥有授权；不支持批量目录、安装器或可执行插件。</p>
  </section>;
}

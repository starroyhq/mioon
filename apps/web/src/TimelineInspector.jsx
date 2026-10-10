import { Separator } from '@mioon/ui/components/separator';
import { Badge } from '@mioon/ui/components/badge';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { ScrollArea } from '@mioon/ui/components/scroll-area';
import { WorkbenchSelect } from './WorkspaceControls.jsx';
import { assetKind, framesLabel } from './Timeline.jsx';
import Icon from './icons.jsx';
import { sourceFrameCount } from '@mioon/contracts';
import ClipAudioControls from './ClipAudioControls.jsx';
import { clipAudioDraft, clipAudioIssue, clipAudioPatch } from './clip-audio-state.js';
import ClipSourceReplacement from './ClipSourceReplacement.jsx';

const editable = c => ({ name: c.name || '', trackId: c.trackId, startFrame: c.startFrame, durationFrames: c.durationFrames, sourceInFrame: c.sourceInFrame, rect: { ...c.rect }, gain: c.gain, ...clipAudioDraft(c) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export default function TimelineInspector({ clip, timeline, asset, onSave, onRemove, onDirtyChange, busy, onPreview, onReturnToSource, sourceDescription, replacementContext, onReplaceSource, onOpenRequests }) {
  const confirm = useConfirmation();
  const [draft, setDraft] = useState(() => editable(clip));
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const [baseRevision, setBaseRevision] = useState(timeline.revision);
  const [conflict, setConflict] = useState(false);
  const baseline = useRef(editable(clip));
  const mounted = useRef(false);
  const editSerial = useRef(0);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const kind = assetKind(asset);
  const audioIssue = clipAudioIssue(draft, asset);
  useEffect(() => { const latest = editable(clip); if (!dirty || same(latest, baseline.current)) { if (!dirty) { setDraft(latest); baseline.current = latest; } setBaseRevision(timeline.revision); setConflict(false); } else if (baseRevision !== timeline.revision) setConflict(true); }, [timeline.revision, clip]);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  function edit(key, value) { editSerial.current++; dirtyRef.current = true; setDraft(d => ({ ...d, [key]: value })); setDirty(true); }
  function reset() { editSerial.current++; dirtyRef.current = false; const next = editable(clip); setDraft(next); baseline.current = next; setBaseRevision(timeline.revision); setDirty(false); setConflict(false); }
  async function save(e) {
    e.preventDefault();
    if (!mounted.current || busy || conflict || audioIssue) return;
    const submittedSerial = editSerial.current;
    const patch = { ...draft, ...clipAudioPatch(draft), startFrame: Number(draft.startFrame), durationFrames: Number(draft.durationFrames), sourceInFrame: Number(draft.sourceInFrame), gain: Number(draft.gain), rect: Object.fromEntries(Object.entries(draft.rect).map(([key, value]) => [key, Number(value)])) };
    const next = await onSave(clip.id, patch, baseRevision);
    if (!mounted.current || !next) return;
    const saved = next.clips.find(item => item.id === clip.id);
    if (!saved) return;
    baseline.current = editable(saved);
    setBaseRevision(next.revision); setConflict(false);
    if (editSerial.current === submittedSerial) {
      setDraft(baseline.current); setDirty(false);
    } else setDirty(true);
  }
  return <aside className="inspector clip-inspector" data-testid="clip-inspector"><header className="inspector-heading"><Icon name="layers" /><span>时间线片段</span><Badge className="small-badge accent">固定素材</Badge></header><ScrollArea style={{ flex: 1, minHeight: 0 }}><form className="inspector-scroll clip-form" style={{ overflow: 'visible' }} onSubmit={save}><div className="section-eyebrow">{kind === 'audio' ? 'AUDIO' : 'VISUAL'} CLIP <Badge className={`small-badge ${dirty ? 'warn' : 'neutral'}`}>{dirty ? '未保存' : '已同步'}</Badge></div><Label className="field-label" htmlFor="clip-name">片段名称</Label><Input id="clip-name" value={draft.name} maxLength={150} onChange={e => edit('name', e.target.value)} /><div className="clip-source"><span>来源已冻结</span><strong title={asset?.name}>{asset?.name || clip.assetId}</strong><p>后续生成或切换镜头版本，不会替换此片段。</p>{sourceDescription && <p className="clip-source-description" data-testid="clip-source-description">{sourceDescription}</p>}{onReturnToSource && <Button variant="outline" size="sm" type="button" className="button small return-to-source" data-testid="return-to-source" disabled={busy} onClick={onReturnToSource}><Icon name="left" size={13} />返回来源</Button>}<Button variant="ghost" size="sm" type="button" className="text-button" data-testid="preview-clip-source" onClick={onPreview}><Icon name="play" size={13} />在主工作区查看源素材</Button></div>{onReplaceSource && <ClipSourceReplacement context={{ ...replacementContext, timeline, clipId: clip.id, dirty }} getDirty={() => dirtyRef.current} onReplace={onReplaceSource} onOpenRequests={onOpenRequests} />}<Label className="field-label" htmlFor="clip-track">所在轨道</Label><WorkbenchSelect id="clip-track" data-testid="clip-track" value={draft.trackId} onChange={e => edit('trackId', e.target.value)}>{timeline.tracks.filter(t => t.kind === (kind === 'audio' ? 'audio' : 'video')).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</WorkbenchSelect><div className="field-row"><div><Label className="field-label" htmlFor="clip-start">开始帧</Label><Input id="clip-start" data-testid="clip-start" type="number" min="0" max="17999" step="1" required value={draft.startFrame} onChange={e => edit('startFrame', e.target.value)} /></div><div><Label className="field-label" htmlFor="clip-duration">持续帧数</Label><Input id="clip-duration" data-testid="clip-duration" type="number" min="1" max="18000" step="1" required value={draft.durationFrames} onChange={e => edit('durationFrames', e.target.value)} /></div></div><p className="input-hint">30 帧 = 1 秒 · 时间线 {framesLabel(Number(draft.startFrame) || 0)} → {framesLabel((Number(draft.startFrame) || 0) + (Number(draft.durationFrames) || 0))}</p><Label className="field-label" htmlFor="clip-source-in">素材入点（源素材帧）</Label><Input id="clip-source-in" data-testid="clip-source-in" type="number" min="0" max={kind === 'image' ? 0 : sourceFrameCount(asset?.duration) === null ? undefined : Math.max(0, sourceFrameCount(asset.duration) - 1)} step="1" required disabled={kind === 'image'} value={draft.sourceInFrame} onChange={e => edit('sourceInFrame', e.target.value)} /><p className="input-hint">{kind === 'image' ? '静态图片入点固定为 0。' : `源素材 ${asset?.duration ? Number(asset.duration).toFixed(2) + ' 秒' : ''}；入点与时间线开始帧各自独立。`}</p>{kind !== 'audio' && <><Separator className="section-divider" /><div className="section-heading"><span>画面位置与尺寸</span><span>720 × 1280</span></div><div className="rect-grid">{[['x','X'],['y','Y'],['width','宽'],['height','高']].map(([key, label]) => <div key={key}><Label className="field-label" htmlFor={`clip-${key}`}>{label}（px）</Label><Input id={`clip-${key}`} data-testid={`clip-${key}`} type="number" min={['x','y'].includes(key) ? 0 : 2} max={['x','width'].includes(key) ? 720 : 1280} step="2" required value={draft.rect[key]} onChange={e => edit('rect', { ...draft.rect, [key]: e.target.value })} /></div>)}</div><p className="input-hint">偶数像素，画面完整包含于矩形内。矩形留白透明，会显示下层；无任何画面的时间段为黑色。</p></>}<ClipAudioControls asset={asset} kind={kind} draft={draft} onEdit={edit} issue={audioIssue} />{conflict && <div className="notice warning" role="alert">此片段已在别处更新。你的输入仍保留；请确认后载入最新内容。<Button variant="ghost" size="sm" type="button" onClick={reset}>载入最新片段</Button></div>}<div className="clip-form-actions"><Button size="sm" className="button primary full" data-testid="save-clip" disabled={!dirty || busy || conflict || Boolean(audioIssue)} type="submit"><Icon name="check" size={15} />保存片段</Button>{dirty && <Button variant="ghost" size="sm" type="button" className="text-button" onClick={reset}>放弃修改</Button>}<Button variant="ghost" size="sm" type="button" className="text-button danger-text" data-testid="remove-clip" disabled={busy} onClick={async () => { if (await confirm('从时间线移除此片段？原素材与镜头版本会保留。') && mounted.current) onRemove(clip.id); }}>从时间线移除片段</Button></div></form></ScrollArea></aside>;
}

import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useEffect, useRef, useState } from 'react';
import type { ReactElement, PointerEvent as ReactPointerEvent } from 'react';
import { message } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@mioon/ui/components/dialog';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { Slider } from '@mioon/ui/components/slider';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { WorkbenchTabs } from '@mioon/ui/components/workbench-controls';
import { ArrowDown, ArrowUp, Check, CircleAlert, CircleCheck, Replace, RotateCcw, Sparkles, User, X } from '@mioon/ui/components/workbench-icons';
import { WorkbenchSelect } from './WorkspaceControls.tsx';
import { assetUrl } from './api.ts';
import { SubjectImage } from './SubjectLibrary.tsx';
import type { SubjectAssetView } from './SubjectLibrary.tsx';
import { subjectAngleDescriptor, subjectKindDescriptor, subjectVariantTagParts } from './subject-state.ts';
import { subjectVariantModels, subjectVariantOutputSize, subjectVariantSourceIssue } from './subject-variant-state.ts';
import type { SubjectVariantController, SubjectVariantKind, SubjectVariantModel, SubjectVariantProviderId, SubjectVariantSourceIssue } from './subject-variant-state.ts';
import { SUBJECT_VARIANT_LIMITS } from '@mioon/contracts';
import type { SubjectVariantSpec } from '@mioon/contracts';
import type { SubjectResponse, SubjectVersionResponse } from '../../../packages/contracts/src/subjects.ts';
import './subject-variants.css';

type Position = 'front' | 'front-left' | 'left' | 'back-left' | 'back' | 'back-right' | 'right' | 'front-right' | 'high' | 'low';
type Focal = 'standard' | 'wide';
type Quality = 'soft' | 'hard' | 'back';
export interface AngleChoice { position: Position; focal: Focal }
export interface LightChoice { azimuth: number; elevation: number; quality: Quality; kelvin: number }
// Seen from above with the subject facing the top: front is at the top, and the
// ring runs clockwise to the subject's right.
export const SUBJECT_VARIANT_RING: readonly (readonly [Position, number])[] = Object.freeze([['front', 0], ['front-right', 45], ['right', 90], ['back-right', 135], ['back', 180], ['back-left', 225], ['left', 270], ['front-left', 315]] as const);
export const SUBJECT_VARIANT_HEIGHTS: readonly Position[] = Object.freeze(['high', 'low'] as const);
export const SUBJECT_VARIANT_LIGHT_DEFAULT: LightChoice = Object.freeze({ azimuth: 45, elevation: 30, quality: 'soft', kelvin: 4800 });
const QUALITIES: readonly Quality[] = ['soft', 'hard', 'back'];
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Toggles a camera: a new one takes the focal its position has not been shot with yet. */
export function toggleAngle(choices: readonly AngleChoice[], position: Position, existing: ReadonlyMap<string, ReadonlySet<Focal>>): AngleChoice[] {
  if (choices.some(choice => choice.position === position)) return choices.filter(choice => choice.position !== position);
  if (choices.length >= SUBJECT_VARIANT_LIMITS.items) return [...choices];
  const shot = existing.get(position);
  return [...choices, { position, focal: shot?.has('standard') && !shot.has('wide') ? 'wide' : 'standard' }];
}
export const angleSpecs = (choices: readonly AngleChoice[]): SubjectVariantSpec[] => choices.map(choice => ({ kind: 'angle', position: choice.position, focal: choice.focal }));
export const lightSpecs = (light: LightChoice): SubjectVariantSpec[] => [{ kind: 'light', azimuth: Math.round(light.azimuth), elevation: Math.round(light.elevation), quality: light.quality, kelvin: Math.round(light.kelvin / 100) * 100 }];
/** Camera positions and focal lengths this subject already has variant versions for. */
export function existingAngles(versions: readonly SubjectVersionResponse[]): Map<string, Set<Focal>> {
  const found = new Map<string, Set<Focal>>();
  for (const version of versions) if (version.variant?.kind === 'angle') { const set = found.get(version.variant.position) ?? new Set<Focal>(); set.add(version.variant.focal); found.set(version.variant.position, set); }
  return found;
}
/** Where the light dot sits on the front view of the sphere, in -1..1 with up positive. */
export function lightPoint(light: Pick<LightChoice, 'azimuth' | 'elevation'>): { x: number; y: number; behind: boolean } {
  const az = light.azimuth * Math.PI / 180, el = light.elevation * Math.PI / 180;
  return { x: Math.sin(az) * Math.cos(el), y: Math.sin(el), behind: Math.abs(light.azimuth) > 90 };
}
/** The inverse for a drag on the front view; the point is clamped onto the sphere. */
export function lightFromPoint(x: number, y: number): Pick<LightChoice, 'azimuth' | 'elevation'> {
  const length = Math.hypot(x, y), scale = length > 1 ? 1 / length : 1, px = x * scale, py = y * scale;
  const elevation = Math.asin(clamp(py, -1, 1)), across = Math.cos(elevation);
  const azimuth = across < 1e-6 ? 0 : Math.asin(clamp(px / across, -1, 1));
  return { azimuth: Math.round(azimuth * 180 / Math.PI), elevation: Math.round(elevation * 180 / Math.PI) };
}
/** Whether the image has any pixel that is not fully opaque; null when it cannot be read. */
export async function imageTransparency(url: string): Promise<boolean | null> {
  try {
    const image = new Image(); image.decoding = 'async'; image.src = url; await image.decode();
    const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight, 1));
    const width = Math.max(1, Math.round(image.naturalWidth * scale)), height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;
    for (let index = 3; index < data.length; index += 4) if (data[index]! < 255) return true;
    return false;
  } catch { return null; }
}
const issueKeys: Readonly<Record<SubjectVariantSourceIssue, `subjects.variants.issue.${SubjectVariantSourceIssue}`>> = Object.freeze({ format: 'subjects.variants.issue.format', bytes: 'subjects.variants.issue.bytes', dimensions: 'subjects.variants.issue.dimensions', origin: 'subjects.variants.issue.origin', missing: 'subjects.variants.issue.missing', transparent: 'subjects.variants.issue.transparent' });
const formatLabel = (mimeType: string): string => mimeType === 'image/jpeg' ? 'JPEG' : mimeType === 'image/webp' ? 'WebP' : 'PNG';

export interface SubjectVariantDialogProps {
  subject: SubjectResponse;
  /** The subject's visible versions that are loaded, including its head. */
  versions: readonly SubjectVersionResponse[];
  initialSourceId: string;
  assets: readonly SubjectAssetView[];
  controller: SubjectVariantController;
  /** True while a write is in flight or unknown, or the pane cannot act. */
  blocked: boolean;
  notice?: DisplayMessage | null;
  onClose: () => void;
}
// 09-10b / 09-10b-1 / 09-10d: one batch is either up to eight camera positions or
// one lighting change, edited from one source version and confirmed once.
export default function SubjectVariantDialog({ subject, versions, initialSourceId, assets, controller, blocked, notice = null, onClose }: SubjectVariantDialogProps): ReactElement {
  const { t, renderMessage } = useI18n();
  const confirm = useConfirmation();
  const [tab, setTab] = useState<SubjectVariantKind>('angle');
  const [sourceId, setSourceId] = useState(initialSourceId);
  const [picking, setPicking] = useState(false);
  const [models, setModels] = useState<SubjectVariantModel[] | null>(null);
  const [providerChoice, setProviderChoice] = useState<SubjectVariantProviderId | null>(null);
  const [angles, setAngles] = useState<AngleChoice[]>([]);
  const [currentPosition, setCurrentPosition] = useState<Position | null>(null);
  const [light, setLight] = useState<LightChoice>(SUBJECT_VARIANT_LIGHT_DEFAULT);
  const [opacity, setOpacity] = useState<{ key: string; transparent: boolean | null } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const live = useRef(true), dragging = useRef(false);
  useEffect(() => { live.current = true; let cancelled = false; void controller.readSettings().then(value => { if (!cancelled) setModels(value); }); return () => { cancelled = true; live.current = false; }; }, [controller]);
  const source = versions.find(version => version.id === sourceId) ?? versions.find(version => version.id === subject.headVersionId) ?? subject.headVersion;
  const asset = assets.find(item => item.id === source.assetId && item.projectId === source.projectId);
  const opacityKey = asset?.id && source.mimeType !== 'image/jpeg' ? `${asset.id}:${source.sha256}` : '';
  useEffect(() => {
    if (!opacityKey || !asset) return;
    let cancelled = false;
    void imageTransparency(assetUrl(asset)).then(transparent => { if (!cancelled) setOpacity({ key: opacityKey, transparent }); });
    return () => { cancelled = true; };
  }, [opacityKey]);
  const choices = models ?? subjectVariantModels(null);
  const providerId: SubjectVariantProviderId = providerChoice ?? (choices.find(choice => choice.providerId === 'openai')?.available ? 'openai' : 'mock');
  const model = choices.find(choice => choice.providerId === providerId)!;
  const sourceIssue: SubjectVariantSourceIssue | null = subjectVariantSourceIssue(source, asset, providerId) ?? (opacityKey && opacity?.key === opacityKey && opacity.transparent ? 'transparent' : null);
  const checking = Boolean(opacityKey && opacity?.key !== opacityKey);
  const size = subjectVariantOutputSize(source, providerId);
  const sizeLabel = size ? size.replace('x', '×') : '';
  const existing = existingAngles(versions);
  const specs = tab === 'angle' ? angleSpecs(angles) : lightSpecs(light);
  const ready = !blocked && !submitting && !sourceIssue && !checking && model.available && specs.length > 0;
  const kind = renderMessage(subjectKindDescriptor(subject.kind));
  const angleLabel = (position: Position): string => renderMessage(subjectAngleDescriptor(position));
  const choiceLabel = (choice: AngleChoice): string => (subjectVariantTagParts({ kind: 'angle', position: choice.position, focal: choice.focal, batchId: '', sourceVersionId: '' }) ?? []).map(part => renderMessage(part)).join(' · ');
  const sourceTag = subjectVariantTagParts(source.variant)?.map(part => renderMessage(part)).join(' · ');
  const current = angles.find(choice => choice.position === currentPosition) ?? angles.at(-1) ?? null;
  const toggle = (position: Position): void => { if (submitting) return; const nextChoices = toggleAngle(angles, position, existing); setAngles(nextChoices); setCurrentPosition(nextChoices.some(choice => choice.position === position) ? position : nextChoices.at(-1)?.position ?? null); };
  const setFocal = (focal: Focal): void => { if (current && !submitting) setAngles(angles.map(choice => choice.position === current.position ? { ...choice, focal } : choice)); };
  const updateLight = (patch: Partial<LightChoice>): void => { if (!submitting) setLight({ ...light, ...patch }); };
  const drag = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const box = event.currentTarget.getBoundingClientRect(), radius = box.width * 0.4;
    updateLight(lightFromPoint((event.clientX - box.left - box.width / 2) / radius, (box.top + box.height / 2 - event.clientY) / radius));
  };
  async function generate(): Promise<void> {
    if (!ready) return;
    const draft = { subjectId: subject.id, sourceVersionId: source.id, kind: tab, items: specs, providerId, model: model.model };
    if (!await confirm(message(model.paid ? 'subjects.variants.confirmPaid' : 'subjects.variants.confirmMock', { count: specs.length, name: subject.name })) || !live.current) return;
    setSubmitting(true);
    // A recorded batch, or one whose outcome is unknown, is followed up in the
    // version area; a refusal keeps the dialog open to adjust and try again.
    try { const batch = await controller.create(draft); if (live.current && (batch || controller.getState().pending)) onClose(); }
    finally { if (live.current) setSubmitting(false); }
  }
  const point = lightPoint(light);
  const direction = (value: number, positive: string, negative: string, zero: string): string => value > 0 ? positive : value < 0 ? negative : zero;
  const azimuthLabel = Math.abs(light.azimuth) > 90 ? t('subjects.variants.dirBehind') : direction(light.azimuth, t('subjects.variants.dirRight'), t('subjects.variants.dirLeft'), t('subjects.variants.dirFront'));
  const existingFocals = current ? [...(existing.get(current.position) ?? [])] : [];
  return <Dialog open onOpenChange={open => { if (!open && !submitting) onClose(); }}>
    <DialogContent className="wb-dialog subject-variant-dialog" data-size="large" data-testid="subject-variant-dialog" showCloseButton={false}>
      <header className="subject-variant-heading">
        <DialogTitle>{t('subjects.variants.dialogTitle')}</DialogTitle>
        <WorkbenchTabs appearance="underline" value={tab} label={t('subjects.variants.tabs')} onValueChange={value => { if (!submitting) setTab(value as SubjectVariantKind); }} options={[{ value: 'angle', label: t('subjects.inspector.variantAngle'), testId: 'subject-variant-tab-angle' }, { value: 'light', label: t('subjects.inspector.variantLight'), testId: 'subject-variant-tab-light' }]} />
        <span className="subject-variant-subject"><User size={12} aria-hidden="true" />{subject.name} · {kind}</span>
        <Button variant="ghost" size="sm" className="icon-button" aria-label={t('common.close')} data-testid="subject-variant-close" disabled={submitting} onClick={onClose}><X size={15} /></Button>
        <DialogDescription className="sr-only">{t('subjects.variants.dialogDescription')}</DialogDescription>
      </header>
      <div className="subject-variant-body">
        <aside className="subject-variant-source">
          <div className="subject-variant-label-row"><span>{t('subjects.variants.source')}</span><Button variant="ghost" size="sm" data-testid="subject-variant-change-source" aria-expanded={picking} disabled={submitting || versions.length < 2} onClick={() => setPicking(!picking)}><Replace size={12} aria-hidden="true" />{t('subjects.variants.changeSource')}</Button></div>
          {picking ? <div className="subject-variant-source-picker" role="listbox" aria-label={t('subjects.variants.sourcePicker')}>{versions.map(version => <Button key={version.id} variant="ghost" role="option" aria-selected={version.id === source.id} className={`subject-variant-source-option${version.id === source.id ? ' selected' : ''}`} data-testid={`subject-variant-source-${version.id}`} onClick={() => { setSourceId(version.id); setPicking(false); }}><SubjectImage version={version} assets={assets} label={`${subject.name} V${version.number}`} /><span className="subject-version-number">V{version.number}</span></Button>)}</div>
            : <div className={`subject-variant-source-image${sourceIssue ? ' has-issue' : ''}`}><SubjectImage version={source} assets={assets} label={`${subject.name} V${source.number}`} /><span className="subject-version-number">V{source.number}</span></div>}
          <p className="subject-variant-source-title"><strong>{subject.name} · V{source.number}</strong>{sourceTag && <span className="subject-version-label is-tag">{sourceTag}</span>}</p>
          <p className="subject-helper">{tab === 'angle' ? t('subjects.variants.sourceAngleHint') : t('subjects.variants.sourceLightHint')}</p>
          {sourceIssue ? <div className="subject-variant-source-issue" role="alert" data-testid="subject-variant-source-issue"><p><CircleAlert size={12} aria-hidden="true" />{t('subjects.variants.sourceUnusable')}</p><p>{t(issueKeys[sourceIssue])}</p></div>
            : <p className="subject-variant-source-check" data-testid="subject-variant-source-check">{checking ? t('subjects.variants.sourceChecking') : <><CircleCheck size={12} aria-hidden="true" />{formatLabel(source.mimeType)} · {source.width}×{source.height} · {t('subjects.variants.sourceUsable')}</>}</p>}
          <Label htmlFor="subject-variant-model">{t('subjects.variants.model')}</Label>
          <WorkbenchSelect id="subject-variant-model" data-testid="subject-variant-model" value={providerId} disabled={submitting} onChange={event => { if (['mock', 'openai'].includes(event.target.value)) setProviderChoice(event.target.value as SubjectVariantProviderId); }}>
            <option value="openai" disabled={!choices.find(choice => choice.providerId === 'openai')?.available}>{t('subjects.variants.modelOpenAI')}</option>
            <option value="mock">{t('subjects.variants.modelMock')}</option>
            <option value="openai-compatible" disabled>{t('subjects.variants.modelCompatible')}</option>
            <option value="comfy-local" disabled>{t('subjects.variants.modelComfy')}</option>
          </WorkbenchSelect>
          {models && !choices.find(choice => choice.providerId === 'openai')?.available && <p className="subject-helper">{t('subjects.variants.modelOpenAIUnavailable')}</p>}
        </aside>
        <section className="subject-variant-main">
          {tab === 'angle' ? <div className="subject-variant-angles" data-testid="subject-variant-angles">
            <div className="subject-variant-label-row"><strong>{t('subjects.variants.camera')}</strong><span>{t('subjects.variants.selected', { count: angles.length })}<Button variant="ghost" size="sm" disabled={!angles.length || submitting} onClick={() => { setAngles([]); setCurrentPosition(null); }}>{t('subjects.variants.clear')}</Button></span></div>
            <div className="subject-variant-camera">
              <div className="subject-variant-ring" role="group" aria-label={t('subjects.variants.camera')}>
                <span className="subject-variant-ring-center" aria-hidden="true"><User size={16} /><small>{t('subjects.variants.ringCenter')}</small></span>
                {SUBJECT_VARIANT_RING.map(([position, degrees]) => { const chosen = angles.some(choice => choice.position === position), has = existing.has(position), full = !chosen && angles.length >= SUBJECT_VARIANT_LIMITS.items;
                  return <Button key={position} variant="ghost" size="sm" className={`subject-variant-position${chosen ? ' selected' : ''}`} style={{ left: `${50 + 41 * Math.sin(degrees * Math.PI / 180)}%`, top: `${50 - 41 * Math.cos(degrees * Math.PI / 180)}%` }} data-testid={`subject-variant-position-${position}`} aria-pressed={chosen} disabled={full || submitting} onClick={() => toggle(position)}>{chosen && <Check size={11} aria-hidden="true" />}{angleLabel(position)}{has && <small>{t('subjects.variants.existing')}</small>}</Button>; })}
              </div>
              <div className="subject-variant-heights"><span className="subject-variant-caption">{t('subjects.variants.height')}</span>
                {SUBJECT_VARIANT_HEIGHTS.map(position => { const chosen = angles.some(choice => choice.position === position), full = !chosen && angles.length >= SUBJECT_VARIANT_LIMITS.items;
                  return <Button key={position} variant="ghost" size="sm" className={`subject-variant-height${chosen ? ' selected' : ''}`} data-testid={`subject-variant-position-${position}`} aria-pressed={chosen} disabled={full || submitting} onClick={() => toggle(position)}>{position === 'high' ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" />}{angleLabel(position)}{existing.has(position) && <small>{t('subjects.variants.existing')}</small>}</Button>; })}
                <p className="subject-helper">{t('subjects.variants.heightHint')}</p>
                {angles.length >= SUBJECT_VARIANT_LIMITS.items && <p className="subject-helper">{t('subjects.variants.limit')}</p>}
              </div>
            </div>
            <div className="subject-variant-chosen" aria-label={t('subjects.variants.willGenerate')}><span className="subject-variant-caption">{t('subjects.variants.willGenerate')}</span>
              {angles.length ? angles.map(choice => <span key={choice.position} className={`subject-variant-chip${current?.position === choice.position ? ' current' : ''}`}><Button variant="ghost" size="sm" className="subject-variant-chip-label" onClick={() => setCurrentPosition(choice.position)}>{choiceLabel(choice)}</Button><Button variant="ghost" size="sm" className="subject-variant-chip-remove" aria-label={t('subjects.variants.remove', { angle: choiceLabel(choice) })} disabled={submitting} onClick={() => toggle(choice.position)}><X size={10} /></Button></span>) : <span className="subject-helper">{t('subjects.variants.pickAngle')}</span>}</div>
            {current && <div className="subject-variant-focal"><div><span className="subject-variant-caption">{t('subjects.variants.focal')}</span><small>{t('subjects.variants.focalCurrent', { angle: angleLabel(current.position) })}</small></div>
              <WorkbenchTabs value={current.focal} label={t('subjects.variants.focal')} onValueChange={value => setFocal(value as Focal)} options={[{ value: 'standard', label: t('subjects.variants.focalStandard'), testId: 'subject-variant-focal-standard' }, { value: 'wide', label: t('subjects.variants.focalWide'), testId: 'subject-variant-focal-wide' }]} />
              <p className="subject-helper">{existingFocals.length ? t('subjects.variants.focalExisting', { angle: angleLabel(current.position), focal: existingFocals.map(focal => focal === 'wide' ? t('subjects.angle.wide') : t('subjects.variants.focalStandard')).join(' / ') }) : ''}{t('subjects.variants.focalHint')}</p></div>}
          </div> : <div className="subject-variant-light" data-testid="subject-variant-light">
            <div className="subject-variant-label-row"><strong>{t('subjects.variants.lightDirection')}</strong><Button variant="ghost" size="sm" data-testid="subject-variant-light-reset" disabled={submitting} onClick={() => updateLight(SUBJECT_VARIANT_LIGHT_DEFAULT)}><RotateCcw size={12} aria-hidden="true" />{t('subjects.variants.reset')}</Button></div>
            <div className="subject-variant-light-direction">
              <div className="subject-variant-sphere"><span className="is-up">{t('subjects.variants.up')}</span><span className="is-down">{t('subjects.variants.down')}</span><span className="is-left">{t('subjects.variants.left')}</span><span className="is-right">{t('subjects.variants.right')}</span>
                <svg viewBox="0 0 200 200" role="img" aria-label={t('subjects.variants.sphereLabel')} onPointerDown={event => { if (submitting) return; dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); drag(event); }} onPointerMove={event => { if (dragging.current) drag(event); }} onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }}>
                  <defs><radialGradient id="subject-variant-sphere-fill" cx={`${50 + 30 * point.x}%`} cy={`${50 - 30 * point.y}%`} r="70%"><stop offset="0%" stopColor="#f2f2f2" /><stop offset="55%" stopColor="#5a5d64" /><stop offset="100%" stopColor="#1f2126" /></radialGradient></defs>
                  <circle cx="100" cy="100" r="80" fill="url(#subject-variant-sphere-fill)" stroke="currentColor" strokeOpacity="0.25" />
                  <ellipse cx="100" cy="100" rx="80" ry="24" fill="none" stroke="currentColor" strokeOpacity="0.2" /><ellipse cx="100" cy="100" rx="24" ry="80" fill="none" stroke="currentColor" strokeOpacity="0.2" />
                  <line x1="100" y1="100" x2={100 + 80 * point.x} y2={100 - 80 * point.y} stroke="currentColor" strokeOpacity="0.6" /><circle cx="100" cy="100" r="2.5" fill="currentColor" />
                  <circle cx={100 + 80 * point.x} cy={100 - 80 * point.y} r="7" fill={point.behind ? 'none' : '#ffffff'} stroke="#ffffff" strokeWidth="2" data-testid="subject-variant-light-point" />
                </svg></div>
              <div className="subject-variant-light-fields">
                <Label htmlFor="subject-variant-azimuth">{t('subjects.variants.azimuth')}</Label>
                <span className="subject-variant-number"><Input id="subject-variant-azimuth" data-testid="subject-variant-azimuth" type="number" min={-180} max={180} step={1} value={light.azimuth} disabled={submitting} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value)) updateLight({ azimuth: clamp(Math.round(value), -180, 180) }); }} /><small>{azimuthLabel}</small></span>
                <Label htmlFor="subject-variant-elevation">{t('subjects.variants.elevation')}</Label>
                <span className="subject-variant-number"><Input id="subject-variant-elevation" data-testid="subject-variant-elevation" type="number" min={-90} max={90} step={1} value={light.elevation} disabled={submitting} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value)) updateLight({ elevation: clamp(Math.round(value), -90, 90) }); }} /><small>{direction(light.elevation, t('subjects.variants.dirUp'), t('subjects.variants.dirDown'), t('subjects.variants.dirLevel'))}</small></span>
                <p className="subject-helper">{t('subjects.variants.lightHint')}</p>
              </div>
            </div>
            <div className="subject-variant-light-row"><span className="subject-variant-caption">{t('subjects.variants.quality')}</span><WorkbenchTabs value={light.quality} label={t('subjects.variants.quality')} onValueChange={value => updateLight({ quality: value as Quality })} options={QUALITIES.map(quality => ({ value: quality, label: t(`subjects.light.${quality}`), testId: `subject-variant-quality-${quality}` }))} /></div>
            <div className="subject-variant-light-row"><Label id="subject-variant-kelvin-label" className="subject-variant-caption">{t('subjects.variants.kelvin')}</Label><span className="subject-variant-kelvin"><small>{t('subjects.variants.warm')}</small><Slider className="subject-variant-kelvin-slider" aria-labelledby="subject-variant-kelvin-label" data-testid="subject-variant-kelvin" thumbAlignment="center" min={2000} max={10000} step={100} value={[light.kelvin]} disabled={submitting} onValueChange={value => updateLight({ kelvin: clamp(Math.round(typeof value === 'number' ? value : value[0] ?? light.kelvin), 2000, 10000) })} /><small>{t('subjects.variants.cool')}</small><output>{light.kelvin}K</output></span></div>
          </div>}
          <footer className="subject-variant-footer">
            <div className="subject-variant-summary">{sourceIssue ? <span>{t('subjects.variants.sourceRequired')}</span> : <><span>{t('subjects.variants.summary', { count: specs.length, name: subject.name })}</span>{sizeLabel && <small>{t('subjects.variants.sizeLine', { size: sizeLabel })}</small>}</>}</div>
            <div className="subject-variant-actions"><Button variant="ghost" size="sm" disabled={submitting} onClick={onClose}>{t('common.cancel')}</Button><Button size="sm" data-testid="subject-variant-generate" disabled={!ready} onClick={() => { void generate(); }}><Sparkles size={13} aria-hidden="true" />{tab === 'angle' ? t('subjects.variants.generate', { count: specs.length }) : t('subjects.variants.generateOne')}</Button></div>
            <p className="subject-variant-cost">{model.paid ? t('subjects.variants.costPaid') : t('subjects.variants.costMock')}</p>
            {notice && <p className="subject-warning" role="alert">{renderMessage(notice)}</p>}
          </footer>
        </section>
      </div>
    </DialogContent>
  </Dialog>;
}

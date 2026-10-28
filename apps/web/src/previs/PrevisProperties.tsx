import React, { useLayoutEffect, useRef, useState } from 'react';
import type { PrevisCamera, PrevisFigure, PrevisProp, PrevisScene } from '@mioon/contracts';
import { PREVIS_LIMITS } from '@mioon/contracts';
import { Camera, ChevronDown, PersonStanding, RotateCcw, Sun, Trash2 } from '@mioon/ui/components/workbench-icons';
import { WorkbenchSelect } from '../WorkspaceControls.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { PREVIS_HAND_KEYS, PREVIS_KIND_KEYS, PREVIS_LIGHT_SELECTION, PREVIS_POSE_KEYS, previsElementName, previsHoldableProps, previsPropName } from './previs-editor-state.ts';
import type { PrevisSelection, PrevisTranslate } from './previs-editor-state.ts';
import { PREVIS_POSE_ORDER, cleanPrevisName } from './previs-scene.ts';
import type { PrevisFigurePatch, PrevisLightPatch, PrevisPropPatch } from './previs-scene.ts';
import { PrevisNumberField, PrevisRow, PrevisSegments, PrevisSlider } from './PrevisFields.tsx';
import { PREVIS_PROP_ICONS } from './PrevisOutline.tsx';

// The properties panel (09-12, right): the selected figure, prop or the
// camera, and the scene's key light below. Every change is one scene edit;
// a `key` joins the steps of one continuous change into a single undo step.
export interface PrevisPropertiesProps {
  scene: PrevisScene;
  selection: PrevisSelection;
  readOnly: boolean;
  shortcut: string;
  onFigure: (id: string, patch: PrevisFigurePatch, key?: string) => void;
  onProp: (id: string, patch: PrevisPropPatch, key?: string) => void;
  onLight: (patch: PrevisLightPatch, key?: string) => void;
  onCamera: (camera: PrevisCamera, key?: string) => void;
  onHold: (figureId: string, propId: string | null, hand: 'left' | 'right') => void;
  onRemove: (id: string) => void;
}
function Section({ title, badge, icon, children }: { title: string; badge?: string; icon?: React.ReactNode; children: React.ReactNode }): React.ReactElement {
  const [open, setOpen] = useState(true);
  return <section className="previs-section" data-open={open || undefined}>
    <button type="button" className="previs-section-heading" aria-expanded={open} onClick={() => setOpen(!open)}><ChevronDown size={13} aria-hidden="true" />{icon}<span>{title}</span>{badge && <small>{badge}</small>}</button>
    {open && <div className="previs-section-body">{children}</div>}
  </section>;
}
function NameField({ value, placeholder, disabled, testId, onChange }: { value: string; placeholder: string; disabled: boolean; testId: string; onChange: (name: string) => void }): React.ReactElement {
  const { t } = useI18n(), [draft, setDraft] = useState(value), editing = useRef(false);
  useLayoutEffect(() => { if (!editing.current) setDraft(value); }, [value]);
  const commit = (): void => { editing.current = false; const next = cleanPrevisName(draft); setDraft(next); if (next !== value) onChange(next); };
  return <input className="previs-text" aria-label={t('previs.panel.name')} data-testid={testId} value={draft} placeholder={placeholder} maxLength={PREVIS_LIMITS.nameLength} disabled={disabled}
    onFocus={() => { editing.current = true; }} onChange={event => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); else if (event.key === 'Escape') { editing.current = false; setDraft(value); event.currentTarget.blur(); } }} />;
}
export default function PrevisProperties({ scene, selection, readOnly, shortcut, onFigure, onProp, onLight, onCamera, onHold, onRemove }: PrevisPropertiesProps): React.ReactElement {
  const { t } = useI18n(), translate = t as unknown as PrevisTranslate;
  const figure = scene.figures.find(item => item.id === selection), prop = scene.props.find(item => item.id === selection);
  const name = previsElementName(scene, selection, translate);
  const unit = t('previs.unit.metre'), degree = '°';
  const axes = [t('previs.axis.x'), t('previs.axis.y'), t('previs.axis.z')];
  const position = (value: readonly number[], disabled: boolean, prefix: string, change: (next: [number, number, number]) => void) =>
    <div className="previs-vector">{[0, 1, 2].map(index => <PrevisNumberField key={index} label={axes[index]} ariaLabel={t('previs.field.named', { field: t('previs.panel.position'), axis: axes[index]! })}
      testId={`${prefix}-position-${index}`} value={value[index]!} min={index === 1 ? 0 : -100} max={100} step={0.1} digits={2} disabled={disabled}
      onChange={next => { const copy = [...value] as [number, number, number]; copy[index] = next; change(copy); }} />)}</div>;
  const facing = (value: number, disabled: boolean, testId: string, change: (next: number, key: string) => void) => <div className="previs-slider-row">
    <PrevisSlider ariaLabel={t('previs.panel.rotation')} testId={`${testId}-slider`} value={value} min={-180} max={180} step={1} disabled={disabled} onChange={next => change(next, `${testId}:slider`)} />
    <PrevisNumberField label="" ariaLabel={t('previs.panel.rotation')} testId={testId} value={value} min={-180} max={180} step={1} digits={0} unit={degree} disabled={disabled} onChange={next => change(next, `${testId}:field`)} /></div>;
  const header = figure ? <><PersonStanding size={15} aria-hidden="true" /><strong>{name}</strong><span className="previs-badge">{t('previs.panel.figureBadge')}</span></>
    : prop ? <>{React.createElement(PREVIS_PROP_ICONS[prop.kind], { size: 15, 'aria-hidden': true })}<strong>{name}</strong><span className="previs-badge">{t(PREVIS_KIND_KEYS[prop.kind] as never)}</span></>
      : selection === PREVIS_LIGHT_SELECTION ? <><Sun size={15} aria-hidden="true" /><strong>{name}</strong><span className="previs-badge">{t('previs.panel.lightBadge')}</span></>
        : <><Camera size={15} aria-hidden="true" /><strong>{name}</strong><span className="previs-badge">{t('previs.panel.cameraBadge')}</span></>;
  return <aside className="previs-panel previs-properties" aria-label={name} data-testid="previs-properties">
    <header className="previs-panel-heading previs-properties-heading">{header}
      {(figure || prop) && <button type="button" className="previs-icon-button" data-testid="previs-remove" aria-label={t('previs.panel.delete', { name })} title={t('previs.panel.delete', { name })} disabled={readOnly} onClick={() => onRemove((figure ?? prop)!.id)}><Trash2 size={14} aria-hidden="true" /></button>}</header>
    <div className="previs-properties-scroll">
      {figure && <FigureSections key={figure.id} figure={figure} scene={scene} readOnly={readOnly} position={position} facing={facing} onFigure={onFigure} onHold={onHold} />}
      {prop && <PropSections key={prop.id} prop={prop} scene={scene} readOnly={readOnly} position={position} facing={facing} onProp={onProp} />}
      {!figure && !prop && selection !== PREVIS_LIGHT_SELECTION && <Section title={t('previs.camera.name')} badge={t('previs.panel.cameraBadge')}>
        <PrevisRow label={t('previs.panel.position')} hint={t('previs.panel.cameraHint')}>{position(scene.camera.position, readOnly, 'previs-camera', next => onCamera({ ...scene.camera, position: next }, 'camera:position'))}</PrevisRow>
        <PrevisRow label={t('previs.panel.cameraPan')}>{facing(scene.camera.yaw, readOnly, 'previs-camera-yaw', (next, key) => onCamera({ ...scene.camera, yaw: next }, key))}</PrevisRow>
        <PrevisRow label={t('previs.panel.cameraTilt')}><div className="previs-slider-row"><PrevisSlider ariaLabel={t('previs.panel.cameraTilt')} testId="previs-camera-pitch-slider" value={scene.camera.pitch} min={-89} max={89} step={1} disabled={readOnly} onChange={next => onCamera({ ...scene.camera, pitch: next }, 'camera:pitch')} />
          <PrevisNumberField label="" ariaLabel={t('previs.panel.cameraTilt')} testId="previs-camera-pitch" value={scene.camera.pitch} min={-89} max={89} step={1} digits={0} unit={degree} disabled={readOnly} onChange={next => onCamera({ ...scene.camera, pitch: next }, 'camera:pitch-field')} /></div></PrevisRow>
        <PrevisRow label={t('previs.focal.title')}><PrevisNumberField label="" ariaLabel={t('previs.focal.title')} testId="previs-camera-focal" value={scene.camera.focalLength} min={10} max={300} step={1} digits={0} unit={t('previs.unit.millimetre')} disabled={readOnly} onChange={next => onCamera({ ...scene.camera, focalLength: next }, 'camera:focal')} /></PrevisRow>
      </Section>}
      <Section title={t('previs.light.name')} badge={t('previs.panel.lightBadge')} icon={<Sun size={13} aria-hidden="true" />}>
        <PrevisRow label={t('previs.panel.direction')}><div className="previs-vector previs-vector-two">
          <PrevisNumberField label={t('previs.panel.azimuth')} ariaLabel={t('previs.panel.azimuth')} testId="previs-light-azimuth" value={scene.light.azimuth} min={-180} max={180} step={5} digits={0} unit={degree} disabled={readOnly} onChange={next => onLight({ azimuth: next }, 'light:azimuth')} />
          <PrevisNumberField label={t('previs.panel.elevation')} ariaLabel={t('previs.panel.elevation')} testId="previs-light-elevation" value={scene.light.elevation} min={-90} max={90} step={5} digits={0} unit={degree} disabled={readOnly} onChange={next => onLight({ elevation: next }, 'light:elevation')} />
        </div></PrevisRow>
        <PrevisRow label={t('previs.panel.intensity')}><div className="previs-slider-row">
          <PrevisSlider ariaLabel={t('previs.panel.intensity')} testId="previs-light-intensity-slider" value={scene.light.intensity} min={0} max={4} step={0.1} disabled={readOnly} onChange={next => onLight({ intensity: next }, 'light:intensity')} />
          <PrevisNumberField label="" ariaLabel={t('previs.panel.intensity')} testId="previs-light-intensity" value={scene.light.intensity} min={0} max={4} step={0.1} digits={1} disabled={readOnly} onChange={next => onLight({ intensity: next }, 'light:intensity-field')} /></div></PrevisRow>
      </Section>
    </div>
    <footer className="previs-properties-footer"><RotateCcw size={12} aria-hidden="true" />{t('previs.panel.footer', { shortcut })}</footer>
  </aside>;
}
type PositionField = (value: readonly number[], disabled: boolean, prefix: string, change: (next: [number, number, number]) => void) => React.ReactElement;
type FacingField = (value: number, disabled: boolean, testId: string, change: (next: number, key: string) => void) => React.ReactElement;
function FigureSections({ figure, scene, readOnly, position, facing, onFigure, onHold }: { figure: PrevisFigure; scene: PrevisScene; readOnly: boolean; position: PositionField; facing: FacingField; onFigure: PrevisPropertiesProps['onFigure']; onHold: PrevisPropertiesProps['onHold'] }): React.ReactElement {
  const { t } = useI18n(), translate = t as unknown as PrevisTranslate, holdable = previsHoldableProps(scene, figure.id);
  const hands = (['left', 'right'] as const).map(value => ({ value, label: t(PREVIS_HAND_KEYS[value]) }));
  return <>
    <Section title={t('previs.panel.pose')}>
      <PrevisRow label={t('previs.panel.name')}><NameField value={figure.name} placeholder={t('previs.figure.default', { number: Number(figure.id.slice(1)) })} disabled={readOnly} testId="previs-figure-name" onChange={name => onFigure(figure.id, { name })} /></PrevisRow>
      <div className="previs-row-stack"><span className="previs-row-label">{t('previs.panel.preset')}</span>
        <PrevisSegments label={t('previs.panel.preset')} testId="previs-pose" strong value={figure.pose} disabled={readOnly} options={PREVIS_POSE_ORDER.map(value => ({ value, label: t(PREVIS_POSE_KEYS[value] as never) }))} onChange={pose => onFigure(figure.id, { pose })} /></div>
      <PrevisRow label={t('previs.panel.holdHand')}><PrevisSegments label={t('previs.panel.holdHand')} testId="previs-hand" value={figure.held?.hand ?? null} disabled={readOnly || !figure.held} options={hands} onChange={hand => onHold(figure.id, figure.held!.propId, hand)} /></PrevisRow>
      <PrevisRow label={t('previs.panel.held')}><WorkbenchSelect className="previs-select" data-testid="previs-held" aria-label={t('previs.panel.held')} value={figure.held?.propId ?? ''} disabled={readOnly}
        onChange={event => onHold(figure.id, event.target.value || null, figure.held?.hand ?? 'right')}>
        <option value="">{t('previs.panel.heldNone')}</option>
        {holdable.map(prop => <option key={prop.id} value={prop.id}>{previsPropName(scene, prop, translate)}</option>)}
      </WorkbenchSelect></PrevisRow>
    </Section>
    <Section title={t('previs.panel.transform')}>
      <PrevisRow label={t('previs.panel.position')} hint={t('previs.panel.positionHint')}>{position(figure.position, readOnly, 'previs-figure', next => onFigure(figure.id, { position: next }, `figure:${figure.id}:position`))}</PrevisRow>
      <PrevisRow label={t('previs.panel.rotation')}>{facing(figure.rotation, readOnly, 'previs-figure-rotation', (next, key) => onFigure(figure.id, { rotation: next }, `figure:${figure.id}:${key}`))}</PrevisRow>
    </Section>
  </>;
}
function PropSections({ prop, scene, readOnly, position, facing, onProp }: { prop: PrevisProp; scene: PrevisScene; readOnly: boolean; position: PositionField; facing: FacingField; onProp: PrevisPropertiesProps['onProp'] }): React.ReactElement {
  const { t } = useI18n(), translate = t as unknown as PrevisTranslate;
  const holder = scene.figures.find(item => item.held?.propId === prop.id), held = Boolean(holder);
  const sizes = [t('previs.axis.width'), t('previs.axis.height'), t('previs.axis.depth')];
  return <Section title={t('previs.panel.transform')}>
    <PrevisRow label={t('previs.panel.name')}><NameField value={prop.name} placeholder={previsPropName(scene, { ...prop, name: '' }, translate)} disabled={readOnly} testId="previs-prop-name" onChange={name => onProp(prop.id, { name })} /></PrevisRow>
    {holder && <p className="previs-note" data-testid="previs-held-note">{t('previs.panel.heldNote', { name: previsElementName(scene, holder.id, translate) })}</p>}
    <PrevisRow label={t('previs.panel.position')} hint={held ? undefined : t('previs.panel.positionHint')}>{position(prop.position, readOnly || held, 'previs-prop', next => onProp(prop.id, { position: next }, `prop:${prop.id}:position`))}</PrevisRow>
    <PrevisRow label={t('previs.panel.rotation')}>{facing(prop.rotation, readOnly || held, 'previs-prop-rotation', (next, key) => onProp(prop.id, { rotation: next }, `prop:${prop.id}:${key}`))}</PrevisRow>
    <PrevisRow label={t('previs.panel.size')} hint={t('previs.panel.sizeHint')}><div className="previs-vector">{[0, 1, 2].map(index => <PrevisNumberField key={index} label={sizes[index]} ariaLabel={t('previs.field.named', { field: t('previs.panel.size'), axis: sizes[index]! })}
      testId={`previs-prop-size-${index}`} value={prop.size[index]!} min={0.01} max={20} step={0.05} digits={2} disabled={readOnly}
      onChange={next => { const copy = [...prop.size] as [number, number, number]; copy[index] = next; onProp(prop.id, { size: copy }, `prop:${prop.id}:size`); }} />)}</div></PrevisRow>
  </Section>;
}

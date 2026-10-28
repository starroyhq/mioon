import React, { useState } from 'react';
import type { ReactNode } from 'react';
import type { PrevisProp, PrevisScene } from '@mioon/contracts';
import { PREVIS_LIMITS } from '@mioon/contracts';
import { WorkbenchButton } from '@mioon/ui/components/workbench-controls';
import { WorkbenchPopover, WorkbenchPopoverContent, WorkbenchPopoverTitle, WorkbenchPopoverTrigger } from '@mioon/ui/components/workbench-popover';
import { Box, Circle, Coffee, Cylinder, Eye, EyeOff, List, PersonStanding, Plus, RectangleVertical, ShoppingBag, Smartphone, Sun, Umbrella } from '@mioon/ui/components/workbench-icons';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { PREVIS_KIND_KEYS, PREVIS_LIGHT_SELECTION, previsFigureName, previsOutlineDetail, previsPropName } from './previs-editor-state.ts';
import type { PrevisSelection, PrevisTranslate } from './previs-editor-state.ts';
import { PREVIS_PROP_ORDER, canAddPrevisFigure, canAddPrevisProp } from './previs-scene.ts';

// The scene outline (09-12, left): figures, props and the key light, each
// with a visibility toggle, and the buttons that add figures and props.
export const PREVIS_PROP_ICONS: Readonly<Record<PrevisProp['kind'], typeof Box>> = Object.freeze({
  box: Box, cylinder: Cylinder, sphere: Circle, panel: RectangleVertical, umbrella: Umbrella, phone: Smartphone, bag: ShoppingBag, cup: Coffee,
});
export interface PrevisOutlineProps {
  scene: PrevisScene;
  selection: PrevisSelection;
  readOnly: boolean;
  onSelect: (selection: PrevisSelection) => void;
  onVisible: (selection: string, visible: boolean) => void;
  onAddFigure: () => void;
  onAddProp: (kind: PrevisProp['kind']) => void;
}
export default function PrevisOutline({ scene, selection, readOnly, onSelect, onVisible, onAddFigure, onAddProp }: PrevisOutlineProps): React.ReactElement {
  const { t, formatNumber } = useI18n(), translate = t as unknown as PrevisTranslate, [adding, setAdding] = useState(false);
  const format = (value: number): string => formatNumber(value, { maximumFractionDigits: 2 });
  const row = (id: string, icon: ReactNode, name: string, visible: boolean): React.ReactElement => {
    const detail = previsOutlineDetail(scene, id, translate, format);
    return <div key={id} className="previs-outline-row" data-selected={selection === id || undefined} data-hidden={!visible || undefined}>
      <button type="button" className="previs-outline-select" aria-pressed={selection === id} data-testid={`previs-outline-${id}`} onClick={() => onSelect(selection === id ? null : id)}>
        {icon}<span className="previs-outline-name">{name}</span>{detail && <span className="previs-outline-detail">{detail}</span>}
      </button>
      <button type="button" className="previs-eye" data-testid={`previs-visible-${id}`} aria-label={t(visible ? 'previs.outline.hide' : 'previs.outline.show', { name })} aria-pressed={!visible} disabled={readOnly}
        onClick={() => onVisible(id, !visible)}>{visible ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}</button>
    </div>;
  };
  const figureLimit = !canAddPrevisFigure(scene), propLimit = !canAddPrevisProp(scene);
  return <aside className="previs-panel previs-outline" aria-label={t('previs.outline.title')} data-testid="previs-outline">
    <header className="previs-panel-heading"><List size={15} aria-hidden="true" /><strong>{t('previs.outline.title')}</strong><small>{scene.figures.length + scene.props.length + 1}</small></header>
    <div className="previs-outline-scroll">
      <section aria-label={t('previs.outline.figures')}><h3>{t('previs.outline.figures')}</h3>
        {scene.figures.map(figure => row(figure.id, <PersonStanding size={14} aria-hidden="true" />, previsFigureName(figure, translate), figure.visible))}</section>
      <section aria-label={t('previs.outline.props')}><h3>{t('previs.outline.props')}</h3>
        {scene.props.map(prop => { const Icon = PREVIS_PROP_ICONS[prop.kind]; return row(prop.id, <Icon size={14} aria-hidden="true" />, previsPropName(scene, prop, translate), prop.visible); })}</section>
      <section aria-label={t('previs.outline.lights')}><h3>{t('previs.outline.lights')}</h3>
        {row(PREVIS_LIGHT_SELECTION, <Sun size={14} aria-hidden="true" />, t('previs.light.name'), scene.light.visible)}</section>
    </div>
    <footer className="previs-outline-footer">
      <WorkbenchButton variant="secondary" data-testid="previs-add-figure" disabled={readOnly || figureLimit} title={figureLimit ? t('previs.outline.figureLimit', { limit: PREVIS_LIMITS.figures }) : undefined} onClick={onAddFigure}><PersonStanding size={14} aria-hidden="true" />{t('previs.outline.addFigure')}</WorkbenchButton>
      <WorkbenchPopover open={adding} onOpenChange={next => setAdding(next && !readOnly && !propLimit)}>
        <WorkbenchPopoverTrigger render={<WorkbenchButton variant="secondary" data-testid="previs-add-prop" disabled={readOnly || propLimit} title={propLimit ? t('previs.outline.propLimit', { limit: PREVIS_LIMITS.props }) : undefined} />}><Plus size={14} aria-hidden="true" />{t('previs.outline.addProp')}</WorkbenchPopoverTrigger>
        <WorkbenchPopoverContent side="top" align="end" className="previs-prop-menu"><WorkbenchPopoverTitle>{t('previs.outline.chooseProp')}</WorkbenchPopoverTitle>
          <div className="previs-prop-grid">{PREVIS_PROP_ORDER.map(kind => { const Icon = PREVIS_PROP_ICONS[kind]; return <button type="button" key={kind} data-testid={`previs-add-prop-${kind}`} onClick={() => { setAdding(false); onAddProp(kind); }}><Icon size={16} aria-hidden="true" /><span>{t(PREVIS_KIND_KEYS[kind] as never)}</span></button>; })}</div>
        </WorkbenchPopoverContent>
      </WorkbenchPopover>
    </footer>
  </aside>;
}

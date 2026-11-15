import {useId, useRef, useState} from 'react';
import type {ChangeEvent, RefObject} from 'react';
import {Dialog} from '@mioon/ui/components/dialog';
import {Input} from '@mioon/ui/components/input';
import {WorkbenchBadge, WorkbenchButton, WorkbenchDialogContent} from '@mioon/ui/components/workbench-controls';
import {useI18n} from './i18n/I18nProvider.tsx';
import Icon from './icons.tsx';
import './model-picker-dialog.css';

export interface ModelPickerItem {
  id: string;
  label?: string;
  added?: boolean;
  active?: boolean;
  verified?: boolean;
  unavailable?: boolean;
}

interface ModelPickerDialogProps {
  serviceName: string;
  items: readonly ModelPickerItem[];
  returnedModelCount?: number;
  status: 'loading' | 'error' | 'empty' | 'ready';
  statusMessage?: string;
  usesDraftKey?: boolean;
  mode?: 'multiple' | 'single';
  maxAdditions?: number;
  onClose: () => void;
  onAdd: (ids: readonly string[]) => void;
  triggerRef?: RefObject<HTMLElement | null>;
}

/** Mount once per fetch. Only the parent can add models to the settings draft. */
export default function ModelPickerDialog({serviceName, items, status, statusMessage, usesDraftKey = false,
  mode = 'multiple', returnedModelCount = items.length, maxAdditions, onClose, onAdd, triggerRef}: ModelPickerDialogProps) {
  const {t} = useI18n();
  const radioName = useId(), single = mode === 'single';
  const search = useRef<HTMLInputElement | null>(null);
  const cancel = useRef<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const ready = status === 'ready';
  const canSelect = (item: ModelPickerItem) => !item.added && !item.active && !item.unavailable;
  const available = ready ? items.filter(canSelect) : [];
  const selected = available.filter(item => selection.has(item.id)).map(item => item.id);
  const searchTerm = query.trim().toLowerCase();
  const matchesSearch = (item: ModelPickerItem) => item.id.toLowerCase().includes(searchTerm) || item.label?.toLowerCase().includes(searchTerm);
  const visible = items.filter(item => (single && item.added) || (ready && matchesSearch(item)));
  const visibleChoices = visible.filter(canSelect);
  const capacity = maxAdditions !== undefined && selected.length > maxAdditions ? maxAdditions : null;
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/u.test(navigator.platform);

  function toggle(id: string, checked: boolean) {
    if (single) {if (checked) setSelection(new Set([id])); return;}
    setSelection(previous => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const footer = <>
    <p aria-live="polite" data-testid="model-picker-count">{t('settings.modelPicker.count', {count: selected.length})}</p>
    <WorkbenchButton ref={cancel} type="button" onClick={onClose}>{t('common.cancel')}</WorkbenchButton>
    <WorkbenchButton type="button" variant="primary" disabled={!selected.length || capacity !== null} data-testid="model-picker-add" onClick={() => {
      if (selected.length && capacity === null) onAdd(selected);
    }}>{single ? t('settings.modelPicker.useModel') : t('settings.modelPicker.add', {count: selected.length})}</WorkbenchButton>
  </>;

  return <Dialog open onOpenChange={open => {if (!open) onClose();}}>
    <WorkbenchDialogContent className="model-picker-dialog" data-testid="model-picker" title={t(single ? 'settings.modelPicker.singleTitle' : 'settings.modelPicker.title')}
      description={ready ? t(single ? 'settings.modelPicker.singleResults' : 'settings.modelPicker.results', {service: serviceName, count: returnedModelCount}) : undefined}
      initialFocus={() => search.current ?? cancel.current} finalFocus={triggerRef} footer={footer}
      onKeyDown={event => {
        if (!search.current || event.defaultPrevented || event.altKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return;
        event.preventDefault();
        event.stopPropagation();
        search.current.focus();
        search.current.select();
      }}>
      {ready && <>
        <div className="model-picker-toolbar">
          <div className="model-picker-search">
            <Icon name="search" size={14} />
            <Input ref={search} type="search" value={query} onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault();}}
              aria-label={t('settings.modelPicker.search')} placeholder={t('settings.modelPicker.search')}
              aria-keyshortcuts={mac ? 'Meta+F' : 'Control+F'} />
            <kbd aria-hidden="true">{mac ? '⌘F' : 'Ctrl+F'}</kbd>
          </div>
          {!single && <WorkbenchButton type="button" size="compact" variant="ghost" disabled={visibleChoices.every(item => selection.has(item.id))}
            onClick={() => setSelection(previous => new Set([...previous, ...visibleChoices.map(item => item.id)]))}>{t('settings.modelPicker.selectAll')}</WorkbenchButton>}
          <WorkbenchButton type="button" size="compact" variant="ghost" disabled={!selected.length}
            onClick={() => setSelection(new Set())}>{t('settings.modelPicker.clear')}</WorkbenchButton>
        </div>
      </>}
      {(ready || visible.length > 0) &&
        <ul className="model-picker-list" aria-label={t(single ? 'settings.modelPicker.singleTitle' : 'settings.modelPicker.list')}>
          {visible.map(item => {
            const locked = item.active || item.added;
            const disabled = Boolean(locked || item.unavailable);
            const checked = !disabled && selection.has(item.id);
            const inputProps = {
              disabled,
              'aria-label': item.label ?? item.id,
              onChange: (event: ChangeEvent<HTMLInputElement>) => {if (!disabled) toggle(item.id, event.target.checked);},
            };
            return <li key={item.id}>
              <label className="model-picker-row" data-locked={disabled || undefined} data-selected={checked || undefined}>
                {single
                  ? <Input type="radio" className="wb-radio" name={radioName}
                    checked={Boolean(checked || locked && selected.length === 0)} {...inputProps} />
                  : <input type="checkbox" className="wb-checkbox" checked={Boolean(locked || checked)} {...inputProps} />}
                <span className="model-picker-name" title={item.id}>{item.label ?? item.id}</span>
                {item.verified !== undefined && <WorkbenchBadge tone={item.verified ? 'success' : 'warning'}>{t(item.verified ? 'agent.settings.x6.adapted' : 'agent.settings.x6.unverified')}</WorkbenchBadge>}
                <span className="model-picker-row-state">{item.active ? t('settings.modelPicker.inUse') : locked ? t(single ? 'settings.modelPicker.current' : 'settings.modelPicker.added') :
                  item.unavailable ? t('settings.modelPicker.unavailable') : checked ? t(single ? 'settings.modelPicker.willUse' : 'settings.modelPicker.willAdd') : null}</span>
              </label>
            </li>;
          })}
        </ul>}
      {ready ? <>
        {!visible.some(matchesSearch) && <p className="model-picker-status" role="status">{t('settings.modelPicker.noMatch')}</p>}
        {statusMessage && <p className="model-picker-status" role="status">{statusMessage}</p>}
      </> : <p className="model-picker-status" role={status === 'error' ? 'alert' : 'status'}>
        {statusMessage ?? t(status === 'loading' ? 'agent.settings.models.loading' : status === 'empty' ? 'agent.settings.models.empty' : 'agent.settings.models.unreachable')}
      </p>}
      <p className="model-picker-note">{t(single ? 'settings.modelPicker.singleNote' : 'settings.modelPicker.manual')}{usesDraftKey && <> {t('settings.modelPicker.draftKey')}</>}</p>
      {capacity !== null && <p className="model-picker-limit" role="status">{t('settings.modelPicker.limit', {count: capacity})}</p>}
    </WorkbenchDialogContent>
  </Dialog>;
}

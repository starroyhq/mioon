import React, { useLayoutEffect, useRef, useState } from 'react';
import { Label } from '@mioon/ui/components/label';
import { Slider } from '@mioon/ui/components/slider';
import { Switch } from '@mioon/ui/components/switch';
import { WorkbenchSelect } from '@mioon/ui/components/workbench-select';
import { WorkbenchAlert, WorkbenchBadge, WorkbenchButton } from '@mioon/ui/components/workbench-controls';
import { useI18n } from './i18n/I18nProvider.tsx';
import { useUiPreferences } from './UiPreferencesProvider.tsx';
import { createSettingsNavigationReporter } from './settings-navigation-state.ts';
import type { SettingsNavigationState } from './settings-navigation-state.ts';
import type { UiPreferences } from '../../../packages/contracts/src/ui-preferences.ts';

export default function SettingsAppearance({ active = true, onNavigationStateChange }: { active?: boolean; onNavigationStateChange?: (state: SettingsNavigationState) => void }) {
  const { t } = useI18n();
  const state = useUiPreferences();
  const [reporter] = useState(createSettingsNavigationReporter);
  const visible = useRef(active); visible.current = active;
  const live = useRef(true);
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const disabled = state.phase === 'loading' || state.phase === 'saving' || state.pending || !state.saved?.writable;
  const navigation = { dirty: state.dirty, phase: state.phase === 'conflict' ? 'blocked' : state.phase === 'loading' && !active ? 'ready' : state.phase, recovery: state.pending };
  useLayoutEffect(() => {
    const owner = reporter.connect(onNavigationStateChange, navigation);
    return () => reporter.disconnect(owner);
  }, [reporter, onNavigationStateChange]);
  useLayoutEffect(() => { reporter.update(navigation); }, [reporter, state.dirty, state.phase, state.pending, state.preferences, active]);
  const edit = (patch: Partial<UiPreferences>) => {
    if (disabled || !visible.current || !live.current) return;
    reporter.update({ dirty: true, phase: 'ready' });
    state.edit(patch);
  };
  return <section className="settings-appearance" aria-labelledby="settings-appearance-heading" data-testid="settings-appearance">
    <h2 id="settings-appearance-heading">{t('appearance.title')}</h2>
    {state.phase === 'loading' && <p role="status">{t('appearance.loading')}</p>}
    {(state.phase === 'error' || state.phase === 'conflict') && <WorkbenchAlert tone="warning" actions={<WorkbenchButton onClick={async () => { if (live.current && visible.current && await state.reload() && live.current && visible.current) state.discard(); }}>{t('appearance.reload')}</WorkbenchButton>}>{t(state.phase === 'conflict' ? 'appearance.conflict' : 'appearance.error')}</WorkbenchAlert>}
    {state.saved && !state.saved.writable && <WorkbenchAlert>{t('appearance.readonly')}</WorkbenchAlert>}
    {state.saved?.recoveredDefaults && <WorkbenchAlert tone="warning">{t('appearance.recovered')}</WorkbenchAlert>}
    <div className="settings-appearance-row"><Label htmlFor="appearance-theme">{t('appearance.theme')}</Label><WorkbenchSelect id="appearance-theme" data-testid="appearance-theme" value={state.preferences.theme} disabled={disabled} onChange={event => { const theme = event.target.value; if (theme === 'dark' || theme === 'light' || theme === 'system') edit({ theme }); }}><option value="dark">{t('appearance.dark')}</option><option value="light">{t('appearance.light')}</option><option value="system">{t('appearance.system')}</option></WorkbenchSelect></div>
    <div className="settings-appearance-row"><Label id="appearance-scale-label">{t('appearance.scale')}</Label><div className="settings-appearance-scale"><Slider aria-labelledby="appearance-scale-label" data-testid="appearance-scale" thumbAlignment="center" min={90} max={125} step={1} value={[state.preferences.scalePercent]} disabled={disabled} onValueChange={value => edit({ scalePercent: Math.round(typeof value === 'number' ? value : value[0] ?? 100) })} /><output>{state.preferences.scalePercent}%</output></div></div>
    <div className="settings-appearance-row"><Label htmlFor="appearance-density">{t('appearance.density')}</Label><WorkbenchSelect id="appearance-density" data-testid="appearance-density" value={state.preferences.density} disabled={disabled} onChange={event => edit({ density: event.target.value === 'compact' ? 'compact' : 'standard' })}><option value="standard">{t('appearance.standard')}</option><option value="compact">{t('appearance.compact')}</option></WorkbenchSelect></div>
    <div className="settings-appearance-row"><Label htmlFor="appearance-timecode">{t('appearance.timecode')}</Label><WorkbenchSelect id="appearance-timecode" data-testid="appearance-timecode" value={state.preferences.timecodeFormat} disabled={disabled} onChange={event => edit({ timecodeFormat: event.target.value === 'seconds' ? 'seconds' : 'timecode' })}><option value="timecode">{t('appearance.frames')}</option><option value="seconds">{t('appearance.seconds')}</option></WorkbenchSelect></div>
    <div className="settings-appearance-row"><Label htmlFor="appearance-motion">{t('appearance.reduceMotion')}</Label><Switch id="appearance-motion" data-testid="appearance-motion" checked={state.preferences.reduceMotion} disabled={disabled} onCheckedChange={checked => edit({ reduceMotion: checked })} /></div>
    <footer className="settings-appearance-actions"><WorkbenchBadge tone={state.dirty || state.pending || !state.saved ? 'warning' : 'success'} dot>{t(!state.saved ? state.phase === 'loading' ? 'appearance.loading' : 'appearance.error' : state.dirty || state.pending ? 'appearance.draft' : 'appearance.saved')}</WorkbenchBadge><WorkbenchButton disabled={disabled || !state.dirty} onClick={() => { if (live.current && visible.current) state.discard(); }}>{t('appearance.discard')}</WorkbenchButton><WorkbenchButton variant="primary" loading={state.phase === 'saving'} disabled={!state.saved?.writable || state.phase === 'loading' || state.phase === 'conflict' || !state.dirty && !state.pending} data-testid="appearance-save" onClick={() => { if (!live.current || !visible.current) return; reporter.update({ dirty: state.dirty, phase: 'saving' }); void state.save(); }}>{t(state.pending ? 'appearance.retry' : 'appearance.save')}</WorkbenchButton></footer>
  </section>;
}

export function UiPreferencesNotice() {
  const { t } = useI18n();
  const { recentError } = useUiPreferences();
  return recentError ? <p className="settings-appearance-hint" role="status">{t('appearance.recentError')}</p> : null;
}

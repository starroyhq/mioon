import React, { useRef, useState } from 'react';
import { Switch } from '@mioon/ui/components/switch';
import { useI18n } from './i18n/I18nProvider.tsx';
import { useUiPreferences } from './UiPreferencesProvider.tsx';
import { mioFollowColor } from './mio-follow.ts';
import type { MioFollowFocus } from './mio-follow.ts';
import Icon from './icons.tsx';

export interface MioFollowControlProps {
  readonly focus?: MioFollowFocus | null;
  readonly visible: boolean;
  readonly canInteract?: () => boolean;
  readonly onErrorChange?: (failed: boolean) => void;
}

export default function MioFollowControl({ focus = null, visible, canInteract, onErrorChange }: MioFollowControlProps): React.ReactElement {
  const { t } = useI18n();
  const preferences = useUiPreferences();
  const [saving, setSaving] = useState(false);
  const flight = useRef(false);
  const visibility = useRef(visible);
  visibility.current = visible;
  const retry = preferences.mioFollowRetry;
  const disabled = !visible || saving || !preferences.saved?.writable
    || preferences.phase === 'loading' || preferences.phase === 'saving'
    || (preferences.pending && retry === undefined);

  async function save(enabled: boolean): Promise<void> {
    if (disabled || flight.current || !visibility.current || canInteract?.() === false) return;
    flight.current = true;
    setSaving(true);
    onErrorChange?.(false);
    try {
      onErrorChange?.(!await preferences.setMioFollow(retry ?? enabled));
    } catch {
      onErrorChange?.(true);
    } finally {
      flight.current = false;
      setSaving(false);
    }
  }

  return <label className="mio-follow-control" style={focus ? { '--mio-follow-color': mioFollowColor(focus.runId) } as React.CSSProperties : undefined}>
    <Icon name="locate" size={12} />
    <span>{t('agent.follow.toggle')}</span>
    <Switch size="sm" data-testid="mio-follow-toggle" aria-label={t('agent.follow.toggle')}
      checked={preferences.preferences.mioFollow} disabled={disabled}
      onCheckedChange={enabled => { void save(enabled); }} />
  </label>;
}

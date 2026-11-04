import React, {useEffect, useRef, useState} from 'react';
import {Button} from '@mioon/ui/components/button';
import {useI18n} from './i18n/I18nProvider.tsx';
import {readWorkspaceSettings} from './workspace-settings-client.ts';
const listeners = new Set<() => void>();
/** Invalidate local gate metadata after its separate persisted save succeeds. */
export const notifyGenerationLiveGateChanged = (): void => {for (const listener of listeners) listener();};
export default function GenerationLiveGateNotice({active, pageKey, onOpen}: {active: boolean; pageKey: string; onOpen: () => void}) {
  const {t} = useI18n(), [enabled, setEnabled] = useState<boolean | null>(null), current = useRef({active, pageKey, onOpen});
  current.current = {active, pageKey, onOpen};
  useEffect(() => {
    if (!active) return;
    let live = true, epoch = 0, pending: AbortController | null = null;
    const read = () => {pending?.abort(); pending = new AbortController(); const token = ++epoch; void readWorkspaceSettings(pending.signal).then(settings => {if (live && token === epoch) setEnabled(settings.liveGeneration);}, () => {if (live && token === epoch) setEnabled(null);});};
    setEnabled(null); listeners.add(read); read();
    return () => {live = false; ++epoch; pending?.abort(); listeners.delete(read);};
  }, [active, pageKey]);
  if (!active || enabled !== false) return null;
  return <p role="status" className="image-generation-notice" data-testid="generation-live-disabled">{t('redesign.settings.liveDisabled')} <Button type="button" variant="ghost" onClick={() => {if (current.current.active && current.current.pageKey === pageKey) current.current.onOpen();}}>{t('redesign.settings.openLiveGeneration')}</Button></p>;
}

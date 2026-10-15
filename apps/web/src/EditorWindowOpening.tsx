import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import { Button } from '@mioon/ui/components/button';
export default function EditorWindowOpening({ error, onRetry, onProjects }: { readonly error: string | DisplayMessage; readonly onRetry: () => void; readonly onProjects: () => void }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  return <main className="boot-page" data-testid="editor-window-opening" role={error ? 'alert' : 'status'}>
    <h1>{error ? t('projects.openUnavailable') : t('projects.opening')}</h1>
    <p>{error ? renderMessage(error) : t('projects.checkingSavedView')}</p>
    {error && <Button variant="outline" onClick={onRetry}>{t('projects.retryThis')}</Button>}
    <Button variant="ghost" onClick={onProjects}>{t('projects.openWorkspace')}</Button>
    <p>{t('projects.otherWindowPreserved')}</p>
  </main>;
}

import React, { Component, Suspense, lazy, useLayoutEffect, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { WorkbenchButton } from '@mioon/ui/components/workbench-controls';
import { ArrowLeft } from '@mioon/ui/components/workbench-icons';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { PrevisEditorProps } from './PrevisEditor.tsx';
import './previs.css';

// The editor and three.js load only when a previs is opened, as a separate
// chunk; the canvas, card and inspector never import them.
const load = () => import('./PrevisEditor.tsx');
class LoadBoundary extends Component<{ fallback: (retry: () => void) => ReactNode; onRetry: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  override componentDidCatch(_error: unknown, _info: ErrorInfo): void { /* The fallback offers a retry and the way back. */ }
  override render(): ReactNode { return this.state.failed ? this.props.fallback(() => { this.setState({ failed: false }); this.props.onRetry(); }) : this.props.children; }
}
/** While the editor is open, everything already on the page behind it is
 * inert, so Tab and assistive technology stay in the editor. Popups and
 * confirmations opened from the editor come later and stay usable. */
function useModalLayer(): React.RefObject<HTMLDivElement | null> {
  const layer = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const own = layer.current;
    if (!own) return;
    const marked = [...document.body.children].filter((element): element is HTMLElement =>
      element instanceof HTMLElement && element !== own && !element.contains(own) && !element.inert && element.tagName !== 'SCRIPT');
    for (const element of marked) element.inert = true;
    return () => { for (const element of marked) element.inert = false; };
  }, []);
  return layer;
}
export default function PrevisEditorHost(props: PrevisEditorProps): React.ReactElement {
  const { t } = useI18n(), [attempt, setAttempt] = useState(0), layer = useModalLayer();
  const [Editor, setEditor] = useState(() => lazy(load));
  const status = (content: ReactNode) => <div className="previs-editor-loading" role="dialog" aria-modal="true" aria-label={t('previs.editor.label')} data-testid="previs-editor-loading">{content}</div>;
  return <div className="previs-editor-layer" ref={layer}><LoadBoundary key={attempt} onRetry={() => { setEditor(() => lazy(load)); setAttempt(value => value + 1); }}
    fallback={retry => status(<><span role="alert">{t('previs.editor.loadFailed')}</span><WorkbenchButton variant="secondary" size="compact" onClick={retry}>{t('previs.editor.retry')}</WorkbenchButton><WorkbenchButton variant="secondary" size="compact" onClick={props.onClose}><ArrowLeft size={14} aria-hidden="true" />{t('previs.editor.back')}</WorkbenchButton></>)}>
    <Suspense fallback={status(<><span className="spinner" aria-hidden="true" /><span role="status">{t('previs.editor.loading')}</span></>)}><Editor {...props} /></Suspense>
  </LoadBoundary></div>;
}

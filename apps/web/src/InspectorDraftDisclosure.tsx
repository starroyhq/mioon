import React from 'react';
import type {ReactNode} from 'react';
import type {ClipDraftState} from './clip-draft-state.ts';
import {useI18n} from './i18n/I18nProvider.tsx';
/** Routine storage information stays reachable; a retained draft, uncertain
 * result or active composition opens its recovery controls automatically. */
export default function InspectorDraftDisclosure({state,children}:{state:ClipDraftState;children:ReactNode}) {
  const {t}=useI18n();
  const attention=Boolean(state.candidate||state.failure||state.error||state.businessPending||state.autosavePaused||state.compositionPending);
  return <details className="edit-inspector-draft" open={attention||undefined}><summary>{t('recovery.clip.label')}</summary>{children}</details>;
}

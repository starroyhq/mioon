import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import type { LookPackInspection } from '../../../packages/contracts/src/look-pack.ts';
import { createLookPackIntake } from './look-pack-intake.ts';
import type { LookPackFile, LookPackIntakeState } from './look-pack-intake.ts';

export function LookPackDetails({ value }: { value: LookPackInspection }) {
  const { t } = useI18n();
  const manifest = value.manifest;
  return <div className="look-pack-details" data-testid="look-pack-details">
    <p><strong>{manifest.title}</strong> · {manifest.version}</p>
    <p className="input-hint">{t('colour.pack.identity', { id: manifest.id, publisher: manifest.publisher.name, publisherId: manifest.publisher.id })}</p>
    <p className="input-hint">{t('colour.pack.content', { bytes: manifest.asset.sizeBytes })}<span style={{ overflowWrap: 'anywhere' }}>{manifest.asset.sha256}</span></p>
    <p className="input-hint" style={{ overflowWrap: 'anywhere' }}>{t('colour.pack.source', { url: manifest.provenance.url })}</p>
    <Label className="field-label">{t('colour.pack.license', { license: manifest.license.identifier })}</Label>
    <p className="input-hint" data-testid="look-pack-license" style={{ maxHeight: 160, overflow: 'auto', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{manifest.license.text}</p>
    <p className="notice warning" data-testid="look-pack-claims-disclosure">{t('colour.pack.claims')}</p>
  </div>;
}

export default function LookPackControls({ scope, disabled, adopt }: {
  scope: string; disabled: boolean; adopt: (file: LookPackFile) => Promise<boolean>;
}) {
  const { t, renderMessage } = useI18n();
  const latest = useRef({ scope, disabled, adopt }); latest.current = { scope, disabled, adopt };
  const [observed, setObserved] = useState<LookPackIntakeState | null>(null);
  const ref = useRef<ReturnType<typeof createLookPackIntake> | null>(null);
  if (!ref.current) ref.current = createLookPackIntake({ getScope: () => latest.current.scope, isBlocked: () => latest.current.disabled,
    adopt: file => latest.current.adopt(file), onChange: setObserved });
  const controller = ref.current, state = observed ?? controller.getState();
  useLayoutEffect(() => { controller.activate(); controller.refresh(); return () => controller.dispose(); }, [controller]);
  useLayoutEffect(() => { controller.refresh(); }, [controller, scope]);
  const busy = state.phase === 'reading' || state.phase === 'adopting';
  return <section data-testid="look-pack-controls" aria-label={t('colour.pack.title')} style={{ margin: '16px 0', padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
    <Label className="field-label" htmlFor="look-pack-file">{t('colour.pack.previewLabel')}</Label>
    <p className="input-hint">{t('colour.pack.previewDisclosure')}</p>
    <Input id="look-pack-file" data-testid="look-pack-file" type="file" accept=".mioon-look.cube" disabled={disabled || state.phase === 'adopting'} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void controller.preview(file); }} />
    {state.phase === 'reading' && <p className="input-hint" role="status">{t('colour.pack.checking')}</p>}
    {state.inspection && <LookPackDetails value={state.inspection} />}
    {state.phase === 'ready' && <>
      <label className="field-label"><input type="checkbox" data-testid="look-pack-acknowledge" disabled={disabled} checked={state.acknowledged} onChange={event => controller.acknowledge(event.target.checked)} />{t('colour.pack.acknowledge')}</label>
      <Button type="button" size="sm" data-testid="adopt-look-pack" disabled={disabled || !state.acknowledged} onClick={() => { void controller.adopt(); }}>{t('colour.pack.adopt')}</Button>
    </>}
    {state.phase === 'adopting' && <p className="input-hint" role="status">{t('colour.pack.adopting')}</p>}
    {state.phase === 'adopted' && <p className="notice" role="status" data-testid="look-pack-adopted">{t('colour.pack.adopted')}</p>}
    {state.error && <p className="notice warning" role="alert" data-testid="look-pack-error">{state.errorMessage ? renderMessage(state.errorMessage) : t('colour.pack.invalid')}</p>}
    {state.phase !== 'idle' && <Button type="button" variant="ghost" size="sm" data-testid="cancel-look-pack" disabled={state.phase === 'adopting'} onClick={() => controller.cancel()}>{busy ? t('colour.pack.cancelPreview') : t('colour.pack.closePreview')}</Button>}
    <p className="input-hint">{t('colour.pack.storageDisclosure')}</p>
  </section>;
}

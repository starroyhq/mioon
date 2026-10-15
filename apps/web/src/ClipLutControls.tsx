import { useI18n } from './i18n/I18nProvider.tsx';
import LookPackControls, { LookPackDetails } from './LookPackControls.tsx';
import React, { useLayoutEffect, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { Separator } from '@mioon/ui/components/separator';
import type { ClipColour } from '../../../packages/contracts/src/timeline-colour.ts';
import { createClipDraftClient } from './clip-draft-client.ts';
import { clipLutSourceMessage, createClipLutController } from './clip-lut-state.ts';
import type { ClipLutContext, ClipLutController, ClipLutRpc, ClipLutState } from './clip-lut-state.ts';

type SelectProps = { id: string; 'data-testid': string; value: string; disabled?: boolean; children: ReactNode; onChange: (event: { target: { value: string } }) => void };
export interface ClipLutControlsProps {
  context: ClipLutContext; kind: string; restored?: boolean;
  onEdit: (key: 'colour', value: ClipColour | null) => void; rpc: ClipLutRpc; Select: ComponentType<SelectProps>;
}
export default function ClipLutControls({ context, kind, restored = false, onEdit, rpc, Select }: ClipLutControlsProps) {
  const { t, renderMessage } = useI18n();
  const latest = useRef({ context, onEdit, rpc }); latest.current = { context, onEdit, rpc };
  const [observed, setObserved] = useState<ClipLutState | null>(null), ref = useRef<ClipLutController | null>(null);
  if (!ref.current) ref.current = createClipLutController({ getContext: () => latest.current.context, readWorkspace: key => createClipDraftClient().get(key),
    rpc: (operation, input, options) => latest.current.rpc(operation, input, options), edit: value => latest.current.onEdit('colour', value), onChange: setObserved });
  const controller = ref.current;
  const identity = JSON.stringify([context.scope, context.projectId, context.timelineId, context.clipId, context.assetId, context.assetSha256]);
  useLayoutEffect(() => { controller.activate(); controller.refresh(); return () => controller.dispose(); }, [controller]);
  useLayoutEffect(() => { controller.refresh(); }, [controller, identity]);
  const state = observed ?? controller.getState(), colour = context.colour, blocked = context.blocked;
  if (kind === 'audio') return null;
  if (kind !== 'video' && kind !== 'image') return null;
  const image = kind === 'image', imageInspection = state.inspection && 'kind' in state.inspection ? state.inspection : null, videoInspection = state.inspection && !('kind' in state.inspection) ? state.inspection : null;
  const issue = clipLutSourceMessage(state.inspection, state.range), source = colour?.source, look = colour?.look;
  const importRecord = state.importRecord;
  const importUnavailable = state.recoveryPhase !== 'ready' || Boolean(state.recovery) || state.importing;
  const resourceName = look && state.resources.find(item => item.id === look.resourceId)?.name;
  const selectedLook = look && state.selected?.id === look.resourceId;
  return <section data-testid="clip-lut-controls" aria-labelledby="clip-lut-title">
    <Separator className="section-divider" />
    <div className="section-heading"><span id="clip-lut-title">{t('colour.lut.title')}</span></div>
    <p className="input-hint" data-testid="clip-lut-render-disclosure">{t('colour.lut.renderDisclosure')}</p>
    {!colour && <p className="notice warning" data-testid="clip-lut-adoption-warning">{t('colour.lut.adoptionWarning')}</p>}
    {colour && !source && <p className="notice warning" role="alert" data-testid="clip-lut-reconfirm-source">{t('colour.lut.reconfirmSource')}</p>}
    {source && <p className="input-hint" data-testid="clip-lut-source-confirmed">{'evidence' in source ? t('colour.lut.sourceImage', { format: source.evidence.profileId === 'jfif-ycbcr8-srgb-v1' ? 'JFIF JPEG' : 'PNG', width: source.evidence.width, height: source.evidence.height, alpha: source.evidence.alphaMode === 'straight' ? t('colour.lut.alphaPreserved') : t('colour.lut.opaque') }) : t('colour.lut.sourceVideo', { range: source.range === 'limited' ? 'Limited' : 'Full', stream: source.streamIndex })}</p>}
    {image && <p className="input-hint" data-testid="clip-image-colour-disclosure">{t('colour.lut.imageDisclosure')}</p>}
    {restored && <p className="notice warning" role="status">{t('colour.lut.restoredReadOnly')}</p>}
    {!state.opened ? <Button variant="outline" size="sm" type="button" data-testid="open-clip-lut" disabled={blocked} onClick={() => controller.open()}>{colour ? t('colour.lut.inspectAdjust') : t('colour.lut.inspectEnable')}</Button> : <>
      <fieldset disabled={blocked} style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field-label">{t('colour.lut.sourceLegend')}</legend>
        <Button variant="outline" size="sm" type="button" data-testid="inspect-clip-colour-source" disabled={state.sourcePhase === 'loading'} onClick={() => { void controller.inspectSource(); }}>{state.sourcePhase === 'loading' ? t('colour.lut.inspecting') : t('colour.lut.inspectAgain')}</Button>
        {videoInspection && <p className="input-hint" data-testid="clip-lut-source-evidence">{t('colour.lut.videoEvidence', { primaries: videoInspection.evidence.primaries ?? t('colour.lut.untagged'), transfer: videoInspection.evidence.transfer ?? t('colour.lut.untagged'), matrix: videoInspection.evidence.matrix ?? t('colour.lut.untagged'), range: videoInspection.evidence.range ?? t('colour.lut.untagged'), pixel: videoInspection.evidence.pixelFormat ?? t('colour.lut.unknown'), hdr: t(videoInspection.evidence.hdrMetadata ? 'colour.lut.hdrMetadata' : 'colour.lut.noHdrMetadata') })}</p>}
        {imageInspection && <p className="input-hint" data-testid="clip-image-source-evidence">{t('colour.lut.imageEvidence', { verification: t(imageInspection.evidence.profileId === 'jfif-ycbcr8-srgb-v1' ? 'colour.lut.jpegVerified' : 'colour.lut.pngVerified'), width: imageInspection.evidence.width, height: imageInspection.evidence.height, alpha: imageInspection.evidence.alphaMode === 'straight' ? 'Straight alpha' : t('colour.lut.noAlpha'), tag: t(imageInspection.evidence.colourTag === 'srgb' ? 'colour.lut.srgbTag' : 'colour.lut.noSrgbTag') })}</p>}
        {state.sourceError && <p className="notice warning" role="alert">{state.sourceErrorMessage ? renderMessage(state.sourceErrorMessage) : t('colour.error.sourceCheckFailed')}</p>}
        {!image && <><Label className="field-label" htmlFor="clip-lut-source-range">{t('colour.lut.rangeLabel')}</Label>
        <Select id="clip-lut-source-range" data-testid="clip-lut-source-range" value={state.range} disabled={state.sourcePhase !== 'ready' || state.inspection?.status === 'unsupported'} onChange={event => controller.chooseRange(event.target.value)}>
          <option value="">{t('colour.lut.chooseRange')}</option><option value="limited">{t('colour.lut.limited')}</option><option value="full">{t('colour.lut.full')}</option>
        </Select></>}
        {state.inspection && issue && <p className="notice warning" role="status" data-testid="clip-lut-source-issue">{renderMessage(issue)}</p>}
        <label className="field-label"><input type="checkbox" data-testid="clip-lut-source-declaration" checked={state.sourceDeclared} disabled={Boolean(issue)} onChange={event => controller.declareSource(event.target.checked)} />{image ? t('colour.lut.declareImage') : t('colour.lut.declareVideo')}</label>
        <Button size="sm" type="button" data-testid="confirm-clip-colour-source" disabled={Boolean(issue) || !state.sourceDeclared || state.sourcePhase !== 'ready'} onClick={() => controller.confirmSource()}>{colour ? t('colour.lut.confirmSource') : t('colour.lut.enableSource')}</Button>
      </fieldset>
      <fieldset disabled={blocked} style={{ border: 0, padding: 0, margin: '16px 0 0' }}>
        <legend className="field-label">{t('colour.lut.lookLegend')}</legend>
        <p className="input-hint">{t('colour.lut.creativeOnly')}</p>
        <p className="input-hint" data-testid="clip-lut-domain-disclosure">{t('colour.lut.domainDisclosure')}</p>
        <LookPackControls scope={identity} disabled={blocked || importUnavailable} adopt={file => controller.importFile(file, { lookPackConfirmed: true })} />
        <Label className="field-label" htmlFor="clip-lut-file">{t('colour.lut.importLabel')}</Label>
        <Input id="clip-lut-file" data-testid="clip-lut-file" type="file" accept=".cube" disabled={importUnavailable} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void controller.importFile(file); }} />
        {state.importing && <p className="input-hint" role="status">{t('colour.lut.importing')}</p>}
        {state.importError && <p className="notice warning" role="alert">{state.importErrorMessage ? renderMessage(state.importErrorMessage) : t('colour.error.importUnconfirmed')}</p>}
        {importRecord?.phase === 'imported' && <p className="notice" role="status" data-testid="clip-lut-import-success">{t('colour.lut.imported', { name: importRecord.resource?.name ?? '' })}</p>}
        {importRecord?.phase === 'rejected' && <p className="notice warning" role="alert">{t('colour.lut.importRejected')}{importRecord.errorMessage && <span> {renderMessage(importRecord.errorMessage)}</span>}</p>}
        <p className="input-hint" data-testid="clip-lut-recovery-disclosure">{t('colour.lut.recoveryDisclosure')}</p>
        {state.recoveryPhase === 'loading' && <p className="input-hint" role="status">{t('colour.lut.checkingRecovery')}</p>}
        {state.recoveryError && <p className="notice warning" role="alert" data-testid="clip-lut-recovery-error">{state.recoveryErrorMessage ? renderMessage(state.recoveryErrorMessage) : t('colour.error.recoveryCheckFailed')}</p>}
        {(state.recoveryPhase === 'error' || state.recovery) && <Button variant="outline" size="sm" type="button" data-testid="check-clip-lut-recovery" disabled={state.importing} onClick={() => { void controller.checkRecovery(); }}>{t('colour.lut.recheckRecovery')}</Button>}
        {state.recovery && <>
          <p className="notice warning" role="status" data-testid="clip-lut-import-unknown">{t('colour.lut.pendingOriginal', { name: state.recovery.name, bytes: state.recovery.sizeBytes })}{importRecord?.errorMessage && <span> {renderMessage(importRecord.errorMessage)}</span>}</p>
          {!importRecord && <><Label className="field-label" htmlFor="clip-lut-reselect">{t('colour.lut.reselect')}</Label><Input id="clip-lut-reselect" data-testid="clip-lut-reselect" type="file" accept=".cube" disabled={state.importing || state.recoveryPhase !== 'ready'} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void controller.reselectImportFile(file); }} /></>}
          {importRecord?.phase === 'unknown' && <Button variant="outline" size="sm" type="button" data-testid="retry-clip-lut-import" disabled={state.importing || state.recoveryPhase !== 'ready'} onClick={() => { void controller.retryImport(); }}>{t('colour.lut.retryOriginal')}</Button>}
          {importRecord && ['imported', 'rejected'].includes(importRecord.phase) && <Button variant="outline" size="sm" type="button" data-testid="clear-confirmed-clip-lut-recovery" disabled={state.importing} onClick={() => { void controller.clearConfirmedRecovery(); }}>{t('colour.lut.clearConfirmed')}</Button>}
        </>}
        <Label className="field-label" htmlFor="clip-lut-resource">{t('colour.lut.projectLuts')}</Label>
        <Select id="clip-lut-resource" data-testid="clip-lut-resource" value={state.selectedId} disabled={state.listPhase === 'loading'} onChange={event => { void controller.selectResource(event.target.value); }}>
          <option value="">{t('colour.lut.chooseLut')}</option>{state.resources.map(resource => <option key={resource.id} value={resource.id}>{resource.name} · {resource.metadata.size}³</option>)}
        </Select>
        <Button variant="ghost" size="sm" type="button" disabled={state.listPhase === 'loading'} onClick={() => { void controller.loadResources(); }}>{t('colour.lut.refresh')}</Button>
        {state.nextAfter && <Button variant="ghost" size="sm" type="button" data-testid="clip-lut-more" disabled={state.listPhase === 'loading'} onClick={() => { void controller.loadResources(true); }}>{t('colour.lut.more')}</Button>}
        {state.listError && <p className="notice warning" role="alert">{state.listErrorMessage ? renderMessage(state.listErrorMessage) : t('colour.error.listFailed')}</p>}
        {state.resourcePhase === 'loading' && <p role="status" className="input-hint">{t('colour.lut.verifyingLut')}</p>}
        {state.resourceError && <p className="notice warning" role="alert">{state.resourceErrorMessage ? renderMessage(state.resourceErrorMessage) : t('colour.error.resourceFailed')}</p>}
        {state.selected && state.resourcePhase === 'ready' && <>
          <Button type="button" variant="ghost" size="sm" data-testid="inspect-project-look-pack" disabled={state.packPhase === 'loading'} onClick={() => { void controller.inspectSelectedPack(); }}>{state.packPhase === 'loading' ? t('colour.lut.verifyingPack') : t('colour.lut.inspectPack')}</Button>
          {state.packPhase === 'ready' && !state.pack && <p className="input-hint" data-testid="project-lut-not-pack">{t('colour.lut.notPack')}</p>}
          {state.pack && <LookPackDetails value={state.pack} />}
          {state.packError && <p className="notice warning" role="alert">{state.packErrorMessage ? renderMessage(state.packErrorMessage) : t('colour.error.packFailed')}</p>}
        </>}
        <label className="field-label"><input type="checkbox" data-testid="clip-lut-look-declaration" checked={state.lookDeclared} disabled={!state.selected || state.resourcePhase !== 'ready'} onChange={event => controller.declareLook(event.target.checked)} />{t('colour.lut.declareLook')}</label>
        <Button size="sm" type="button" data-testid="apply-clip-lut" disabled={!source || source.assetSha256 !== context.assetSha256 || !state.selected || !state.lookDeclared || state.resourcePhase !== 'ready'} onClick={() => controller.applyLook()}>{t('colour.lut.apply')}</Button>
        {look && <>
          <p className="input-hint" data-testid="clip-lut-bound">{t('colour.lut.bound', { name: resourceName || (selectedLook && state.selected?.name) || look.resourceId })}</p>
          <label className="field-label"><input type="checkbox" data-testid="clip-lut-enabled" checked={look.enabled} onChange={event => controller.changeLook({ enabled: event.target.checked })} />{t('colour.lut.enableLut')}</label>
          <Label className="field-label" htmlFor="clip-lut-strength">{t('colour.lut.strength', { percent: Math.round(look.strength * 100) })}</Label>
          <Input id="clip-lut-strength" data-testid="clip-lut-strength" type="range" min={0} max={100} step={1} value={look.strength * 100} onChange={event => controller.changeLook({ strength: Number(event.target.value) / 100 })} />
          <p className="input-hint">{t('colour.lut.strengthHint')}</p>
          <Button variant="ghost" size="sm" type="button" data-testid="remove-clip-lut" onClick={() => controller.removeLook()}>{t('colour.lut.remove')}</Button>
        </>}
        {colour && <Button variant="ghost" size="sm" type="button" data-testid="disable-clip-colour" onClick={() => controller.disableColour()}>{t('colour.lut.disableColour')}</Button>}
        <p className="input-hint" data-testid="clip-lut-save-reminder">{t('colour.lut.saveReminder')}</p>
      </fieldset>
    </>}
  </section>;
}

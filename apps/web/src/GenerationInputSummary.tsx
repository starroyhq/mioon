import { useI18n } from './i18n/I18nProvider.tsx';
import type { MessageArguments, MessageKey } from '../../../packages/i18n/src/index.ts';
import { creationParameter } from './creation-i18n.ts';
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@mioon/ui/components/collapsible';
import Icon from './icons.tsx';
import { generationProfileSelection, generationIssueDescriptor } from './generation-settings.ts';
import type { GenerationInputProfile, GenerationInputRoleRule, GenerationProfileSelection, GenerationProvider } from './generation-settings.ts';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';
import './generation-input-summary.css';

type Translator = <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => string;
const roles = (t: Translator): [string, string][] => [
  ['first_frame', t('generation.inputs.firstFrameRole')], ['last_frame', t('generation.inputs.lastFrameRole')],
  ['reference_image', t('video.wan.referenceImages')], ['reference_audio', t('video.seedance.audios')],
  ['subject_reference', t('generation.inputs.subjectRole')], ['style_reference', t('generation.inputs.styleRole')], ['motion_reference', t('generation.inputs.motionRole')],
];
const countLabel = (rule: GenerationInputRoleRule, role: string, t: Translator): string => rule.min === rule.max ? t(role === 'reference_audio' ? 'generation.inputs.itemCount' : 'generation.inputs.imageCount', { count: Number(rule.max) || 0 }) : t(role === 'reference_audio' ? 'generation.inputs.itemRange' : 'generation.inputs.imageRange', { min: Number(rule.min) || 0, max: Number(rule.max) || 0 });
const bytesLabel = (value: number, t: Translator, formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string): string => `${Number.isInteger(value / 1048576) ? `${value / 1048576} MiB · ` : ''}${t('generation.inputs.bytes', { value: formatNumber(value) })}`;
const sourceUrl = (value: unknown): string | null => typeof value === 'string' && /^https:\/\//.test(value) ? value : null;
// provider.list is polled. Fresh objects with the same displayed profile are
// the same disclosure scope, including when JSON property order changes.
const semanticKey = (value: unknown): string => JSON.stringify(value, (_, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item as Record<string, unknown>).sort().map(key => [key, (item as Record<string, unknown>)[key]])) : item);
const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function RoleLimits({ role, label, rule }: { role: string; label: string; rule: GenerationInputRoleRule }): ReactElement {
  const { t, formatNumber } = useI18n();
  const dimensions = rule.dimensions;
  const mimeTypes = stringList(rule.mimeTypes);
  const { maxBytes, maxDataUriBytes } = rule;
  const pixelBounds = dimensions ? [dimensions.min && t('generation.inputs.minimumDimensions', { min: creationParameter(dimensions.min) }), dimensions.max && t('generation.inputs.maximumDimensions', { max: creationParameter(dimensions.max) }), dimensions.matchAspectRatio && t('generation.inputs.matchAspectRatio'), dimensions.matchAspectRatio === false && t('generation.inputs.independentAspectRatio'), dimensions.minAspectRatio && t('generation.inputs.minimumAspectRatio', { minAspectRatio: creationParameter(dimensions.minAspectRatio) }), dimensions.maxAspectRatio && t('generation.inputs.maximumAspectRatio', { maxAspectRatio: creationParameter(dimensions.maxAspectRatio) })].filter(Boolean).join(' · ') : '';
  return <li data-testid={`generation-role-${role}`}>
    <div className="generation-input-role-heading"><strong>{label}</strong><span>{countLabel(rule, role, t)}</span></div>
    {mimeTypes.length > 0 && <p>{t('generation.inputs.formats', { value: creationParameter(mimeTypes.map(type => type.replace(/^(image|audio)\//, '').toUpperCase()).join(' / ')) })}</p>}
    {typeof maxBytes === 'number' && Number.isSafeInteger(maxBytes) && <p>{t('generation.inputs.singleFile', { value: creationParameter(t('generation.inputs.maximumBytes', { value: creationParameter(bytesLabel(maxBytes, t, formatNumber)) })) })}</p>}
    {typeof maxDataUriBytes === 'number' && Number.isSafeInteger(maxDataUriBytes) && <p>{t('generation.inputs.dataUriLimit', { value: creationParameter(bytesLabel(maxDataUriBytes, t, formatNumber)) })}</p>}
    {pixelBounds && <p>{t('generation.inputs.dimensions', { value: creationParameter(pixelBounds) })}</p>}
  </li>;
}

export interface GenerationInputDetailsProps { selection: GenerationProfileSelection }

// Read-only rendering of the selected server profile. Subject-library bindings
// never enter this component or become generation references implicitly.
export function GenerationInputDetails({ selection }: GenerationInputDetailsProps): ReactElement {
  const { t, renderMessage } = useI18n();
  const { profile, evaluation, region, evaluatedAsOf } = selection;
  if (!profile) return <p>{renderMessage(selection.displayMessage)}</p>;
  const lifecycle = profile.lifecycle;
  const source = sourceUrl(lifecycle?.source);
  const supportedRoles = roles(t).flatMap(([role, label]) => {
    const rule = profile.inputs?.roles?.[role];
    return rule?.implemented ? [{ role, label, rule }] : [];
  });
  return <div className="generation-input-details-body">
    <p>{t('generation.inputs.totalReferences', { minReferences: creationParameter(profile.inputs?.minReferences), maxReferences: creationParameter(profile.inputs?.maxReferences) })}</p>
    {supportedRoles.length > 0 && <ul className="generation-input-roles" aria-label={t('generation.inputs.roleLimitsAria')}>{supportedRoles.map(({role, label, rule}) => <RoleLimits key={role} role={role} label={label} rule={rule} />)}</ul>}
    <dl className="generation-input-provenance">
      <div><dt>{t('generation.inputs.adapterProfile')}</dt><dd>{String(profile.profileId)} · {String(profile.profileVersion)}</dd></div>
      {profile.reviewedOn && <div><dt>{t('generation.inputs.profileReview')}</dt><dd>{profile.reviewedOn}</dd></div>}
      {evaluatedAsOf && <div><dt>{t('generation.inputs.serverEvaluation')}</dt><dd>{evaluatedAsOf}</dd></div>}
      <div><dt>{t('generation.inputs.apiRegion')}</dt><dd>{String(profile.apiFamily)} · {region}</dd></div>
    </dl>
    {lifecycle && <div className="generation-input-lifecycle-detail">
      <p>{t('generation.inputs.lifecycleDates', { checkedOn: creationParameter(lifecycle.checkedOn), earliestShutdownDate: creationParameter(lifecycle.earliestShutdownDate) })}</p>
      {source && <a href={source} target="_blank" rel="noreferrer">{t('generation.inputs.providerLifecycleLink')}</a>}
      {evaluation?.warnings?.filter(warning => warning.code !== 'MODEL_LIFECYCLE_WARNING').map(warning => <p key={warning.code}>{renderMessage(generationIssueDescriptor(warning))}</p>)}
    </div>}
  </div>;
}

export interface GenerationInputSummaryProps { provider?: unknown; model?: string | null }

export default function GenerationInputSummary({ provider, model }: GenerationInputSummaryProps): ReactElement | null {
  const { t, renderMessage } = useI18n();
  const selection = generationProfileSelection(provider as GenerationProvider | null, model);
  const { profile, state, evaluation, evaluatedAsOf } = selection;
  const visible = useWorkspaceVisibility();
  const selectionKey = semanticKey([(provider as Record<string, unknown> | null)?.id, model, (provider as Record<string, unknown> | null)?.inputProfileVersion, selection]);
  const scope = useMemo(() => ({ selectionKey, visible }), [selectionKey, visible]);
  const current = useRef<{ selectionKey: string; visible: boolean } | null>(scope);
  const [disclosure, setDisclosure] = useState<{ scope: { selectionKey: string; visible: boolean } | null; open: boolean }>({ scope: null, open: false });
  useLayoutEffect(() => {
    current.current = scope;
    return () => { current.current = null; };
  }, [scope]);
  if (!provider || !model) return null;
  const open = visible && disclosure.scope === scope && disclosure.open;
  const lifecycleIssue = evaluation?.issues?.[0];
  const lifecycleMessage = lifecycleIssue?.code === 'MODEL_LIFECYCLE_REVALIDATION_REQUIRED' ? t('generation.inputs.lifecycleBlocked', { evaluatedAsOf: creationParameter(evaluatedAsOf) }) : renderMessage(generationIssueDescriptor(lifecycleIssue));
  return <section className="generation-input-summary" aria-label={t('generation.inputs.limitsAria')} data-testid="generation-input-summary" data-profile-state={state}>
    {lifecycleIssue ? <p className="generation-input-warning" role="status" data-testid="generation-input-lifecycle-blocked">{lifecycleMessage}</p> : profile?.lifecycle && <p className="generation-input-warning" role="status" data-testid="generation-input-lifecycle-warning">{t('generation.inputs.lifecycleWarning', { earliestShutdownDate: creationParameter(profile.lifecycle.earliestShutdownDate), checkedOn: creationParameter(profile.lifecycle.checkedOn) })}</p>}
    <Collapsible open={open} onOpenChange={next => {
      if (visible && current.current === scope) setDisclosure({ scope, open: Boolean(next) });
    }}>
      <CollapsibleTrigger render={<Button variant="ghost" size="sm" />} className="generation-input-toggle" data-testid="generation-input-toggle" disabled={!visible}><span>{t('generation.inputs.viewLimits')}</span><Icon name="down" size={13} /></CollapsibleTrigger>
      <CollapsibleContent className="generation-input-details" data-testid="generation-input-details"><GenerationInputDetails selection={selection} /></CollapsibleContent>
    </Collapsible>
  </section>;
}

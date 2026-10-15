import { useI18n } from './i18n/I18nProvider.tsx';
import { creationParameter } from './creation-i18n.ts';
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@mioon/ui/components/collapsible';
import Icon from './icons.jsx';
import { generationProfileSelection, generationIssueDescriptor } from './generation-settings.js';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';
import './generation-input-summary.css';

const roles = t => [
  ['first_frame', t('generation.inputs.firstFrameRole')], ['last_frame', t('generation.inputs.lastFrameRole')],
  ['subject_reference', t('generation.inputs.subjectRole')], ['style_reference', t('generation.inputs.styleRole')], ['motion_reference', t('generation.inputs.motionRole')],
];
const countLabel = (rule, t) => rule.min === rule.max ? t(rule.implemented ? 'generation.inputs.imageCount' : 'generation.inputs.itemCount', { count: rule.max }) : t(rule.implemented ? 'generation.inputs.imageRange' : 'generation.inputs.itemRange', { min: rule.min, max: rule.max });
const bytesLabel = (value, t, formatNumber) => `${Number.isInteger(value / 1048576) ? `${value / 1048576} MiB · ` : ''}${t('generation.inputs.bytes', { value: formatNumber(value) })}`;
const sourceUrl = value => typeof value === 'string' && /^https:\/\//.test(value) ? value : null;
// provider.list is polled. Fresh objects with the same displayed profile are
// the same disclosure scope, including when JSON property order changes.
const semanticKey = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const regionMeaning = (profile, t) => ({
  runway: t('generation.inputs.runwayRegionMeaning'),
  ark: t('generation.inputs.arkRegionMeaning'),
  veo: t('generation.inputs.veoRegionMeaning'),
  minimax: t('generation.inputs.configuredRegionMeaning'),
  vidu: t('generation.inputs.configuredRegionMeaning'),
  mock: t('generation.inputs.mockRegionMeaning'),
}[profile.providerId] || t('generation.inputs.unknownRegionMeaning'));

function RoleLimits({ role, label, rule }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const dimensions = rule?.dimensions;
  return <li data-testid={`generation-role-${role}`}>
    <div className="generation-input-role-heading"><strong>{label}</strong><span>{rule ? countLabel(rule, t) : t('generation.inputs.unconfirmedCount')}</span></div>
    {!rule ? <p>{t('generation.inputs.roleLimitsUnavailable')}</p> : !rule.implemented ? <p>{t('generation.inputs.roleNotImplemented')}</p> : <>
      <p>{t('generation.inputs.formats', { value: creationParameter(rule.mimeTypes?.length ? rule.mimeTypes.map(type => type.replace('image/', '').toUpperCase()).join(' / ') : t('generation.inputs.undeclared')) })}</p>
      <p>{t('generation.inputs.singleFile', { value: creationParameter(Number.isSafeInteger(rule.maxBytes) ? t('generation.inputs.maximumBytes', { value: creationParameter(bytesLabel(rule.maxBytes, t, formatNumber)) }) : t('generation.inputs.sizeLimitUndeclared')) })}</p>
      {Number.isSafeInteger(rule.maxDataUriBytes) && <p>{t('generation.inputs.dataUriLimit', { value: creationParameter(bytesLabel(rule.maxDataUriBytes, t, formatNumber)) })}</p>}
      <p>{t('generation.inputs.dimensions', { value: creationParameter([dimensions?.min && t('generation.inputs.minimumDimensions', { min: creationParameter(dimensions.min) }), dimensions?.max && t('generation.inputs.maximumDimensions', { max: creationParameter(dimensions.max) }), dimensions?.matchAspectRatio && t('generation.inputs.matchAspectRatio'), dimensions?.matchAspectRatio === false && t('generation.inputs.independentAspectRatio'), dimensions?.minAspectRatio && t('generation.inputs.minimumAspectRatio', { minAspectRatio: creationParameter(dimensions.minAspectRatio) }), dimensions?.maxAspectRatio && t('generation.inputs.maximumAspectRatio', { maxAspectRatio: creationParameter(dimensions.maxAspectRatio) })].filter(Boolean).join('；') || t('generation.inputs.dimensionsUndeclared')) })}</p>
    </>}
  </li>;
}

// Read-only rendering of the selected server profile. Subject-library bindings
// never enter this component or become generation references implicitly.
export function GenerationInputDetails({ selection }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const { profile, evaluation, region, evaluatedAsOf } = selection;
  const lifecycle = profile?.lifecycle;
  const source = sourceUrl(lifecycle?.source);
  return <div className="generation-input-details-body">
    <p>{t('generation.inputs.adapterScope')}</p>
    {profile && <p>{t('generation.inputs.totalReferences', { minReferences: creationParameter(profile.inputs.minReferences), maxReferences: creationParameter(profile.inputs.maxReferences), value: creationParameter(profile.inputs.roles.last_frame?.implemented ? t('generation.inputs.firstLastCombination') : t('generation.inputs.firstFrameOnly')), value2: creationParameter(profile.inputs.roles.subject_reference?.implemented && t('generation.inputs.fixedSubjectAlternative')) })}</p>}
    <ul className="generation-input-roles" aria-label={t('generation.inputs.roleLimitsAria')}>{roles(t).map(([role, label]) => <RoleLimits key={role} role={role} label={label} rule={profile?.inputs?.roles?.[role]} />)}</ul>
    <p className="generation-input-planning" data-testid="generation-subject-planning">{t('generation.inputs.planningNotGeneration')}</p>
    {profile && <dl className="generation-input-provenance">
      <div><dt>{t('generation.inputs.adapterProfile')}</dt><dd>{profile.profileId} · {profile.profileVersion}</dd></div>
      <div><dt>{t('generation.inputs.profileReview')}</dt><dd>{profile.reviewedOn || t('generation.inputs.reviewDateUnavailable')}</dd></div>
      <div><dt>{t('generation.inputs.serverEvaluation')}</dt><dd>{evaluatedAsOf || t('generation.inputs.notProvided')}</dd></div>
      <div><dt>{t('generation.inputs.apiRegion')}</dt><dd>{region} · {regionMeaning(profile, t)}</dd></div>
    </dl>}
    {lifecycle && <div className="generation-input-lifecycle-detail">
      <p>{t('generation.inputs.lifecycleDates', { checkedOn: creationParameter(lifecycle.checkedOn), earliestShutdownDate: creationParameter(lifecycle.earliestShutdownDate) })}</p>
      {source && <a href={source} target="_blank" rel="noreferrer">{t('generation.inputs.providerLifecycleLink')}</a>}
      {evaluation?.warnings?.filter(warning => warning.code !== 'MODEL_LIFECYCLE_WARNING').map(warning => <p key={warning.code}>{renderMessage(generationIssueDescriptor(warning))}</p>)}
    </div>}
  </div>;
}

export default function GenerationInputSummary({ provider, model }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const selection = generationProfileSelection(provider, model);
  const { profile, state, message, region, evaluation, evaluatedAsOf } = selection;
  const visible = useWorkspaceVisibility();
  const selectionKey = semanticKey([provider?.id, model, provider?.inputProfileVersion, selection]);
  const scope = useMemo(() => ({ selectionKey, visible }), [selectionKey, visible]);
  const current = useRef(scope);
  const [disclosure, setDisclosure] = useState({ scope: null, open: false });
  useLayoutEffect(() => {
    current.current = scope;
    return () => { current.current = null; };
  }, [scope]);
  const open = visible && disclosure.scope === scope && disclosure.open;
  const lifecycleIssue = evaluation?.issues?.[0];
  const lifecycleMessage = lifecycleIssue?.code === 'MODEL_LIFECYCLE_REVALIDATION_REQUIRED' ? t('generation.inputs.lifecycleBlocked', { evaluatedAsOf: creationParameter(evaluatedAsOf) }) : renderMessage(generationIssueDescriptor(lifecycleIssue));
  const firstFrame = profile?.inputs?.roles?.first_frame;
  const lastFrame = profile?.inputs?.roles?.last_frame;
  return <section className="generation-input-summary" aria-label={t('generation.inputs.limitsAria')} data-testid="generation-input-summary" data-profile-state={state}>
    <p className="generation-input-model" data-testid="generation-input-model">{model || t('generation.inputs.noModelSelected')}</p>
    <p className="generation-input-route" data-testid="generation-input-route">{t('generation.inputs.routeSummary', { value: creationParameter(profile?.apiFamily || t('generation.inputs.unconfirmed')), value2: creationParameter(region || t('generation.inputs.unconfirmed')) })}</p>
    <p className="generation-input-brief" data-testid="generation-input-brief">{profile ? t('generation.inputs.referenceBrief', { value: creationParameter(firstFrame ? countLabel(firstFrame, t) : t('generation.inputs.unconfirmedCount')), value2: creationParameter(lastFrame?.implemented ? countLabel(lastFrame, t) : t('generation.inputs.notImplemented')) }) : renderMessage(selection.displayMessage)}</p>
    {lifecycleIssue ? <p className="generation-input-warning" role="status" data-testid="generation-input-lifecycle-blocked">{t('generation.inputs.noAutomaticReplacement', { lifecycleMessage: creationParameter(lifecycleMessage) })}</p> : profile?.lifecycle && <p className="generation-input-warning" role="status" data-testid="generation-input-lifecycle-warning">{t('generation.inputs.lifecycleWarning', { earliestShutdownDate: creationParameter(profile.lifecycle.earliestShutdownDate), checkedOn: creationParameter(profile.lifecycle.checkedOn) })}</p>}
    <Collapsible open={open} onOpenChange={next => {
      if (visible && current.current === scope) setDisclosure({ scope, open: Boolean(next) });
    }}>
      <CollapsibleTrigger render={<Button variant="ghost" size="sm" />} className="generation-input-toggle" data-testid="generation-input-toggle" disabled={!visible}><span>{t('generation.inputs.viewLimits')}</span><Icon name="down" size={13} /></CollapsibleTrigger>
      <CollapsibleContent className="generation-input-details" data-testid="generation-input-details"><GenerationInputDetails selection={selection} /></CollapsibleContent>
    </Collapsible>
  </section>;
}

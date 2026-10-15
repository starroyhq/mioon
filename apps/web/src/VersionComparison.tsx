import React, { useLayoutEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose } from '@mioon/ui/components/dialog';
import { Button } from '@mioon/ui/components/button';
import { useI18n } from './i18n/I18nProvider.tsx';
import { captureComparison, comparisonAvailable, comparisonCurrent, comparisonOptions, comparisonPairCurrent } from './version-comparison-state.ts';
import type { ComparisonBinding, ComparisonContext } from './version-comparison-state.ts';

type Selection = { binding: ComparisonBinding; retired: boolean } | null;
type Props = { context: ComparisonContext; getContext: () => ComparisonContext; busy: boolean;
  onClose: () => void; onUse: (binding: ComparisonBinding) => void;
  onBeforePlay: () => void; onRegisterMediaPause: (pause: () => void) => () => void };
/** Explicit, transient A/B choices. No new generation, render or implicit selection. */
export default function VersionComparison(props: Props) {
  const { t, formatDate, formatNumber } = useI18n();
  const [choices, setChoices] = useState<[Selection, Selection]>([null, null]);
  const [errors, setErrors] = useState<[string | null, string | null]>([null, null]);
  const players = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null]);
  const live = useRef({ props, choices, closed: false });
  const available = comparisonAvailable(props.context);
  const bindings = choices.map(choice => choice?.binding || null);
  const valid = choices.map(choice => Boolean(choice && !choice.retired && comparisonCurrent(choice.binding, props.context)));
  const pairReady = valid.every(Boolean) && comparisonPairCurrent(bindings[0], bindings[1], props.context);
  const options = comparisonOptions(props.context);
  const choiceKey = (values: [Selection, Selection]) => JSON.stringify(values.map(value => value ? [value.binding.key, value.retired] : null));
  const renderedChoices = choiceKey(choices), renderedScope = props.context.scope;
  const pause = () => players.current.forEach(element => element?.pause());
  useLayoutEffect(() => { live.current = { props, choices, closed: false }; });
  useLayoutEffect(() => props.onRegisterMediaPause(pause), [props.onRegisterMediaPause]);
  // Once invalidated, a choice needs explicit reselection, even after reconnect.
  useLayoutEffect(() => {
    if (choices.some(choice => choice && !choice.retired && !comparisonCurrent(choice.binding, props.context))) {
      pause();
      setChoices(previous => previous.map(choice => choice && !comparisonCurrent(choice.binding, props.getContext()) ? { ...choice, retired: true } : choice) as [Selection, Selection]);
    }
  }, [props.context, choices]);
  useLayoutEffect(() => {
    const hide = () => { if (document.visibilityState === 'hidden') pause(); };
    document.addEventListener('visibilitychange', hide); window.addEventListener('pagehide', pause);
    return () => { live.current.closed = true; pause(); document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', pause); };
  }, []);
  function current(index: number, element?: HTMLVideoElement): ComparisonBinding | null {
    const state = live.current, choice = state.choices[index], context = state.props.getContext();
    if (state.closed || !choice || choice.retired || !comparisonCurrent(choice.binding, context) ||
      !comparisonPairCurrent(state.choices[0]?.binding || null, state.choices[1]?.binding || null, context) ||
      state.choices.some(value => value?.retired) || document.visibilityState === 'hidden') return null;
    if (element && (players.current[index] !== element || !element.isConnected || element.getAttribute('src') !== choice.binding.url)) return null;
    return choice.binding;
  }
  function choose(index: number, versionId: string) {
    const state = live.current;
    if (state.closed || state.props.getContext().scope !== renderedScope || choiceKey(state.choices) !== renderedChoices) return;
    const binding = captureComparison(state.props.getContext(), versionId);
    if (binding && binding.versionId === state.choices[1 - index]?.binding.versionId) return;
    pause();
    const next = [...state.choices] as [Selection, Selection]; next[index] = binding ? { binding, retired: false } : null;
    live.current.choices = next; setChoices(next);
    setErrors(previous => previous.map((value, at) => at === index ? null : value) as [string | null, string | null]);
  }
  function play(index: number, event: React.SyntheticEvent<HTMLVideoElement>) {
    if (event.currentTarget.paused) return;
    if (!current(index, event.currentTarget)) { event.currentTarget.pause(); return; }
    players.current[1 - index]?.pause(); live.current.props.onBeforePlay();
    // Parent ownership callbacks may synchronously change navigation/context.
    if (!current(index, event.currentTarget)) event.currentTarget.pause();
  }
  function applyChoice(index: number, expectedKey: string) {
    const binding = current(index);
    if (binding && binding.key === expectedKey && !live.current.props.busy) live.current.props.onUse(binding);
  }
  function close() { if (live.current.closed) return; live.current.closed = true; pause(); live.current.props.onClose(); }
  return <Dialog open onOpenChange={open => { if (!open) close(); }}><DialogContent className="modal wide version-comparison" showCloseButton={false}>
    <header className="modal-header"><div><DialogTitle>{t('projects.comparison.title')}</DialogTitle><DialogDescription>{t('comparison.help')}</DialogDescription></div>
      <DialogClose render={<Button variant="ghost" aria-label={t('shell.closeDialog')} onClick={close} />}>×</DialogClose></header>
    <p className="comparison-status" role="status" aria-live="polite">{t(!available ? 'comparison.unavailable' : choices.some(choice => choice?.retired) || choices.some((choice, index) => choice && !valid[index]) ? 'comparison.stale' : options.length < 2 ? 'comparison.insufficient' : pairReady ? 'comparison.ready' : 'comparison.chooseBoth')}</p>
    {choices.some(Boolean) && <Button variant="ghost" className="button comparison-reset" onClick={() => { if (live.current.closed || live.current.props.getContext().scope !== renderedScope || choiceKey(live.current.choices) !== renderedChoices) return; pause(); live.current.choices = [null, null]; setChoices([null, null]); setErrors([null, null]); }}>{t('comparison.reset')}</Button>}
    <div className="comparison-grid">{(['A', 'B'] as const).map((label, index) => {
      const binding = bindings[index], metadata = binding?.metadata;
      const selected = props.context.shot?.selectedVersionId === binding?.versionId;
      const url = pairReady ? binding?.url || null : null;
      return <section className="comparison-column" key={label} aria-label={t('projects.comparison.label', { label })}>
        <label className="comparison-title"><span>{label}</span><select aria-label={t('projects.comparison.label', { label })} data-testid={`comparison-select-${label}`} value={binding?.versionId || ''} disabled={!available} onChange={event => choose(index, event.target.value)}>
          <option value="">{t('comparison.choose')}</option>
          {binding && !options.some(option => option.versionId === binding.versionId) && <option value={binding.versionId}>{t('projects.version', { number: binding.number })}</option>}
          {options.map(option => <option key={option.versionId} value={option.versionId} disabled={option.versionId === bindings[1 - index]?.versionId}>{t('projects.version', { number: option.number })}</option>)}
        </select></label>
        <div className="comparison-media">{url && binding ? <ComparisonVideo key={binding.key} binding={binding} label={t('comparison.player', { label, number: binding.number })}
          register={element => { players.current[index] = element; }} onPlay={event => play(index, event)}
          onError={event => { if (current(index, event.currentTarget)) setErrors(previous => previous.map((value, at) => at === index ? binding.key : value) as [string | null, string | null]); }} /> : <p>{t('comparison.noPlayback')}</p>}</div>
        {binding && <><h3>{t('projects.version', { number: binding.number })}{selected ? ` · ${t('projects.comparison.current')}` : ''}</h3>
          <div className="comparison-specs"><span>{metadata?.aspectRatio || t('comparison.unknown')}</span><span>{metadata?.duration == null ? t('comparison.unknown') : t('shell.durationSeconds', { seconds: formatNumber(metadata.duration) })}</span><span>{metadata?.model || t('comparison.unknown')}</span></div>
          <p>{metadata?.provider || t('comparison.unknown')}{metadata?.isMock ? ` · ${t('inspector.mock')}` : ''} · {metadata?.createdAt ? formatDate(metadata.createdAt) : t('comparison.unknown')}</p>
          <p className="comparison-prompt">{metadata?.prompt || t('projects.comparison.noPrompt')}</p>
          <details className="comparison-identity"><summary>{t('comparison.identity')}</summary><p>{t('comparison.project', { id: binding.projectId })}</p><p>{t('comparison.shot', { id: binding.shotId })}</p><p>{t('comparison.version', { id: binding.versionId })}</p><p>{t('comparison.asset', { id: binding.assetId })}</p><p>{t('comparison.hash', { hash: binding.sha256 })}</p><p>{t('comparison.hashBoundary')}</p></details>
          {errors[index] === binding.key && <p role="status">{t('comparison.mediaError')}</p>}
          <Button variant="ghost" className="button full" data-testid={`comparison-use-${label}`} disabled={!pairReady || selected || props.busy} onClick={() => applyChoice(index, binding.key)}>{selected ? t('projects.comparison.current') : t('projects.comparison.select', { number: binding.number })}</Button>
        </>}
      </section>;
    })}</div><p className="modal-note">{t('projects.comparison.scope')}</p>
  </DialogContent></Dialog>;
}
/** Owns one exact decoder. Effect replay reattaches the same source safely. */
export function ComparisonVideo({ binding, label, register, onPlay, onError }: { binding: ComparisonBinding; label: string;
  register: (element: HTMLVideoElement | null) => void; onPlay: (event: React.SyntheticEvent<HTMLVideoElement>) => void; onError: (event: React.SyntheticEvent<HTMLVideoElement>) => void }) {
  const media = useRef<HTMLVideoElement | null>(null), callbacks = useRef({ register, onPlay, onError });
  useLayoutEffect(() => { callbacks.current = { register, onPlay, onError }; register(media.current); });
  useLayoutEffect(() => {
    const element = media.current;
    if (element && element.getAttribute('src') !== binding.url) element.setAttribute('src', binding.url);
    callbacks.current.register(element);
    return () => { callbacks.current.register(null); if (element) { element.pause(); element.removeAttribute('src'); element.load(); } };
  }, [binding.key]);
  return <video ref={media} src={binding.url} aria-label={label} controls muted playsInline preload="metadata" onPlay={event => callbacks.current.onPlay(event)} onPlaying={event => callbacks.current.onPlay(event)} onError={event => callbacks.current.onError(event)} />;
}

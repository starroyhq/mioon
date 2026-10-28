import React, { useEffect, useId, useRef, useState } from 'react';
import { isWaveformResponse } from '@mioon/contracts';
import { Button } from '@mioon/ui/components/button';
import { WorkbenchSelect } from './WorkspaceControls.tsx';
import { useI18n } from './i18n/I18nProvider.tsx';
import type { RawVolumeEnvelope } from './clip-volume-envelope-state.ts';
import { DEFAULT_DIALOGUE_DUCKING, DIALOGUE_DUCKING_CHOICES, dialogueDuckingCandidate, dialogueTrackChoices, dialogueWaveformRequests } from './dialogue-ducking-state.ts';
import type { DialogueDuckingCandidate, DialogueDuckingParameters, DialogueWaveformRead, DialogueWaveformRequest, DuckingClip, DuckingTrack } from './dialogue-ducking-state.ts';

type Field = keyof DialogueDuckingParameters;
const FIELDS: readonly Field[] = ['thresholdDb', 'paddingFrames', 'multiplier', 'attackFrames', 'releaseFrames'];
const label = { thresholdDb: 'ducking.auto.threshold', paddingFrames: 'ducking.auto.padding', multiplier: 'ducking.auto.multiplier',
  attackFrames: 'ducking.auto.attack', releaseFrames: 'ducking.auto.release' } as const satisfies Record<Field, string>;
type Result = { key: string } & ({ phase: 'ready' | 'empty'; candidate: DialogueDuckingCandidate } | { phase: 'missing'; assetIds: string[] } | { phase: 'error' });

export interface ClipDialogueDuckingControlsProps {
  /** The saved background clip; analysis is bound to its saved position. */
  clip: DuckingClip;
  clips: readonly DuckingClip[];
  tracks: readonly DuckingTrack[];
  timelineRevision: number;
  disabled: boolean;
  /** Why analysis cannot start, e.g. unsaved position edits. */
  blockedReason?: string;
  hasEnvelope: boolean;
  readWaveform: (request: DialogueWaveformRequest) => Promise<unknown>;
  requestWaveform: (assetId: string) => Promise<unknown>;
  onApply: (envelope: RawVolumeEnvelope) => void;
}

/** Dialogue-driven ducking: reads the dialogue clips' saved source peaks and
 * proposes a replacement curve. Applying only edits the draft; Save applies it. */
export default function ClipDialogueDuckingControls({ clip, clips, tracks, timelineRevision, disabled, blockedReason, hasEnvelope, readWaveform, requestWaveform, onApply }: ClipDialogueDuckingControlsProps) {
  const { t } = useI18n(), id = useId();
  const choices = dialogueTrackChoices(clip, clips, tracks);
  const [chosenTrack, setChosenTrack] = useState<string | null>(null);
  const trackId = chosenTrack && choices.tracks.some(track => track.id === chosenTrack) ? chosenTrack : choices.preferred;
  const [parameters, setParameters] = useState<DialogueDuckingParameters>({ ...DEFAULT_DIALOGUE_DUCKING });
  const [result, setResult] = useState<Result | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [requested, setRequested] = useState(false);
  const epoch = useRef(0), mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  // A candidate belongs to one saved timeline, clip position, dialogue track and setting.
  const key = JSON.stringify([timelineRevision, clip.id, clip.startFrame, clip.durationFrames, clip.sourceInFrame ?? 0, trackId, parameters]);
  const current = result?.key === key ? result : null;
  async function analyze(): Promise<void> {
    if (disabled || blockedReason || analyzing || !trackId) return;
    const run = ++epoch.current, requests = dialogueWaveformRequests(clip, clips, trackId), reads: DialogueWaveformRead[] = [], missing: string[] = [];
    setAnalyzing(true); setRequested(false);
    try {
      for (const request of requests) {
        const response = await readWaveform(request);
        if (!mounted.current || run !== epoch.current) return;
        if (!isWaveformResponse(response)) throw Error('Invalid waveform response');
        const value = response as { status: string; peaks?: (number | null)[]; sourceStartFrame?: number; sourceEndFrame?: number };
        if (value.status === 'ready' && value.peaks) reads.push({ clipId: request.clipId, sourceStartFrame: value.sourceStartFrame ?? request.sourceStartFrame, sourceEndFrame: value.sourceEndFrame ?? request.sourceEndFrame, peaks: value.peaks });
        else if (value.status !== 'unsupported' && !missing.includes(request.assetId)) missing.push(request.assetId);
      }
      if (missing.length) { setResult({ key, phase: 'missing', assetIds: missing }); return; }
      const candidate = dialogueDuckingCandidate(clip, clips, reads, parameters);
      setResult({ key, phase: candidate.envelope ? 'ready' : 'empty', candidate });
    } catch {
      if (mounted.current && run === epoch.current) setResult({ key, phase: 'error' });
    } finally {
      if (mounted.current && run === epoch.current) setAnalyzing(false);
    }
  }
  async function request(assetIds: readonly string[]): Promise<void> {
    if (disabled) return;
    setRequested(true);
    try { for (const assetId of assetIds) await requestWaveform(assetId); } catch { if (mounted.current) setResult({ key, phase: 'error' }); }
  }
  return <details className="clip-audio-help" data-testid="dialogue-ducking"><summary>{t('ducking.auto.title')}</summary>
    <fieldset disabled={disabled} aria-describedby={`${id}-hint`}>
      <legend>{t('ducking.auto.title')}</legend>
      <p id={`${id}-hint`} className="input-hint">{t('ducking.auto.hint')}</p>
      {!choices.tracks.length ? <p className="input-hint" role="status" data-testid="dialogue-ducking-no-track">{t('ducking.auto.noTrack')}</p> : <>
        <label htmlFor={`${id}-track`}>{t('ducking.auto.track')}</label>
        <WorkbenchSelect id={`${id}-track`} data-testid="dialogue-ducking-track" value={trackId ?? ''} onChange={event => setChosenTrack(event.target.value)}>
          {choices.tracks.map(track => <option key={track.id} value={track.id}>{track.name || track.id}</option>)}
        </WorkbenchSelect>
        {FIELDS.map(field => <span key={field} className="dialogue-ducking-field">
          <label htmlFor={`${id}-${field}`}>{t(label[field])}</label>
          <WorkbenchSelect id={`${id}-${field}`} data-testid={`dialogue-ducking-${field}`} value={String(parameters[field])}
            onChange={event => { const value = Number(event.target.value); if ((DIALOGUE_DUCKING_CHOICES[field] as readonly number[]).includes(value)) setParameters(previous => ({ ...previous, [field]: value })); }}>
            {DIALOGUE_DUCKING_CHOICES[field].map(value => <option key={value} value={value}>{field === 'thresholdDb' ? t('ducking.auto.db', { value }) : field === 'multiplier' ? String(value) : t('volume.envelope.preset.frames', { frames: value })}</option>)}
          </WorkbenchSelect>
        </span>)}
        <Button type="button" variant="outline" size="sm" data-testid="dialogue-ducking-analyze" disabled={disabled || analyzing || Boolean(blockedReason)} onClick={() => void analyze()}>{t('ducking.auto.analyze')}</Button>
      </>}
      {blockedReason && <p className="input-hint" role="status" data-testid="dialogue-ducking-blocked">{blockedReason}</p>}
      {analyzing && <p className="input-hint" role="status">{t('ducking.auto.analyzing')}</p>}
      {!analyzing && current?.phase === 'missing' && <p className="input-hint" role="status" data-testid="dialogue-ducking-missing">
        {t(requested ? 'ducking.auto.requested' : 'ducking.auto.missing', { count: current.assetIds.length })}
        {!requested && <Button type="button" variant="ghost" size="sm" data-testid="dialogue-ducking-request" onClick={() => void request(current.assetIds)}>{t('ducking.auto.request')}</Button>}
      </p>}
      {!analyzing && current?.phase === 'empty' && <p className="input-hint" role="status" data-testid="dialogue-ducking-empty">{t('ducking.auto.empty')}</p>}
      {!analyzing && current?.phase === 'error' && <p role="alert">{t('ducking.auto.error')}</p>}
      {!analyzing && current?.phase === 'ready' && <div data-testid="dialogue-ducking-candidate">
        <p className="input-hint" role="status">{t('ducking.auto.found', { speech: current.candidate.speechCount, regions: current.candidate.regions.length })}</p>
        {current.candidate.bridged > 0 && <p className="input-hint">{t('ducking.auto.bridged', { count: current.candidate.bridged })}</p>}
        {current.candidate.missingFrames > 0 && <p className="input-hint">{t('ducking.auto.gaps', { frames: current.candidate.missingFrames })}</p>}
        {hasEnvelope && <p className="input-hint">{t('ducking.auto.replaces')}</p>}
        <Button type="button" variant="outline" size="sm" data-testid="dialogue-ducking-apply" disabled={disabled} onClick={() => { if (!disabled && current.candidate.envelope) onApply(current.candidate.envelope); }}>{t('ducking.auto.apply')}</Button>
      </div>}
    </fieldset>
  </details>;
}

import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Button} from '@mioon/ui/components/button';
import {Label} from '@mioon/ui/components/label';
import {Textarea} from '@mioon/ui/components/textarea';
import {useI18n} from './i18n/I18nProvider.tsx';
import {
  dialogueEdits, dialoguePanelDirty, formatDialogueText, newDialogueLineId, parseDialogueText,
} from './dialogue-panel-state.ts';
import type {DialogueLineView} from './dialogue-panel-state.ts';
import './shot-dialogue.css';

/** DL-a shot properties dialogue panel (design 21-06).
 *
 * One visual line per dialogue line; a line with a speaker is written as
 * `名字：台词`. Saving sends one `sequence.edit` dialogue action: the shot's
 * lines and, while the shot is on the main track, their real subtitle cues are
 * written in the same transaction and one undo step. */
export interface ShotDialogueProps {
  readonly shot?: {readonly id: string; readonly dialogue?: readonly DialogueLineView[]} | null;
  readonly subjectNames?: Readonly<Record<string, string>>;
  readonly projectId: string | null;
  /** Real subtitle cues currently linked to this shot (shown as panel status). */
  readonly cueCount?: number;
  readonly disabled?: boolean;
  readonly rpc: (operation: string, input: unknown) => Promise<unknown>;
  readonly onApplied?: () => unknown;
}

const ERROR_KEYS: Readonly<Record<string, string>> = {
  SEQUENCE_EDIT_DIALOGUE_INVALID: 'dialogue.ui.error.invalid',
  SEQUENCE_EDIT_DIALOGUE_CONFLICT: 'dialogue.ui.error.conflict',
  SEQUENCE_EDIT_REVISION_CONFLICT: 'dialogue.ui.error.stale',
  SEQUENCE_EDIT_HISTORY_CONFLICT: 'dialogue.ui.error.stale',
  SEQUENCE_EDIT_NOOP: 'dialogue.ui.error.noop',
  SEQUENCE_EDIT_CONTRACT_INVALID: 'dialogue.ui.error.unsupported',
};

interface PreviewResponse {
  readonly ok?: false;
  readonly code?: string;
  readonly envelope?: unknown;
  readonly planDigest?: string;
}
interface CommitResponse {
  readonly ok?: false;
  readonly code?: string;
  readonly status?: string;
}

export default function ShotDialogue({shot = null, subjectNames = {}, projectId, cueCount = 0,
  disabled = false, rpc, onApplied}: ShotDialogueProps): React.ReactElement | null {
  const {t} = useI18n();
  const lines = shot?.dialogue ?? [];
  const serialized = JSON.stringify(lines);
  const names = JSON.stringify(subjectNames);
  const initial = useMemo(() => formatDialogueText(lines, subjectNames),
    // The panel follows the stored value; object identity changes on every refresh.
    [shot?.id, serialized, names]);
  const [draft, setDraft] = useState(() => initial);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => {mounted.current = false;}; }, []);
  const initialRef = useRef(initial);
  useEffect(() => {
    initialRef.current = initial;
    setDraft(initial);
    setErrorKey(null);
  }, [initial]);
  const draftLines = useMemo(() => parseDialogueText(draft, subjectNames), [draft, names]);
  const dirty = dialoguePanelDirty(lines, draftLines);
  const blocked = disabled || !shot || !projectId;
  const error = errorKey ? t(errorKey as never) : null;

  async function save(): Promise<void> {
    if (!shot || !projectId || busy || !dirty) return;
    const edits = dialogueEdits(shot.id, lines, draftLines);
    if (edits.length === 0) return;
    setBusy(true);
    setErrorKey(null);
    try {
      const preview = await rpc('sequence.preview', {projectId,
        requestId: `shot-dialogue-${newDialogueLineId()}`,
        dialogueIntent: {side: 'board', operation: {kind: 'dialogue', edits}}}) as PreviewResponse;
      if (preview?.ok === false || preview?.envelope === undefined) {
        setErrorKey(ERROR_KEYS[String(preview?.code)] ?? 'dialogue.ui.error.generic');
        return;
      }
      const committed = await rpc('sequence.commit', {projectId, envelope: preview.envelope,
        expectedPlanDigest: preview.planDigest}) as CommitResponse;
      if (committed?.ok === false) {
        setErrorKey(ERROR_KEYS[String(committed.code)] ?? 'dialogue.ui.error.generic');
        return;
      }
      if (!mounted.current) return;
      onApplied?.();
    } catch (exception) {
      if (mounted.current) setErrorKey(ERROR_KEYS[String((exception as {code?: string}).code)] ?? 'dialogue.ui.error.generic');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  if (!shot) return null;
  return <section className="shot-dialogue" data-testid="shot-dialogue" aria-busy={busy}>
    <Label className="field-label" htmlFor="shot-dialogue-text">{t('dialogue.ui.title')}</Label>
    <Textarea id="shot-dialogue-text" data-testid="shot-dialogue-text" className="shot-dialogue-text"
      rows={Math.min(8, Math.max(3, draftLines.length + 1))} spellCheck={false}
      value={draft} disabled={blocked || busy} aria-label={t('dialogue.ui.title')}
      onChange={event => setDraft(event.target.value)} />
    {error && <p className="notice warning" role="alert" data-testid="shot-dialogue-error">{error}</p>}
    {dirty && <div className="shot-dialogue-actions">
      <Button type="button" size="sm" data-testid="shot-dialogue-save" disabled={blocked || busy} onClick={() => { void save(); }}>
        {busy ? t('dialogue.ui.saving') : t('dialogue.ui.save')}
      </Button>
      <Button type="button" variant="ghost" size="sm" data-testid="shot-dialogue-discard" disabled={busy}
        onClick={() => { setDraft(initialRef.current); setErrorKey(null); }}>{t('timeline.inspector.discard')}</Button>
    </div>}
    {cueCount > 0 && <p className="input-hint shot-dialogue-cues" data-testid="shot-dialogue-cues">
      {t('dialogue.ui.cues', {count: cueCount})}
    </p>}
  </section>;
}

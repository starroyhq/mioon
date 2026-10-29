import React, { useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Dialog } from '@mioon/ui/components/dialog';
import { Textarea } from '@mioon/ui/components/textarea';
import { WorkbenchAlert, WorkbenchButton as Button, WorkbenchDialogContent } from '@mioon/ui/components/workbench-controls';
import { PROJECT_NOTES_MAX_BYTES } from '../../../packages/contracts/src/project-lifecycle.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import Icon from './icons.tsx';
import { projectNotesBytes, projectNotesOf, projectNotesProblem, saveProjectNotes } from './project-notes.ts';
import type { ProjectNotesBase, ProjectNotesCall, ProjectNotesSetInput } from './project-notes.ts';
import './project-notes.css';

export interface ProjectNotesDialogProps {
  open: boolean;
  project: { id: string; revision: number; notes?: unknown } | null;
  /** A restored copy shows its notes without saving. */
  readOnly: boolean;
  call: ProjectNotesCall;
  /** `saved` after a confirmed save; `unknown` when a save may have landed without a confirmed answer. */
  onClose: (outcome: 'saved' | 'unknown' | 'none') => unknown;
}
type Phase = 'editing' | 'saving' | 'unknown' | 'conflict' | 'rejected';

/**
 * Project notes (C6, 09-09): one plain-text document per project that Mio reads every round. Saving is guarded by
 * the project revision; an unconfirmed save is retried with its original request so it never saves twice.
 */
export default function ProjectNotesDialog({ open, project, readOnly, call, onClose }: ProjectNotesDialogProps): ReactElement {
  const { t } = useI18n();
  const [base, setBase] = useState<ProjectNotesBase | null>(null), [draft, setDraft] = useState(''), [phase, setPhase] = useState<Phase>('editing');
  const [retained, setRetained] = useState<ProjectNotesSetInput | null>(null), [latest, setLatest] = useState<string | null>(null);
  const text = useRef<HTMLTextAreaElement | null>(null), owner = useRef(0), uncertain = useRef(false);
  // Each opening starts from the saved notes; later project refreshes never replace the text being edited.
  useLayoutEffect(() => {
    owner.current++;
    if (!open || !project) return;
    const notes = projectNotesOf(project);
    setBase({ projectId: project.id, revision: project.revision, notes }); setDraft(notes); setPhase('editing'); setRetained(null); setLatest(null); uncertain.current = false;
  }, [open, project?.id]);
  const bytes = projectNotesBytes(draft), problem = projectNotesProblem(draft), dirty = Boolean(base) && draft !== base!.notes;
  const canSave = !readOnly && Boolean(base) && phase !== 'saving' && (phase === 'unknown' ? retained !== null : problem === null && dirty);
  async function save(): Promise<void> {
    if (!canSave || !base) return;
    const mine = ++owner.current;
    setPhase('saving');
    const outcome = await saveProjectNotes(call, { base, notes: retained?.notes ?? draft, retained });
    if (mine !== owner.current) return;
    if (outcome.kind === 'saved') { setRetained(null); onClose('saved'); return; }
    if (outcome.kind === 'unknown') { uncertain.current = true; setRetained(outcome.input); setPhase('unknown'); return; }
    setRetained(null);
    if (outcome.kind === 'conflict') { setBase(outcome.latest); setLatest(outcome.latest.notes); setPhase('conflict'); return; }
    setPhase('rejected');
  }
  const close = () => { if (phase === 'saving') return; owner.current++; onClose(uncertain.current ? 'unknown' : 'none'); };
  const locked = readOnly || phase === 'saving' || phase === 'unknown';
  return <Dialog open={open} onOpenChange={next => { if (!next) close(); }}>
    <WorkbenchDialogContent title={t('projectNotes.title')} description={t('projectNotes.description')} className="project-notes-dialog" data-testid="project-notes-dialog" initialFocus={text}
      footer={<><p className="project-notes-exported"><Icon name="box" size={14} />{t('projectNotes.exported')}</p>
        <Button data-testid="project-notes-discard" disabled={phase === 'saving'} onClick={close}>{t(readOnly ? 'common.close' : 'projectNotes.discard')}</Button>
        {!readOnly && <Button variant="primary" data-testid="project-notes-save" loading={phase === 'saving'} disabled={!canSave} onClick={() => { void save(); }}>{t(phase === 'unknown' ? 'projectNotes.retry' : 'projectNotes.save')}</Button>}</>}>
      {readOnly && <p className="project-notes-read-only" data-testid="project-notes-read-only">{t('projectNotes.readOnly')}</p>}
      <Textarea ref={text} className="project-notes-text" data-testid="project-notes-text" aria-label={t('projectNotes.title')} aria-describedby="project-notes-count" placeholder={readOnly ? undefined : t('projectNotes.placeholder')}
        value={draft} maxLength={PROJECT_NOTES_MAX_BYTES * 4} readOnly={locked} aria-invalid={problem !== null || undefined} spellCheck={false}
        onChange={event => { if (!locked) { setDraft(event.target.value); if (phase === 'rejected') setPhase('editing'); } }} />
      <p id="project-notes-count" className="project-notes-count" data-over={problem === 'tooLong' || undefined}>{t('projectNotes.bytes', { count: bytes, limit: PROJECT_NOTES_MAX_BYTES })}</p>
      {problem && <p className="project-notes-problem" role="alert">{t(problem === 'tooLong' ? 'projectNotes.tooLong' : 'projectNotes.invalid', { limit: PROJECT_NOTES_MAX_BYTES })}</p>}
      {phase === 'unknown' && <WorkbenchAlert tone="warning" data-testid="project-notes-unknown">{t('projectNotes.unknown')}</WorkbenchAlert>}
      {phase === 'conflict' && <WorkbenchAlert tone="warning" data-testid="project-notes-conflict" actions={<Button size="compact" data-testid="project-notes-load-latest" onClick={() => { if (latest !== null) { setDraft(latest); setLatest(null); setPhase('editing'); } }}>{t('projectNotes.loadLatest')}</Button>}>{t('projectNotes.conflict')}</WorkbenchAlert>}
      {phase === 'rejected' && <WorkbenchAlert tone="danger" data-testid="project-notes-rejected">{t('projectNotes.rejected')}</WorkbenchAlert>}
    </WorkbenchDialogContent>
  </Dialog>;
}

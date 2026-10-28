import React, { useState } from 'react';
import { WorkbenchButton as Button } from '@mioon/ui/components/workbench-controls';
import { WorkbenchTooltip } from '@mioon/ui/components/workbench-tooltip';
import { Input } from '@mioon/ui/components/input';
import { AGENT_TASK_QUESTION_LIMITS } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import type { AgentTaskQuestion, AgentTaskStep } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import Icon from './icons.tsx';
import { agentTaskAnswerTextValid, taskAnswerOf } from './agent-task-questions.ts';

const kindKey = (question: AgentTaskQuestion) => question.multiple ? question.allowOther ? 'agent.panel.question.multipleOther' : 'agent.panel.question.multiple' : question.allowOther ? 'agent.panel.question.singleOther' : 'agent.panel.question.single';

/** The question card (09-05a). It is answerable only while its run waits for it;
 * a stopped run keeps it in place, unanswered and read-only (09-05b). */
export function AgentTaskQuestionCard({ step, question, state, disabled, onAnswer }: { step: AgentTaskStep; question: AgentTaskQuestion; state: 'waiting' | 'stopped'; disabled: boolean; onAnswer: (choices: number[], text?: string) => unknown }) {
  const { t } = useI18n();
  const [chosen, setChosen] = useState<number[]>([]), [other, setOther] = useState(false), [otherText, setOtherText] = useState('');
  const multiple = question.multiple === true, locked = state === 'stopped' || disabled;
  // A stopped question was never answered, so it shows no unsent selection.
  const picked = (index: number) => state === 'waiting' && chosen.includes(index);
  function toggle(index: number) {
    if (locked) return;
    if (multiple) setChosen(value => value.includes(index) ? value.filter(item => item !== index) : [...value, index].sort((a, b) => a - b));
    else { setChosen([index]); setOther(false); }
  }
  function chooseOther(next: boolean) {
    if (locked) return;
    setOther(next);
    if (next && !multiple) setChosen([]);
  }
  const typed = other ? otherText.trim() : '';
  const ready = !locked && (chosen.length > 0 || other) && (!other || agentTaskAnswerTextValid(typed));
  const count = chosen.length + (other ? 1 : 0);
  const hint = count === 0 ? t(multiple ? 'agent.panel.question.pickSome' : 'agent.panel.question.pickOne') : multiple ? t('agent.panel.question.selected', { count }) : t('agent.panel.question.continue');
  // Options are shared buttons carrying the radio or checkbox role (no native inputs).
  const role = multiple ? 'checkbox' : 'radio';
  return <section className="mio-card mio-question" data-state={state} data-testid={`agent-task-question-${step.id}`}>
    <header className="mio-question-head"><Icon name="question" /><div><strong>{question.question}</strong>{state === 'stopped' ? <span className="mio-question-stopped" data-testid="agent-task-question-stopped">{t('agent.panel.question.stoppedTag')}</span> : <span className="mio-question-kind">{t(kindKey(question))}</span>}</div></header>
    <div className="mio-question-options" data-kind={role} role={multiple ? 'group' : 'radiogroup'} aria-label={question.question}>
      {question.options.map((option, index) => <Button key={index} variant="ghost" role={role} aria-checked={picked(index)} className="mio-question-option" data-selected={picked(index) || undefined} data-testid={`agent-task-question-option-${index}`} disabled={locked} onClick={() => toggle(index)}>
        <span className="mio-question-mark" aria-hidden="true" />
        <span className="mio-question-copy"><span>{option.label}</span>{option.description && <span className="mio-secondary">{option.description}</span>}</span>
      </Button>)}
      {question.allowOther && state === 'waiting' && <div className="mio-question-option mio-question-other" data-selected={other || undefined} data-testid="agent-task-question-other">
        <Button variant="ghost" role={role} aria-checked={other} aria-label={t('agent.panel.question.other')} className="mio-question-other-mark" data-testid="agent-task-question-other-mark" disabled={locked} onClick={() => chooseOther(multiple ? !other : true)}><span className="mio-question-mark" aria-hidden="true" /></Button>
        <Input className="mio-question-other-input" data-testid="agent-task-question-other-text" aria-label={t('agent.panel.question.otherInput')} placeholder={t('agent.panel.question.other')} maxLength={AGENT_TASK_QUESTION_LIMITS.answer} value={otherText} disabled={locked}
          onChange={event => { setOtherText(event.target.value); if (event.target.value.trim()) chooseOther(true); }} />
      </div>}
    </div>
    {state === 'stopped' ? <p className="mio-secondary" data-testid="agent-task-question-stopped-body">{t('agent.panel.question.stoppedBody')}</p>
      : <footer className="mio-question-foot"><span className="mio-secondary" data-testid="agent-task-question-hint">{hint}</span><Button variant="primary" size="compact" data-testid="agent-task-question-answer" disabled={!ready} onClick={() => { if (ready) void onAnswer(chosen, other ? typed : undefined); }}>{t('agent.panel.question.answer')}</Button></footer>}
  </section>;
}

/** An answered question collapses to one line (09-05b). Answers are final:
 * the round continued, so “change” stays disabled and explains why. */
export function AgentTaskAnswerRow({ step, question }: { step: AgentTaskStep; question: AgentTaskQuestion }) {
  const { t } = useI18n();
  const answer = taskAnswerOf(step, question);
  if (!answer) return null;
  const value = [...answer.labels, ...(answer.text ? [answer.text] : [])].join(t('agent.panel.question.separator'));
  return <div className="mio-answer" data-testid={`agent-task-answer-${step.id}`}>
    <Icon name="question" /><span className="mio-answer-text" title={value}><span className="mio-secondary">{t(answer.labels.length ? 'agent.panel.question.chose' : 'agent.panel.question.replied')}</span>{value}</span>
    <WorkbenchTooltip content={t('agent.panel.question.editLocked')}><Button variant="ghost" size="compact" className="mio-answer-edit" aria-disabled="true" data-testid={`agent-task-answer-edit-${step.id}`} onClick={event => event.preventDefault()}>{t('agent.panel.question.edit')}</Button></WorkbenchTooltip>
  </div>;
}

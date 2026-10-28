import { agentTaskAnswerTextSchema, agentTaskQuestionSchema } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import type { AgentTaskQuestion, AgentTaskStep } from '../../../packages/contracts/src/agent-tasks-v2.ts';

/** The saved question of a `mioon_ask` step, or null when it is not one. */
export function taskQuestionOf(step: AgentTaskStep): AgentTaskQuestion | null {
  if (step.kind !== 'tool' || step.toolCall?.name !== 'mioon_ask') return null;
  const parsed = agentTaskQuestionSchema.safeParse(step.toolCall.arguments);
  return parsed.success ? parsed.data : null;
}
/** What the user answered: the chosen labels and any typed text, read from
 * the saved answer and the question's own options, never from model text. */
export function taskAnswerOf(step: AgentTaskStep, question: AgentTaskQuestion): { labels: string[]; text?: string } | null {
  const result = step.status === 'completed' && step.result && typeof step.result === 'object' && !Array.isArray(step.result) ? step.result as Record<string, unknown> : null;
  const answer = result?.answer && typeof result.answer === 'object' && !Array.isArray(result.answer) ? result.answer as Record<string, unknown> : null;
  if (!answer || !Array.isArray(answer.choices)) return null;
  const labels = answer.choices.flatMap(index => typeof index === 'number' && question.options[index] ? [question.options[index]!.label] : []);
  const text = typeof answer.text === 'string' && answer.text.trim() ? answer.text.trim() : undefined;
  return labels.length || text ? { labels, ...(text ? { text } : {}) } : null;
}
/** Text typed as an answer: 1–2000 characters, newlines allowed. */
export const agentTaskAnswerTextValid = (text: string): boolean => agentTaskAnswerTextSchema.safeParse(text).success;

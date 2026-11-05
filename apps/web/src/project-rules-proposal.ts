import type {AgentTaskStep} from '../../../packages/contracts/src/agent-tasks-v2.ts';
import {rulesTextProblem} from '../../../packages/contracts/src/mio-rules.ts';

export interface HostRulesProposal {readonly file: 'AGENTS.md'; readonly expectedHash: string | null; readonly beforeText: string | null; readonly proposedText: string; readonly afterHash: string; readonly diff: {readonly before: string | null; readonly after: string}}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
/** A model's tool arguments are not the host's approved proposal. Only the
 * saved public result carries the before bytes and fixed publication target. */
export function rulesProposalOf(step: AgentTaskStep): HostRulesProposal | null {
  if (step.kind !== 'tool' || step.toolCall?.name !== 'mioon_project_rules_set' || !object(step.result)) return null;
  const value = step.result.rulesProposal;
  if (!object(value) || Object.keys(value).length !== 6 || value.file !== 'AGENTS.md' || !(value.expectedHash === null || hash(value.expectedHash)) || !hash(value.afterHash)
    || !(value.beforeText === null || typeof value.beforeText === 'string' && rulesTextProblem(value.beforeText) === null)
    || typeof value.proposedText !== 'string' || rulesTextProblem(value.proposedText) !== null || (value.beforeText === null) !== (value.expectedHash === null)
    || !object(value.diff) || Object.keys(value.diff).length !== 2 || value.diff.before !== value.beforeText || value.diff.after !== value.proposedText) return null;
  return {file: 'AGENTS.md', expectedHash: value.expectedHash, beforeText: value.beforeText, proposedText: value.proposedText, afterHash: value.afterHash, diff: {before: value.beforeText, after: value.proposedText}};
}
/** Bounded prefix/suffix diff. Complete before/after remain visible alongside
 * it, including unchanged content and line-ending differences. */
export function projectRulesProposalChange(proposal: HostRulesProposal) {
  const lines = (text: string | null): string[] => text === null || text === '' ? [] : text.split('\n');
  const before = lines(proposal.beforeText), after = lines(proposal.proposedText);
  let first = 0, lastBefore = before.length, lastAfter = after.length;
  while (first < lastBefore && first < lastAfter && before[first] === after[first]) first++;
  while (lastBefore > first && lastAfter > first && before[lastBefore - 1] === after[lastAfter - 1]) {lastBefore--; lastAfter--;}
  return {section: null, lines: [...before.slice(first, lastBefore).map(text => ({kind: 'remove' as const, text})), ...after.slice(first, lastAfter).map(text => ({kind: 'add' as const, text}))]};
}
export function rulesStepApplied(step: AgentTaskStep): boolean {
  return step.status === 'completed' && object(step.result) && step.result.file === 'AGENTS.md' && hash(step.result.hash) && step.result.requestId === step.id && step.result.state === 'completed';
}

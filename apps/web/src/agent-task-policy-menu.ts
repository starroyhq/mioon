import { AGENT_TASK_POLICY_PRESETS, AGENT_TASK_TIERS, agentTaskPolicyPreset } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import type { AgentTaskPolicyModes, AgentTaskPolicyPreset } from '../../../packages/contracts/src/agent-tasks-v2.ts';

export type AgentTaskPolicyMenuStep =
  | { kind: 'none' }
  | { kind: 'confirm'; scope: 'conversation' | 'global' }
  | { kind: 'choose'; modes: AgentTaskPolicyModes }
  | { kind: 'global'; modes: AgentTaskPolicyModes };

export const sameAgentTaskPolicyModes = (a: Readonly<AgentTaskPolicyModes>, b: Readonly<AgentTaskPolicyModes>): boolean => AGENT_TASK_TIERS.every(tier => a[tier] === b[tier]);

/** What a menu choice does. Paid work never becomes direct without the
 * explicit confirmation; choosing the current preset changes nothing. */
export function agentTaskPolicyMenuStep(modes: Readonly<AgentTaskPolicyModes> | null, global: Readonly<AgentTaskPolicyModes> | null, choice: AgentTaskPolicyPreset | 'global'): AgentTaskPolicyMenuStep {
  if (!modes) return { kind: 'none' };
  if (choice === 'global') {
    if (!global || sameAgentTaskPolicyModes(modes, global)) return { kind: 'none' };
    return modes.paid === 'direct' && global.paid !== 'direct' ? { kind: 'confirm', scope: 'global' } : { kind: 'global', modes: { ...modes } };
  }
  if (agentTaskPolicyPreset(modes) === choice) return { kind: 'none' };
  const target = AGENT_TASK_POLICY_PRESETS[choice];
  return target.paid === 'direct' && modes.paid !== 'direct' ? { kind: 'confirm', scope: 'conversation' } : { kind: 'choose', modes: { ...target } };
}

import type { AgentTaskChange, AgentTaskTarget } from '../../../packages/contracts/src/agent-tasks-v2.ts';

function targetElements(target: AgentTaskTarget, document: Document): Element[] {
  const escaped = typeof CSS !== 'undefined' ? CSS.escape(target.id) : target.id.replace(/[^A-Za-z0-9_-]/gu, '');
  const selectors: Record<string, string[]> = { shot: [`[data-testid="shot-node-${escaped}"]`], node: [`[data-testid="asset-node-${escaped}"]`, `[data-testid="text-node-${escaped}"]`], timeline_clip: [`[data-testid="timeline-clip-${escaped}"]`], timeline_track: [`[data-testid="timeline-track-${escaped}"]`], timeline_subtitle: [`[data-cue-id="${escaped}"]`, `[data-testid="subtitle-cue-${escaped}"]`] };
  return (selectors[target.kind] ?? []).flatMap(selector => [...document.querySelectorAll(selector)]);
}
/** A location hint changes neither selection nor inspector ownership. */
export function highlightAgentTaskChanges(changes: readonly AgentTaskChange[], document: Document = globalThis.document): void {
  for (const change of changes) for (const target of change.targets) for (const element of targetElements(target, document)) {
    element.classList.remove('agent-ai-highlight'); void element.getBoundingClientRect(); element.classList.add('agent-ai-highlight');
    setTimeout(() => element.classList.remove('agent-ai-highlight'), 3000);
  }
}
export function locateAgentTaskChange(change: AgentTaskChange, document: Document = globalThis.document): void {
  const elements = change.targets.flatMap(target => targetElements(target, document));
  elements[0]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  highlightAgentTaskChanges([change], document);
}

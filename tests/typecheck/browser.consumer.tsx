import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { deriveAgentEndpoint, type AgentProtocol } from '../../packages/contracts/src/agent-protocol.ts';
import TopbarSaveStatus, { type TopbarSaveStatusProps } from '../../apps/web/src/TopbarSaveStatus.tsx';

type ProtocolBadgeProps = Readonly<{ protocol: AgentProtocol }>;
export function ProtocolBadge({ protocol }: ProtocolBadgeProps): ReactElement {
  return <span data-protocol={protocol}>{deriveAgentEndpoint({protocol, baseUrl:'https://api.example.test/v1'})}</span>;
}
export function renderProtocolProof(): string {
  return renderToStaticMarkup(<ProtocolBadge protocol="responses" />);
}
// Compile-only negative consumers. The function is never called at runtime.
function rejectInvalidProps(): void {
  // @ts-expect-error Only the two explicit transport protocols are accepted.
  const unknown = <ProtocolBadge protocol="automatic" />;
  // @ts-expect-error A required protocol cannot be omitted.
  const absent = <ProtocolBadge />;
  // @ts-expect-error JSX checks actual React DOM attribute types.
  const wrongDomAttribute = <span tabIndex="not-a-number" />;
  void unknown; void absent; void wrongDomAttribute;
}
void rejectInvalidProps;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type Assert<T extends true> = T;
type ElementMustNotBeAny = Assert<IsAny<ReturnType<typeof ProtocolBadge>> extends false ? true : false>;
type OutputMustBeString = Assert<ReturnType<typeof renderProtocolProof> extends string ? true : false>;
export type { ElementMustNotBeAny, OutputMustBeString };

function checkTopbarSaveStatusProps(props: TopbarSaveStatusProps): void {
  const valid = <TopbarSaveStatus {...props} preferenceStatus={{ phase: 'future-phase', pending: false }} />;
  // @ts-expect-error Display flags must be booleans.
  const invalidFlag = <TopbarSaveStatus {...props} syncing="busy" />;
  // @ts-expect-error Locale formatting requires the actual Date contract.
  const invalidDate = <TopbarSaveStatus {...props} lastSync="2026-10-13" />;
  // @ts-expect-error Pending is a required display projection.
  const missingPending = <TopbarSaveStatus {...props} preferenceStatus={{ phase: 'saved' }} />;
  // @ts-expect-error Recovery callbacks cannot require a project argument.
  const invalidCallback = <TopbarSaveStatus {...props} onRetry={(projectId: string) => { void projectId; }} />;
  // @ts-expect-error The App-owned projection is readonly.
  props.dirty = true;
  // @ts-expect-error The nested preference projection is readonly too.
  props.preferenceStatus.phase = 'error';
  void valid; void invalidFlag; void invalidDate; void missingPending; void invalidCallback;
}
void checkTopbarSaveStatusProps;
type TopbarPropsMustNotBeAny = Assert<IsAny<TopbarSaveStatusProps> extends false ? true : false>;
type TopbarPreferenceMustNotBeAny = Assert<IsAny<TopbarSaveStatusProps['preferenceStatus']> extends false ? true : false>;
type TopbarElementMustNotBeAny = Assert<IsAny<ReturnType<typeof TopbarSaveStatus>> extends false ? true : false>;
export type { TopbarPropsMustNotBeAny, TopbarPreferenceMustNotBeAny, TopbarElementMustNotBeAny };

import ProjectHome, { type ProjectHomeProps } from '../../apps/web/src/ProjectHome.tsx';
import ProjectHomeConnections, { type HomeConnectionSlot } from '../../apps/web/src/ProjectHomeConnections.tsx';
import { projectOpenAttempt, canPublishProjectOpen, type ProjectOpenObservation } from '../../apps/web/src/project-open-state.ts';
function checkProjectHomeContracts(props: ProjectHomeProps, observed: ProjectOpenObservation): void {
  const valid = <ProjectHome {...props} phase="opening" />;
  // @ts-expect-error Creating a project must return its accepted boolean result.
  const uncheckedCreation = <ProjectHome {...props} onCreate={() => {}} />;
  // @ts-expect-error A global setting page is not an arbitrary business action.
  const unsafePage = <ProjectHome {...props} page="generate" />;
  // @ts-expect-error Opening state is explicitly discriminated.
  const inventedPhase = <ProjectHome {...props} phase="paid" />;
  const attempt = projectOpenAttempt('77000000-0000-4000-8000-000000000001', 1, 'normal');
  const ready: boolean = canPublishProjectOpen(attempt, observed);
  // @ts-expect-error A verified project identity is not an untyped object.
  canPublishProjectOpen(attempt, { ...observed, dataProjectId: {} });
  // @ts-expect-error There is no arbitrary third-party connector slot.
  const unknownSlot: HomeConnectionSlot = 'external';
  const settings = <ProjectHomeConnections selected="agent" onSelect={() => {}} panes={{ agent: null, official: null, custom: null, comfy: null }} />;
  void valid; void uncheckedCreation; void unsafePage; void inventedPhase; void ready; void unknownSlot; void settings;
}
void checkProjectHomeContracts;

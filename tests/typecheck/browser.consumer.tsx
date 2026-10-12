import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { deriveAgentEndpoint, type AgentProtocol } from '../../packages/contracts/src/agent-protocol.ts';

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

// This is a type-only acceptance fixture; the noEmit compiler never runs it.
// Import real source and the existing compatibility route, without declarations
// that could conceal a broken implementation or an untyped JavaScript boundary.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {Buffer} from 'node:buffer';
import {AGENT_PROTOCOLS, deriveAgentEndpoint} from '../../packages/contracts/src/agent-protocol.ts';
import {AGENT_PROTOCOLS as legacyProtocols, deriveAgentEndpoint as legacyEndpoint} from '../../packages/contracts/src/agent-protocol.mjs';
import type {AgentEndpointConfiguration, AgentProtocol} from '../../packages/contracts/src/agent-protocol.ts';

type IsAny<T> = 0 extends (1 & T) ? true : false;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false
  : false;
type Expect<T extends true> = T;

// Exercise genuine backend declaration resolution without opening any files.
// These assignments check real overloads; no ambient replacement is supplied.
type NodeReadFileIsNotAny = Expect<Equal<IsAny<typeof readFile>, false>>;
type NodeBufferIsNotAny = Expect<Equal<IsAny<Buffer>, false>>;
type NodePathResultIsString = Expect<Equal<ReturnType<typeof path.join>, string>>;
const readUtf8File: (file: string, encoding: 'utf8') => Promise<string> = readFile;
const joinPath: (...parts: string[]) => string = path.join;
const encodeUtf8: (value: string) => Buffer = Buffer.from;
void [readUtf8File, joinPath, encodeUtf8];

type ProtocolIsNotAny = Expect<Equal<IsAny<AgentProtocol>, false>>;
type ProtocolIsExact = Expect<Equal<AgentProtocol, 'chat_completions' | 'responses'>>;
type ProtocolComesFromCatalog = Expect<Equal<AgentProtocol, keyof typeof AGENT_PROTOCOLS>>;
type ConfigurationIsNotAny = Expect<Equal<IsAny<AgentEndpointConfiguration>, false>>;
type ConfigurationProtocolIsNotAny = Expect<Equal<IsAny<AgentEndpointConfiguration['protocol']>, false>>;
type ConfigurationBaseUrlIsNotAny = Expect<Equal<IsAny<AgentEndpointConfiguration['baseUrl']>, false>>;
type ConfigurationIsExact = Expect<Equal<AgentEndpointConfiguration, {protocol: AgentProtocol; baseUrl: string}>>;
type ParameterIsNotAny = Expect<Equal<IsAny<Parameters<typeof deriveAgentEndpoint>[0]>, false>>;
type ParametersAreExact = Expect<Equal<Parameters<typeof deriveAgentEndpoint>, [AgentEndpointConfiguration]>>;
type ResultIsNotAny = Expect<Equal<IsAny<ReturnType<typeof deriveAgentEndpoint>>, false>>;
type ResultIsString = Expect<Equal<ReturnType<typeof deriveAgentEndpoint>, string>>;
type LegacyCatalogIsNotAny = Expect<Equal<IsAny<typeof legacyProtocols>, false>>;
type LegacyFunctionIsNotAny = Expect<Equal<IsAny<typeof legacyEndpoint>, false>>;
type LegacyCatalogIsExact = Expect<Equal<typeof legacyProtocols, typeof AGENT_PROTOCOLS>>;
type LegacyFunctionIsExact = Expect<Equal<typeof legacyEndpoint, typeof deriveAgentEndpoint>>;

const chat: AgentEndpointConfiguration = {protocol: 'chat_completions', baseUrl: 'https://api.example.com/v1'};
const responses: AgentEndpointConfiguration = {protocol: 'responses', baseUrl: 'https://api.example.com/v1'};
const chatEndpoint: string = deriveAgentEndpoint(chat);
const responsesEndpoint: string = deriveAgentEndpoint(responses);
const legacyChatEndpoint: string = legacyEndpoint(chat);
const legacyResponsesEndpoint: string = legacyEndpoint(responses);
const labels: readonly string[] = [AGENT_PROTOCOLS.chat_completions.label, legacyProtocols.responses.label];
void [chatEndpoint, responsesEndpoint, legacyChatEndpoint, legacyResponsesEndpoint, labels];

// @ts-expect-error Only the two catalog keys are supported protocols.
deriveAgentEndpoint({protocol: 'auto', baseUrl: 'https://api.example.com/v1'});
// @ts-expect-error The compatibility entry must preserve the same closed protocol type.
legacyEndpoint({protocol: 'unknown_protocol', baseUrl: 'https://api.example.com/v1'});
// @ts-expect-error A string that has not been narrowed is not a known protocol.
deriveAgentEndpoint({protocol: String('responses'), baseUrl: 'https://api.example.com/v1'});
// @ts-expect-error Non-string protocol input is not canonical configuration.
deriveAgentEndpoint({protocol: 123, baseUrl: 'https://api.example.com/v1'});
// @ts-expect-error The base URL must be a string.
deriveAgentEndpoint({protocol: 'responses', baseUrl: 123});
// @ts-expect-error Canonical configuration requires an explicit protocol.
deriveAgentEndpoint({baseUrl: 'https://api.example.com/v1'});
// @ts-expect-error Endpoint derivation returns a string rather than a number.
const invalidResult: number = deriveAgentEndpoint(responses);
// @ts-expect-error The catalog has no open-ended string index signature.
AGENT_PROTOCOLS.unknown_protocol;
// @ts-expect-error The outer catalog is readonly.
AGENT_PROTOCOLS.responses = AGENT_PROTOCOLS.responses;
// @ts-expect-error Frozen nested request paths are readonly.
AGENT_PROTOCOLS.responses.path = '/responses';
// @ts-expect-error Frozen nested labels are readonly through the legacy import too.
legacyProtocols.chat_completions.label = 'Chat Completions';
void invalidResult;

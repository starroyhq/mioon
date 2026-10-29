import {createHash} from 'node:crypto';

type JsonObject = Record<string, unknown>;
type Section = 'tools' | 'system' | 'messages';
interface Boundary {section: Section; index: number; message?: number; label: string; path: string; origin: 'declared' | 'virtual'}
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const size = (value: string) => ({bytes: Buffer.byteLength(value), sha256: hash(value)});
function commonBytes(left: string, right: string): number {
  const a = Buffer.from(left), b = Buffer.from(right); let index = 0;
  while (index < Math.min(a.length, b.length) && a[index] === b[index]) index++;
  return index;
}
function ephemeral(value: unknown): boolean {
  return object(value) && value.type === 'ephemeral' && Object.keys(value).every(key => key === 'type' || key === 'ttl') &&
    (value.ttl === undefined || value.ttl === '5m' || value.ttl === '1h');
}
function blocks(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(object) : [];
}
function contentBlocks(value: unknown): JsonObject[] {
  return typeof value === 'string' ? [{type: 'text', text: value}] : blocks(value);
}
function clone(body: JsonObject, content: boolean): JsonObject {
  const result = JSON.parse(JSON.stringify(body)) as JsonObject;
  if (!content) return result;
  // Anthropic accepts string shorthand for one text block. The producer wraps
  // only the marked endpoint, so the next request can contain the old string
  // again. Normalize this legal shorthand only in the content projection.
  if (typeof result.system === 'string') result.system = contentBlocks(result.system);
  for (const message of blocks(result.messages)) if (typeof message.content === 'string') message.content = contentBlocks(message.content);
  // Only provider metadata at these legal top-level locations is removed.
  // A tool schema/input property or text mentioning cache_control is data.
  const strip = (value: JsonObject) => {if (ephemeral(value.cache_control)) delete value.cache_control;};
  blocks(result.tools).forEach(strip); blocks(result.system).forEach(strip);
  for (const message of blocks(result.messages)) blocks(message.content).forEach(strip);
  return result;
}
function boundaries(body: JsonObject, virtual = false): Boundary[] {
  const result: Boundary[] = [];
  for (const section of ['tools', 'system'] as const) {
    let ordinal = 0;
    blocks(body[section]).forEach((block, index) => {
      if (ephemeral(block.cache_control)) result.push({section, index, label: `${section}:${++ordinal}`, path: `/${section}/${index}`, origin: 'declared'});
    });
  }
  let ordinal = 0;
  blocks(body.messages).forEach((message, messageIndex) => contentBlocks(message.content).forEach((block, index) => {
    if (ephemeral(block.cache_control)) result.push({section: 'messages', message: messageIndex, index, label: `messages:${++ordinal}`, path: `/messages/${messageIndex}/content/${index}`, origin: 'declared'});
  }));
  if (!result.length && virtual) {
    const tools = blocks(body.tools), system = blocks(body.system), messages = blocks(body.messages);
    if (tools.length) result.push({section: 'tools', index: tools.length - 1, label: 'tools:1', path: `/tools/${tools.length - 1}`, origin: 'virtual'});
    if (typeof body.system === 'string' || system.length) result.push({section: 'system', index: Math.max(0, system.length - 1), label: 'system:1', path: typeof body.system === 'string' ? '/system' : `/system/${system.length - 1}`, origin: 'virtual'});
    const last = messages.at(-1), content = contentBlocks(last?.content);
    if (last && content.length) result.push({section: 'messages', message: messages.length - 1, index: content.length - 1, label: 'messages:1', path: typeof last.content === 'string' ? `/messages/${messages.length - 1}/content` : `/messages/${messages.length - 1}/content/${content.length - 1}`, origin: 'virtual'});
  }
  return result;
}
function prefix(body: JsonObject, boundary: Boundary, content: boolean): string | null {
  const value = clone(body, content), tools = blocks(value.tools), messages = blocks(value.messages);
  // HTTP property order is not Anthropic's prompt order. Compare an explicit
  // tools -> system -> messages projection, ending at the selected block.
  if (boundary.section === 'tools') return boundary.index < tools.length ? JSON.stringify({tools: tools.slice(0, boundary.index + 1)}) : null;
  const system = value.system ?? [];
  if (boundary.section === 'system') {
    if (typeof system === 'string') return boundary.index === 0 ? JSON.stringify({tools, system}) : null;
    const systemBlocks = blocks(system);
    return boundary.index < systemBlocks.length ? JSON.stringify({tools, system: systemBlocks.slice(0, boundary.index + 1)}) : null;
  }
  const message = messages[boundary.message!];
  if (!message || boundary.index >= contentBlocks(message.content).length) return null;
  const endpointContent = typeof message.content === 'string' ? message.content : blocks(message.content).slice(0, boundary.index + 1);
  return JSON.stringify({tools, system, messages: [...messages.slice(0, boundary.message), {...message, content: endpointContent}]});
}
function comparison(current: string, previous: string | null) {
  return {...size(current), previous: previous === null ? null : {...size(previous), equal: current === previous, commonPrefixBytes: commonBytes(current, previous)}};
}
function messageBlockOffset(body: JsonObject, point: Boundary): number | null {
  if (point.section !== 'messages') return null;
  const messages = blocks(body.messages);
  if (!messages[point.message!] || point.index >= contentBlocks(messages[point.message!]!.content).length) return null;
  return messages.slice(0, point.message).reduce((sum, message) => sum + contentBlocks(message.content).length, 0) + point.index + 1;
}

/** Offline byte evidence only: neither this JSON projection nor a shared byte
 * prefix is the provider's cache key, token eligibility or a measured hit. */
export function reportAnthropicPrefixes(bodyText: string, previousBodyText?: string, options: {virtualBreakpoints?: boolean} = {}) {
  const parsed: unknown = JSON.parse(bodyText), oldParsed: unknown = previousBodyText === undefined ? undefined : JSON.parse(previousBodyText);
  if (!object(parsed) || oldParsed !== undefined && !object(oldParsed)) throw new TypeError('Expected an object request body.');
  const body = parsed, previous = oldParsed as JsonObject | undefined;
  const previousPoints = previous ? boundaries(previous, options.virtualBreakpoints) : [];
  const sectionText = (value: JsonObject, section: 'tools' | 'system', content: boolean) => JSON.stringify(clone(value, content)[section] ?? []);
  const points = boundaries(body, options.virtualBreakpoints).map(point => {
    const old = previousPoints.find(value => value.label === point.label);
    const mode = (content: boolean) => {
      const current = prefix(body, point, content)!;
      const prior = previous && old ? prefix(previous, old, content) : null;
      const priorAtCurrent = previous ? prefix(previous, point, content) : null;
      const currentAtPrior = old ? prefix(body, old, content) : null;
      return {
        ...comparison(current, prior),
        previousAtCurrentBoundary: priorAtCurrent === null ? null : {...size(priorAtCurrent), equalToCurrent: priorAtCurrent === current},
        currentAtPreviousBoundary: currentAtPrior === null || prior === null ? null : {...size(currentAtPrior), equalToPrevious: currentAtPrior === prior},
      };
    };
    const offset = messageBlockOffset(body, point), oldOffset = old ? messageBlockOffset(body, old) : null;
    const distance = offset === null || oldOffset === null ? null : offset - oldOffset;
    return {
      ...point, rawWire: mode(false), content: mode(true),
      lookbackEstimate: {messageBlocksSincePreviousBoundary: distance, withinTwentyMessageBlocks: distance === null || distance < 0 ? null : distance < 20, includesCurrentBoundary: true as const, consecutiveToolRunsCollapsed: false as const, apiEligibilityKnown: false as const},
    };
  });
  return {
    measurement: 'Offline UTF-8 JSON projection in tools/system/messages order. rawWire retains original shorthand and directives; content normalizes legal system/message string shorthand to one text block and removes only recognized cache_control metadata. Old endpoints are also compared at their corresponding current position. The inclusive twenty-position estimate counts message blocks without collapsing API tool runs; it does not establish API eligibility or a real cache hit.',
    request: size(bodyText), breakpointCount: points.length, declaredBreakpointCount: points.filter(point => point.origin === 'declared').length,
    toolLayerChanged: previous ? sectionText(body, 'tools', true) !== sectionText(previous, 'tools', true) : null,
    tools: comparison(sectionText(body, 'tools', true), previous ? sectionText(previous, 'tools', true) : null),
    system: comparison(sectionText(body, 'system', true), previous ? sectionText(previous, 'system', true) : null),
    breakpoints: points,
  };
}
export type AnthropicPrefixReport = ReturnType<typeof reportAnthropicPrefixes>;

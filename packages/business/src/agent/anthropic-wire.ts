import {agentChatError} from './chat-errors.ts';
import {exactObject} from './config.ts';
import {parseModelToolArguments} from './model-tool-arguments.ts';
import {toolId, toolObject, toolString} from './tool-wire-values.ts';
import type {AgentTaskJson} from '@mioon/contracts/agent-tasks-v2';

export type AnthropicTextBlock = {type: 'text'; text: string};
export type AnthropicThinkingBlock = {type: 'thinking'; thinking: string; signature: string} | {type: 'redacted_thinking'; data: string};
export type AnthropicToolUseBlock = {type: 'tool_use'; id: string; name: string; input: Record<string, AgentTaskJson>};
export type AnthropicToolResultBlock = {type: 'tool_result'; tool_use_id: string; content: string};
export type AnthropicContentBlock = AnthropicTextBlock | AnthropicThinkingBlock | AnthropicToolUseBlock;
export type AnthropicMessage = {role: 'user' | 'assistant'; content: string | (AnthropicContentBlock | AnthropicToolResultBlock)[]};
const MAX_ARGUMENT_BYTES = 32 * 1024;
function invalid(): never {throw agentChatError('AGENT_CHAT_VALIDATION');}
function text(value: unknown): string {
  if (!toolString(value, 512 * 1024)) invalid();
  return value;
}
function objectInput(value: unknown): Record<string, AgentTaskJson> {
  if (!toolObject(value)) invalid();
  try {return parseModelToolArguments(JSON.stringify(value), MAX_ARGUMENT_BYTES);} catch {return invalid();}
}

/** Normalize only the implemented text/client-tool subset, plus assistant
 * thinking retained from a thinking request. No tool is executed here, and
 * native tool results must settle the preceding assistant calls in their
 * original order before another model request can be constructed. */
export function anthropicMessages(history: readonly unknown[]): {system?: string; messages: AnthropicMessage[]} {
  if (!Array.isArray(history) || !history.length) invalid();
  let system: string | undefined;
  const messages: AnthropicMessage[] = [], seen = new Set<string>();
  let pending: string[] = [];
  for (const [position, message] of history.entries()) {
    if (!exactObject(message, ['role', 'content'])) invalid();
    if (message.role === 'system') {
      if (position || system !== undefined) invalid();
      system = text(message.content);
      continue;
    }
    if (message.role !== 'user' && message.role !== 'assistant') invalid();
    const role = message.role;
    if (typeof message.content === 'string') {
      if (pending.length) invalid();
      messages.push({role, content: text(message.content)});
      continue;
    }
    if (!Array.isArray(message.content) || !message.content.length || message.content.length > 128) invalid();
    const content: (AnthropicContentBlock | AnthropicToolResultBlock)[] = [];
    const calls: string[] = [];
    let resultIndex = 0, textSeen = false;
    if (role === 'assistant' && pending.length) invalid();
    for (const block of message.content) {
      if (exactObject(block, ['type', 'text']) && block.type === 'text') {
        if (role === 'user' && resultIndex !== pending.length) invalid();
        textSeen = true;
        content.push({type: 'text', text: text(block.text)});
      } else if (exactObject(block, ['type', 'thinking', 'signature']) && block.type === 'thinking' && role === 'assistant') {
        // Retained thinking returns unchanged, in order and signed, within its round.
        const signature = text(block.signature);
        if (!signature) invalid();
        content.push({type: 'thinking', thinking: text(block.thinking), signature});
      } else if (exactObject(block, ['type', 'data']) && block.type === 'redacted_thinking' && role === 'assistant') {
        const data = text(block.data);
        if (!data) invalid();
        content.push({type: 'redacted_thinking', data});
      } else if (exactObject(block, ['type', 'id', 'name', 'input']) && block.type === 'tool_use' && role === 'assistant') {
        const id = toolId(block.id), name = toolId(block.name);
        if (seen.has(id)) invalid();
        seen.add(id); calls.push(id);
        content.push({type: 'tool_use', id, name, input: objectInput(block.input)});
      } else if (exactObject(block, ['type', 'tool_use_id', 'content']) && block.type === 'tool_result' && role === 'user') {
        if (textSeen || resultIndex >= pending.length || block.tool_use_id !== pending[resultIndex]) invalid();
        resultIndex++;
        content.push({type: 'tool_result', tool_use_id: toolId(block.tool_use_id), content: text(block.content)});
      } else invalid();
    }
    if (role === 'user') {
      if (resultIndex !== pending.length) invalid();
      pending = [];
    } else pending = calls;
    messages.push({role, content});
  }
  if (!messages.length || pending.length) invalid();
  return {...(system === undefined ? {} : {system}), messages};
}

import {agentChatError} from './chat-errors.ts';

// Value checks for model tool-call wire fields. They bind no tool catalog.
export function toolProtocolError(): never { throw agentChatError('AGENT_CHAT_PROTOCOL_ERROR'); }
export const toolObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const wellFormed = (value: string): boolean => Buffer.from(value, 'utf8').toString('utf8') === value;
export function toolString(value: unknown, maximum: number): value is string { return typeof value === 'string' && wellFormed(value) && Buffer.byteLength(value) <= maximum; }
export function toolId(value: unknown): string {
  if (!toolString(value, 256) || !value || /[\u0000-\u0020\u007f]/u.test(value)) toolProtocolError();
  return value;
}

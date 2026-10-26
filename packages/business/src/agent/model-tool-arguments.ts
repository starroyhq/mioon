import {agentChatError} from './chat-errors.ts';
import type {AgentTaskJson} from '@mioon/contracts/agent-tasks-v2';

function invalid():never {throw agentChatError('AGENT_CHAT_PROTOCOL_ERROR');}

/** Parse one bounded JSON object without silently accepting duplicate keys.
 * This is a wire parser only; each tool still validates its own domain schema. */
export function parseModelToolArguments(source:string,maxBytes:number):Record<string,AgentTaskJson> {
  if(typeof source!=='string'||!Number.isSafeInteger(maxBytes)||maxBytes<1||Buffer.byteLength(source)>maxBytes||Buffer.from(source).toString('utf8')!==source)invalid();
  let offset=0;
  const whitespace=()=>{while(/\s/u.test(source[offset]??'')&&offset<source.length)offset++;};
  const token=():string=>{const start=offset++;while(offset<source.length){const c=source[offset++];if(c==='\\'){offset++;continue;}if(c==='"')return JSON.parse(source.slice(start,offset)) as string;}return invalid();};
  const value=(depth=0):void=>{
    if(depth>32)invalid();
    whitespace();const c=source[offset];
    if(c==='"'){token();return;}
    if(c==='{'||c==='['){offset++;whitespace();const close=c==='{'?'}':']',keys=new Set<string>();if(source[offset]===close){offset++;return;}
      for(;;){whitespace();if(c==='{'){if(source[offset]!=='"')invalid();const key=token();if(keys.has(key))invalid();keys.add(key);whitespace();if(source[offset++]!==':')invalid();}value(depth+1);whitespace();const next=source[offset++];if(next===close)return;if(next!==',')invalid();}
    }
    const start=offset;while(offset<source.length&&!/[\s,}\]]/u.test(source[offset]))offset++;if(start===offset)invalid();
  };
  try{value();whitespace();if(offset!==source.length)invalid();const parsed:unknown=JSON.parse(source);if(parsed===null||typeof parsed!=='object'||Array.isArray(parsed))invalid();return parsed as Record<string,AgentTaskJson>;}catch{return invalid();}
}

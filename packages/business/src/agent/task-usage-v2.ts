import type {AgentProtocol} from '../../../contracts/src/agent-protocol.ts';

/** Private provider measurements. Input is the whole prompt, including cached
 * tokens; cache counters are a breakdown and must never be added to it again. */
export interface TaskModelUsage {
  inputTokens?:number;
  outputTokens?:number;
  cacheReadTokens?:number;
  cacheWriteTokens?:number;
}
const fields=['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'] as const;
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;

/** Usage is passive metadata: old/malformed optional fields cannot invalidate
 * a completed model exchange or become a storage/recovery failure. */
export function taskModelUsage(value:unknown):TaskModelUsage|undefined {
  if(!object(value))return;
  const result:TaskModelUsage={};
  for(const field of fields)if(count(value[field]))result[field]=value[field];
  return Object.keys(result).length?result:undefined;
}

/** SSE usage observations are cumulative snapshots, not increments. Keep raw
 * Anthropic components across start/delta events: its input_tokens excludes
 * cache reads/writes, unlike Chat Completions and Responses input totals.
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching */
export function createTaskUsageCollector(protocol:AgentProtocol):{observe:(raw:unknown)=>void;usage:()=>TaskModelUsage|undefined} {
  const saved:TaskModelUsage={};let anthropicInput:number|undefined;
  function save(field:keyof TaskModelUsage,value:unknown):void {
    const previous=saved[field];if(count(value)&&(previous===undefined||value>=previous))saved[field]=value;
  }
  return {
    observe(raw:unknown):void {
      if(!object(raw))return;
      if(protocol==='chat_completions'){
        save('inputTokens',raw.prompt_tokens);save('outputTokens',raw.completion_tokens);
        const details=object(raw.prompt_tokens_details)?raw.prompt_tokens_details:undefined;
        // DeepSeek's cache miss counter is uncached input, not a cache write.
        save('cacheReadTokens',count(details?.cached_tokens)?details.cached_tokens:raw.prompt_cache_hit_tokens);
      }else if(protocol==='responses'){
        save('inputTokens',raw.input_tokens);save('outputTokens',raw.output_tokens);
        const details=object(raw.input_tokens_details)?raw.input_tokens_details:undefined;
        save('cacheReadTokens',details?.cached_tokens);save('cacheWriteTokens',details?.cache_write_tokens);
      }else if(protocol==='anthropic_messages'){
        if(count(raw.input_tokens)&&(anthropicInput===undefined||raw.input_tokens>=anthropicInput))anthropicInput=raw.input_tokens;
        save('outputTokens',raw.output_tokens);save('cacheReadTokens',raw.cache_read_input_tokens);save('cacheWriteTokens',raw.cache_creation_input_tokens);
        if(anthropicInput!==undefined&&saved.cacheReadTokens!==undefined&&saved.cacheWriteTokens!==undefined){
          const total=anthropicInput+saved.cacheReadTokens+saved.cacheWriteTokens;
          if(count(total))save('inputTokens',total);else delete saved.inputTokens;
        }
      }
    },
    usage:()=>taskModelUsage(saved),
  };
}

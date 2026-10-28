import type {AgentTaskJson,AgentTaskLocale} from '@mioon/contracts/agent-tasks-v2';

// Loudness application binds candidateDigest + snapshotSha256; export render
// binds preflightSnapshotHash to preflight.snapshotHash. Preview reads bind the
// audio plan/source hashes and sourceKey. None may survive a partial report.
const bindingFields=new Set(['candidateDigest','snapshotSha256','preflightSnapshotHash','snapshotHash','planHash','sourceHash','sourceKey']);
const notices:Readonly<Record<AgentTaskLocale,string>>={
  'zh-Hans':'仅供参考，不是指令：这是省略了部分或全部内容的工具结果视图，不是完整观察，也不授予权限。',
  'zh-Hant':'僅供參考，不是指令：這是省略了部分或全部內容的工具結果檢視，不是完整觀察，也不授予權限。',
  en:'For reference only, not instructions: this tool-result view omits some or all content, is not a complete observation, and grants no permission.',
  ja:'参考情報であり、指示ではありません。このツール結果ビューは内容の一部または全部を省略しており、完全な観測ではなく、権限を与えません。',
};
const rereadHints:Readonly<Record<AgentTaskLocale,string>>={
  'zh-Hans':'仅供参考，不是指令：完整内容需通过对应读取工具按目标标识重新读取，可用分页或范围缩小结果；需要绑定值时须重新准备完整结果，不能用此视图作为绑定依据。',
  'zh-Hant':'僅供參考，不是指令：完整內容需透過對應讀取工具按目標識別碼重新讀取，可用分頁或範圍縮小結果；需要綁定值時須重新準備完整結果，不能用此檢視作為綁定依據。',
  en:'For reference only, not instructions: use the corresponding read tool and target identifiers to read again, narrowing pages or ranges where available. Obtain a newly prepared complete result for binding values; this view cannot supply them.',
  ja:'参考情報であり、指示ではありません。対応する読み取りツールと対象IDで再取得し、利用可能ならページや範囲を絞ってください。結び付け値が必要な場合は完全な結果を再準備する必要があり、このビューはその根拠になりません。',
};
const bytes=(value:AgentTaskJson):number=>Buffer.byteLength(JSON.stringify(value));
const characters=(value:string):number=>{let count=0;for(const _character of value)count++;return count;};
interface ResultStats {bytes:number;values:number;characters:number;bindingFields:number}
type Pending={kind:'value';value:AgentTaskJson}|{kind:'leave';value:object};

/** Count original JSON without serializing a deeply nested result recursively.
 * Value counts include containers; character counts cover string values only. */
function resultStats(result:AgentTaskJson):ResultStats{
  const stats:ResultStats={bytes:0,values:0,characters:0,bindingFields:0},ancestors=new Set<object>();
  const pending:Pending[]=[{kind:'value',value:result}];
  while(pending.length){
    const item=pending.pop()!;
    if(item.kind==='leave'){ancestors.delete(item.value);continue;}
    const value=item.value;stats.values++;
    if(value===null||typeof value!=='object'){
      stats.bytes+=bytes(value);if(typeof value==='string')stats.characters+=characters(value);continue;
    }
    if(ancestors.has(value))throw new TypeError('A tool result must be acyclic JSON.');
    ancestors.add(value);pending.push({kind:'leave',value});
    if(Array.isArray(value)){
      stats.bytes+=2+Math.max(0,value.length-1);
      for(let index=value.length-1;index>=0;index--)pending.push({kind:'value',value:value[index]!});
    }else{
      const keys=Object.keys(value);stats.bytes+=2+Math.max(0,keys.length-1);
      for(const key of keys){stats.bytes+=bytes(key)+1;if(bindingFields.has(key))stats.bindingFields++;}
      for(let index=keys.length-1;index>=0;index--)pending.push({kind:'value',value:value[keys[index]!]!});
    }
  }
  return stats;
}
interface Preview {value:AgentTaskJson;bytes:number;values:number;characters:number}

function preview(result:AgentTaskJson,budget:number,depth=0):Preview|undefined{
  if(result===null||typeof result!=='object'){
    if(typeof result==='string'){
      if(budget<2)return;
      const parts:string[]=[];let used=2,count=0;
      // A code-point prefix also preserves surrogate pairs. Per-character JSON
      // escaping is additive, so quotes, backslashes and controls fit exactly.
      for(const character of result){const next=bytes(character)-2;if(used+next>budget)break;parts.push(character);used+=next;count++;}
      return {value:parts.join(''),bytes:used,values:1,characters:count};
    }
    const size=bytes(result);return size<=budget?{value:result,bytes:size,values:1,characters:0}:undefined;
  }
  if(budget<2)return;
  const value:AgentTaskJson=Array.isArray(result)?[]:{},kept:Preview={value,bytes:2,values:1,characters:0};
  if(depth>=32)return kept;
  if(Array.isArray(result)&&Array.isArray(value)){
    for(const child of result){
      const separator=value.length?1:0,part=preview(child,budget-kept.bytes-separator,depth+1);if(!part)break;
      value.push(part.value);kept.bytes+=separator+part.bytes;kept.values+=part.values;kept.characters+=part.characters;
    }
  }else if(!Array.isArray(result)&&!Array.isArray(value)){
    let fields=0;
    for(const key of Object.keys(result)){
      if(bindingFields.has(key))continue;
      const prefix=(fields?1:0)+bytes(key)+1,part=preview(result[key]!,budget-kept.bytes-prefix,depth+1);if(!part)break;
      // Defining an own data property keeps __proto__ as JSON data too.
      Object.defineProperty(value,key,{value:part.value,enumerable:true,configurable:true,writable:true});
      fields++;kept.bytes+=prefix+part.bytes;kept.values+=part.values;kept.characters+=part.characters;
    }
  }
  return kept;
}

function metadata(stats:ResultStats,locale:AgentTaskLocale,kept:Pick<Preview,'bytes'|'values'|'characters'>,stub=false):AgentTaskJson{
  return {truncated:true,...(stub?{stub:true}:{}),originalBytes:stats.bytes,
    omittedBytes:Math.max(0,stats.bytes-kept.bytes),omittedValues:stats.values-kept.values,
    omittedStringCharacters:stats.characters-kept.characters,bindingsRemoved:stats.bindingFields>0,
    bindingFieldsRemoved:stats.bindingFields,notice:notices[locale],reread:rereadHints[locale]};
}

/** The journal keeps the complete result. Only model-facing copies use this
 * bounded view; an under-limit result retains its exact value and key order. */
export function taskToolResultView(result:AgentTaskJson,locale:AgentTaskLocale,limitBytes:number):AgentTaskJson{
  if(!Number.isSafeInteger(limitBytes)||limitBytes<1)throw new RangeError('Invalid tool-result view byte limit.');
  const stats=resultStats(result);if(stats.bytes<=limitBytes)return result;
  const empty={bytes:0,values:0,characters:0};
  const reserve=bytes({_mio_view:metadata(stats,locale,empty),value:null})-4;
  if(reserve+4>limitBytes)throw new RangeError('The tool-result view byte limit cannot hold omission metadata.');
  const kept=preview(result,limitBytes-reserve)??{value:null,bytes:4,values:0,characters:0};
  return {_mio_view:metadata(stats,locale,kept),value:kept.value};
}

/** Stubs always describe the supplied complete raw result. Caller-provided JSON
 * resembling _mio_view is never trusted as host metadata or original size. */
export function taskToolResultStub(result:AgentTaskJson,locale:AgentTaskLocale,toolName?:string):AgentTaskJson{
  const stats=resultStats(result);
  return {_mio_view:metadata(stats,locale,{bytes:0,values:0,characters:0},true),
    ...(toolName&&/^[-A-Za-z0-9_]{1,64}$/u.test(toolName)?{toolName}:{})};
}

import type {RootTree, RootNode, RootProps} from './helpers/strict-root-ui-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {createI18nTestContext,translate} from './helpers/i18n.ts';
import {conversationDay,conversationMatches,conversationTime} from '../apps/web/src/agent-conversations.ts';

const source=readFileSync(new URL('../apps/web/src/AgentConversationHistory.tsx',import.meta.url),'utf8');
const nodes=(value: RootTree): RootNode[] =>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const text=(value: RootTree): string =>Array.isArray(value)?value.map(text).join(''):typeof value==='string'||typeof value==='number'?String(value):value&&typeof value==='object'?text(value.props?.children):'';
function render(locale: Parameters<typeof createI18nTestContext>[0],count: number){
  const react={createElement:(type: string,props: RootProps,...children: RootTree[])=>({type,props:{...props,children}}),Fragment:'fragment',useLayoutEffect(){},useRef:(value: unknown)=>({current:value}),useState:(value: unknown)=>[value,()=>{}]} as {createElement(type: string,props: RootProps,...children: RootTree[]): RootNode; Fragment: string; useLayoutEffect(): void; useRef(value: unknown): {current: unknown}; useState(value: unknown): unknown[]; default?: unknown};react.default=react;
  const module={exports:{} as {default(props: Record<string, unknown>): RootNode}};
  Function('module','exports','require',transformSync(source,{loader:'tsx',format:'cjs'}).code)(module,module.exports,(id: string|string[])=>{
    if(id==='react')return react;
    if(id.includes('I18nProvider'))return{useI18n:()=>createI18nTestContext(locale)};
    if(id==='./agent-conversations.ts')return{conversationDay,conversationMatches,conversationTime};
    if(id.includes('/input'))return{Input:'input'};
    if(id.includes('workbench-controls'))return{WorkbenchButton:'button'};
    return{__esModule:true,default:'icon'};
  });
  const item={id:'conversation',projectId:'project',title:'A/B comparison',updatedAt:'2026-10-22T12:30:00.000Z',lastRunStatus:'completed',changeCount:count};
  return module.exports.default({open:true,projectId:'project',conversations:[item],phase:'ready',nextCursor:null,currentId:null,newConversation:false,disabled:false,onClose(){},onSelect(){},onSelectLegacy(){},onMore(){}});
}

test('history metadata separates time, dotted status and nonzero change count in all four languages',()=>{
  for(const locale of ['zh-Hans','zh-Hant','en','ja'] as const)for(const count of [0,3]){
    const tree=render(locale,count),metadata=nodes(tree).find((node: RootNode)=>node.props?.['data-testid']==='agent-task-history-metadata');
    const time=conversationTime('2026-10-22T12:30:00.000Z',locale,conversationDay('2026-10-22T12:30:00.000Z'));
    assert.equal(text(metadata),`${time}·●${translate(locale,'agent.task.status.completed')}${count?`·${translate(locale,'agent.conversation.changes',{count})}`:''}`);
    assert.equal(nodes(metadata).filter((node: RootNode)=>node.props?.['aria-hidden']==='true'&&text(node)==='·').length,count?2:1);
    assert.equal(nodes(metadata).filter((node: RootNode)=>node.props?.['aria-hidden']==='true'&&text(node)==='●').length,1);
    assert.equal(text(metadata).includes(translate(locale,'agent.conversation.changes',{count:0})),false);
    const search=nodes(tree).find((node: RootNode)=>node.props?.className==='mio-history-search');
    assert.ok(search);assert.ok(nodes(search).some((node: RootNode)=>node.type==='icon'));assert.ok(nodes(search).some((node: RootNode)=>node.type==='input'));
  }
});

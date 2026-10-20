import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {operationDefinition} from '../packages/client/src/index.ts';
import {schemas} from '../packages/contracts/src/index.ts';

const hidden=new Set(['projectId','requestId']);
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function project(value:unknown):unknown{
 if(Array.isArray(value))return value.map(project);
 if(!record(value))return value;
 return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,
  key==='properties'&&record(child)?Object.fromEntries(Object.entries(child).filter(([field])=>!hidden.has(field)).map(([field,nested])=>[field,project(nested)])):
  key==='required'&&Array.isArray(child)?child.filter(field=>!hidden.has(String(field))):project(child),
 ]));
}
const entries=Object.fromEntries(Object.keys(schemas).map(operation=>[operation,project(operationDefinition(operation).inputSchema)]));
const hash=createHash('sha256').update(JSON.stringify(entries)).digest('hex');
writeFileSync(new URL('../packages/business/src/agent/task-tool-schemas-v2.ts',import.meta.url),
 '// Generated with node scripts/generate-agent-task-schemas.ts.\n'+
 '// Shared runtime schemas remain authoritative; host supplies project identity and replay keys.\n'+
 `export const AGENT_TASK_TOOL_SCHEMA_HASH=${JSON.stringify(hash)};\n`+
 'export const AGENT_TASK_TOOL_SCHEMAS:Readonly<Record<string,unknown>>='+JSON.stringify(entries,null,1)+';\n');

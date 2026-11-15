import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {isDeepStrictEqual} from 'node:util';
import {modelOperationDefinition} from '../packages/client/src/index.ts';
import {schemas} from '../packages/contracts/src/index.ts';
import {mioCanvasSchemas} from '../packages/contracts/src/mio-canvas.ts';
import {projectAgentTaskToolSchema} from '../packages/business/src/agent/task-tool-model-schema.ts';

const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
// Reuse the client's installed converter only at generation time. Public
// CLI/MCP discovery keeps its original references and runtime dependencies.
const {zodToJsonSchema}=createRequire(new URL('../packages/client/package.json',import.meta.url))('zod-to-json-schema') as {zodToJsonSchema:(schema:unknown,options:{$refStrategy:'none';strictUnions:true;pipeStrategy:'input'})=>unknown};
const entries=Object.fromEntries(Object.entries(schemas).map(([operation,schema])=>{
 const shared=modelOperationDefinition(operation).inputSchema,expected=projectAgentTaskToolSchema(shared);
 const converted=zodToJsonSchema(schema,{$refStrategy:'none',strictUnions:true,pipeStrategy:'input'});
 if(!record(converted))throw Error(`Invalid generated tool schema: ${operation}`);
 const projected=projectAgentTaskToolSchema(shared.type==='object'&&converted.type===undefined?{...converted,type:'object'}:converted);
 if(!isDeepStrictEqual(projected,expected))throw Error(`Inline tool schema differs from shared constraints: ${operation}`);
 return [operation,projected];
}));
// Host-only canvas inputs never enter the public CLI/MCP operation registry.
for(const [operation,schema] of Object.entries(mioCanvasSchemas)){
 if(Object.hasOwn(entries,operation))throw Error(`Canvas tool collides with public operation: ${operation}`);
 const {$schema: _dialect,...converted}=zodToJsonSchema(schema,{$refStrategy:'none',strictUnions:true,pipeStrategy:'input'}) as Record<string,unknown>;
 if(converted.type!=='object')throw Error(`Invalid generated host tool schema: ${operation}`);
 entries[operation]=projectAgentTaskToolSchema(converted);
}
const hash=createHash('sha256').update(JSON.stringify(entries)).digest('hex');
const generated=
 '// Generated with node scripts/generate-agent-task-schemas.ts.\n'+
 '// Shared runtime schemas remain authoritative; host supplies project identity and replay keys.\n'+
 `export const AGENT_TASK_TOOL_SCHEMA_HASH=${JSON.stringify(hash)};\n`+
 'export const AGENT_TASK_TOOL_SCHEMAS:Readonly<Record<string,unknown>>='+JSON.stringify(entries,null,1)+';\n';
const target=new URL('../packages/business/src/agent/task-tool-schemas-v2.ts',import.meta.url);
if(process.argv.includes('--check')){
 if(readFileSync(target,'utf8')!==generated)throw Error('Fixed model tool schemas differ; --check never writes reviewed agent files.');
 process.stdout.write('Fixed model tool schemas match exactly.\n');
}else writeFileSync(target,generated);

import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {schemas, operationDefinition, discoverSchema} from '@mioon/client';
import {LOCALES, catalogs, validateCatalogs, translate} from '../packages/i18n/src/index.ts';
import type {Locale, MessageKey} from '../packages/i18n/src/index.ts';
import {presentationLocale, localizeHelp, localizeToolDescription} from '../packages/i18n/src/presentation.ts';
import {operationMessages} from '../packages/i18n/src/catalogs/operations.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
const round2Operations = ['export.cancel', 'export.activity.get', 'export.output.get', 'workspace.settings.get', 'workspace.settings.set', 'workspace.backup.status', 'workspace.backup.list', 'workspace.backup.create', 'workspace.backup.restore.stage', 'task.disposition.list', 'task.disposition.markFailed', 'task.disposition.archiveCompleted'] as const;
const cleanEnv = (): Record<string, string | undefined> => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MIOON_')));
interface CliResult { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> }
interface McpToolView { name: string; description: string; [key: string]: unknown }
interface McpResultView { result: Record<string, unknown> & { tools?: McpToolView[]; instructions?: string } }
interface HelpDataView { options: Record<string, string>; usage: unknown; operations: unknown; exitCodes: unknown }
interface McpHarness { request: (method: string, params?: Record<string, unknown>) => Promise<McpResultView>; initialized: Record<string, unknown> & { instructions?: string } }
function cli(args: string[], env: Record<string, string | undefined> = {}): CliResult {
  const result = spawnSync(process.execPath, ['apps/cli/src/index.ts', ...args], {cwd:root, env:{...cleanEnv(), ...env}, encoding:'utf8', timeout:30000, maxBuffer:8*1024*1024});
  assert.ifError(result.error);
  return {status: result.status, stdout: String(result.stdout), stderr: String(result.stderr), json: JSON.parse(String(result.stdout)) as Record<string, unknown>};
}
// Minimal bounded stdio harness: no backend, server bootstrap or generation.
async function mcp(t: import('node:test').TestContext, args: string[] = [], env: Record<string, string | undefined> = {}): Promise<McpHarness> {
  const child = spawn(process.execPath, ['apps/mcp/src/index.ts', ...args], {cwd:root, env:{...cleanEnv(), ...env}, stdio:['pipe','pipe','pipe']});
  let buffer = '', next = 0; const pending = new Map<number, { resolve: (value: McpResultView) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  child.stderr.resume();
  t.after(() => { child.kill('SIGKILL'); for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('MCP closed')); } });
  child.stdout.setEncoding('utf8').on('data', (bytes: string) => { buffer += bytes; let end; while ((end=buffer.indexOf('\n'))>=0) { const line=buffer.slice(0,end); buffer=buffer.slice(end+1); if (!line) continue; const result=JSON.parse(line) as {id?: number} & McpResultView, entry=result.id===undefined?undefined:pending.get(result.id); if (entry) {pending.delete(result.id as number); clearTimeout(entry.timer); entry.resolve(result);}} });
  child.on('error', error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); });
  function request(method: string, params: Record<string, unknown> = {}): Promise<McpResultView> { return new Promise<McpResultView>((resolve,reject) => { const id=++next, timer=setTimeout(() => {pending.delete(id); child.kill('SIGKILL'); reject(new Error(`MCP ${method} exceeded 30 seconds`));},30000); pending.set(id,{resolve,reject,timer}); child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n'); }); }
  const initialized = await request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'presentation-test',version:'1'}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  return {request, initialized:initialized.result};
}
test('presentation catalog is exhaustive in four locales, with unchanged operation identities', () => {
  assert.deepEqual(validateCatalogs(catalogs), []);
  assert.deepEqual(Object.keys(operationMessages).sort(), Object.keys(schemas).map(key=>`operation.${key}`).sort());
  assert.equal(presentationLocale(undefined),undefined);
  for (const locale of LOCALES) assert.equal(presentationLocale(locale),locale);
  for (const invalid of ['',null,'system','zh-TW','en-US','fr']) assert.throws(()=>presentationLocale(invalid));
  const original={options:{'--input':'original'},connection:['original'],safety:'original'};
  assert.equal(localizeHelp(original),original);
});
test('continuous plan discovery has four explicit locales without changing machine definitions', () => {
  const operation = 'timeline.audioPreview.continuousPlan';
  const definition = operationDefinition(operation);
  const before = JSON.stringify(definition);
  const schema = JSON.stringify(discoverSchema({operation}));
  for (const locale of LOCALES) {
    for (const name of Object.keys(schemas)) {
      const prose = localizeToolDescription(name, operationDefinition(name).description, locale);
      assert.equal(prose, translate(locale, `operation.${name}` as MessageKey));
      assert.ok(prose.length > 0);
    }
    const description = localizeToolDescription(operation, definition.description, locale);
    assert.match(description, /V2/);
    assert.match(description, /96 MiB/);
    assert.match(description, /Mio/);
    assert.notEqual(description, translate(locale, 'operation.timeline.audioPreview.plan'));
    assert.equal(JSON.stringify(operationDefinition(operation)), before);
    assert.equal(JSON.stringify(discoverSchema({operation})), schema);
  }
});
test('CLI localizes only prose; default help snapshot, schema, version and error JSON stay exact', {timeout:180000}, () => {
  const original=cli(['--help']);
  assert.equal(original.status,0);
  const snapshot=JSON.parse(readFileSync(new URL('./fixtures/cli-help-legacy.json',import.meta.url),'utf8'));
  // Keep the frozen help fixture: only explicit discovery additions may differ,
  // not legacy prose, schemas or the relative ordering of existing operations.
  const expectedOperations = [...snapshot.data.operations];
  expectedOperations.unshift('project.rename', 'project.delete', 'project.summary.list', 'agent.authorization.list', 'agent.authorization.grant', 'agent.authorization.revoke');
  expectedOperations.unshift(...round2Operations);
  expectedOperations.splice(expectedOperations.indexOf('timeline.loudness.prepare') + 1, 0, 'timeline.clip.loudness');
  expectedOperations.splice(expectedOperations.indexOf('timeline.audioPreview.plan') + 1, 0, 'timeline.audioPreview.continuousPlan');
  expectedOperations.splice(expectedOperations.indexOf('asset.disposition.set') + 1, 0, 'asset.annotation.list', 'asset.annotation.set');
  expectedOperations.splice(expectedOperations.indexOf('provider.list') + 1, 0, 'video.connection.list');
  expectedOperations.splice(expectedOperations.indexOf('timeline.clip.remove') + 1, 0, 'timeline.clip.rippleRemove');
  expectedOperations.splice(expectedOperations.indexOf('timeline.loudness.apply') + 1, 0, 'timeline.clip.refreshSources', 'timeline.shots.append', 'timeline.clip.splitAtScenes');
  expectedOperations.splice(expectedOperations.indexOf('frame.task.recoverResult') + 1, 0, 'scene.detect', 'scene.request.get', 'scene.task.get', 'scene.task.list', 'scene.task.cancel', 'scene.result.get', 'scene.cuts.save');
  const expectedUsage = [...snapshot.data.usage];
  expectedUsage.splice(expectedUsage.indexOf('mioon capabilities') + 1, 0, 'mioon agent --help');
  expectedUsage.splice(expectedUsage.indexOf('mioon export download --input <JSON> --output <new-local-file>') + 1, 0, 'mioon project export --input <JSON> --output <new-local-file.mioon>', 'mioon project import --file <local-file.mioon> --request-id <id> [--input <JSON>]', 'mioon project duplicate --request-id <id> --input <JSON>');
  assert.deepEqual(original.json,{...snapshot, data:{...snapshot.data, usage:expectedUsage, operations:expectedOperations}});
  const schema=cli(['schema','project.create']).stdout;
  const version=cli(['--version']).stdout;
  const bad=cli(['--unknown']).stdout;
  for (const locale of LOCALES) {
    const help=cli(['--locale',locale,'--help']).json.data as HelpDataView;
    assert.equal(help.options['--input'],translate(locale,'cli.option.input'));
    assert.equal(help.options['--locale'],translate(locale,'cli.option.locale'));
    const originalData=original.json.data as HelpDataView;
    assert.deepEqual(help.usage,originalData.usage);
    assert.deepEqual(help.operations,originalData.operations);
    assert.deepEqual(help.exitCodes,originalData.exitCodes);
    assert.equal(cli(['--locale',locale,'schema','project.create']).stdout,schema);
    assert.equal(cli(['--locale',locale,'--version']).stdout,version);
    const discovered=cli(['--locale',locale,'schema']);
    assert.equal(discovered.status,0);assert.equal(discovered.stderr,'');
    assert.deepEqual(discovered.json.data,discoverSchema({}),'Presentation locale must preserve every public operation schema and effects, including the twelve new operations');
    const invalid=cli(['--locale',locale,'--unknown']);
    assert.equal(invalid.stdout,bad);
    assert.equal(invalid.stderr,`VALIDATION_ERROR: ${translate(locale,'cli.error.unsupportedOption')}\n`);
  }
  for (const args of [['--locale','fr'],['--locale'],['--locale=en','--locale=ja']]) assert.equal(cli(args).status,2);
});
test('MCP offline list/instructions translate while schemas, effects and call envelopes stay exact', {timeout:180000}, async t => {
  const legacy=await mcp(t), baseline=(await legacy.request('tools/list')).result.tools as McpToolView[];
  for (const operation of Object.keys(schemas)) { const tool=baseline.find(value=>value.name===operation.replaceAll('.','_')); assert.ok(tool); assert.equal(tool.description,operationDefinition(operation).description); }
  const schemaResult=await legacy.request('tools/call',{name:'mioon_schema',arguments:{operation:'project.create'}});
  for (const locale of LOCALES) {
    const localized=await mcp(t,['--locale',locale]);
    assert.equal(localized.initialized.instructions,translate(locale,'mcp.instructions'));
    const listing=(await localized.request('tools/list')).result.tools as McpToolView[];
    assert.equal(listing.length,baseline.length);
    for (let i=0;i<listing.length;i++) {
      const {description:oldDescription,...old}=baseline[i],{description,...rest}=listing[i];
      assert.deepEqual(rest,old);
      const operation=Object.keys(schemas).find(key=>key.replaceAll('.','_')===listing[i].name);
      assert.equal(description,translate(locale,(operation?`operation.${operation}`:`mcp.${listing[i].name.slice(6)}`) as MessageKey));
    }
    const call=await localized.request('tools/call',{name:'mioon_schema',arguments:{operation:'project.create'}});
    assert.deepEqual(call.result,schemaResult.result);
    for(const operation of round2Operations){
      const described=await localized.request('tools/call',{name:'mioon_schema',arguments:{operation}});
      assert.equal(described.result.isError,false);
      assert.deepEqual(described.result.structuredContent,{ok:true,data:discoverSchema({operation})});
    }
  }
});
test('launch locale is stripped before RPC and never causes submission replay', {timeout:150000}, async t => {
  const received: unknown[] = [];
  const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received.push(JSON.parse(body));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,data:[]}));});
  await new Promise<void>(resolve => { server.listen(0,'127.0.0.1', () => resolve()); }); t.after(()=>server.close());
  const address = server.address() as import('node:net').AddressInfo;
  const env={MIOON_BASE_URL:`http://127.0.0.1:${address.port}`,MIOON_TOKEN:'synthetic-locale-test-token'};
  // Async child so the fixture server stays responsive.
  for(const locale of LOCALES) await new Promise<void>((resolve,reject)=>{
    const child=spawn(process.execPath,['apps/cli/src/index.ts','--locale',locale,'project','create','--input','{"name":"Keep 用户 日本語"}'],{cwd:root,env:{...cleanEnv(),...env},stdio:'ignore'});
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('CLI exceeded 30 seconds'));},30000);
    child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`CLI exit ${code}`));});child.on('error',reject);
  });
  assert.equal(received.length,4);
  for (const body of received) assert.deepEqual(body,{operation:'project.create',input:{name:'Keep 用户 日本語'}});
});

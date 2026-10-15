import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {schemas, operationDefinition, discoverSchema} from '@mioon/client';
import {LOCALES, catalogs, validateCatalogs, translate} from '../packages/i18n/src/index.ts';
import {presentationLocale, localizeHelp} from '../packages/i18n/src/presentation.ts';
import {operationMessages} from '../packages/i18n/src/catalogs/operations.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MIOON_')));
function cli(args, env = {}) {
  const result = spawnSync(process.execPath, ['apps/cli/src/index.mjs', ...args], {cwd:root, env:{...cleanEnv(), ...env}, encoding:'utf8', timeout:30000, maxBuffer:8*1024*1024});
  assert.ifError(result.error);
  return {...result, json:JSON.parse(result.stdout)};
}
// Minimal bounded stdio harness: no backend, server bootstrap or generation.
async function mcp(t, args = [], env = {}) {
  const child = spawn(process.execPath, ['apps/mcp/src/index.mjs', ...args], {cwd:root, env:{...cleanEnv(), ...env}, stdio:['pipe','pipe','pipe']});
  let buffer = '', next = 0; const pending = new Map();
  child.stderr.resume();
  t.after(() => { child.kill('SIGKILL'); for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('MCP closed')); } });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', bytes => { buffer += bytes; let end; while ((end=buffer.indexOf('\n'))>=0) { const line=buffer.slice(0,end); buffer=buffer.slice(end+1); if (!line) continue; const result=JSON.parse(line), entry=pending.get(result.id); if (entry) {pending.delete(result.id); clearTimeout(entry.timer); entry.resolve(result);}} });
  child.on('error', error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); });
  function request(method, params={}) { return new Promise((resolve,reject) => { const id=++next, timer=setTimeout(() => {pending.delete(id); child.kill('SIGKILL'); reject(new Error(`MCP ${method} exceeded 30 seconds`));},30000); pending.set(id,{resolve,reject,timer}); child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n'); }); }
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
test('CLI localizes only prose; default help snapshot, schema, version and error JSON stay exact', {timeout:180000}, () => {
  const original=cli(['--help']);
  assert.equal(original.status,0);
  const snapshot=JSON.parse(readFileSync(new URL('./fixtures/cli-help-legacy.json',import.meta.url),'utf8'));
  assert.deepEqual(original.json,snapshot);
  const schema=cli(['schema','project.create']).stdout;
  const version=cli(['--version']).stdout;
  const bad=cli(['--unknown']).stdout;
  for (const locale of LOCALES) {
    const help=cli(['--locale',locale,'--help']).json.data;
    assert.equal(help.options['--input'],translate(locale,'cli.option.input'));
    assert.equal(help.options['--locale'],translate(locale,'cli.option.locale'));
    assert.deepEqual(help.usage,original.json.data.usage);
    assert.deepEqual(help.operations,original.json.data.operations);
    assert.deepEqual(help.exitCodes,original.json.data.exitCodes);
    assert.equal(cli(['--locale',locale,'schema','project.create']).stdout,schema);
    assert.equal(cli(['--locale',locale,'--version']).stdout,version);
    const invalid=cli(['--locale',locale,'--unknown']);
    assert.equal(invalid.stdout,bad);
    assert.equal(invalid.stderr,`VALIDATION_ERROR: ${translate(locale,'cli.error.unsupportedOption')}\n`);
  }
  for (const args of [['--locale','fr'],['--locale'],['--locale=en','--locale=ja']]) assert.equal(cli(args).status,2);
});
test('MCP offline list/instructions translate while schemas, effects and call envelopes stay exact', {timeout:180000}, async t => {
  const legacy=await mcp(t), baseline=(await legacy.request('tools/list')).result.tools;
  for (const operation of Object.keys(schemas)) assert.equal(baseline.find(tool=>tool.name===operation.replaceAll('.','_')).description,operationDefinition(operation).description);
  const schemaResult=await legacy.request('tools/call',{name:'mioon_schema',arguments:{operation:'project.create'}});
  for (const locale of LOCALES) {
    const localized=await mcp(t,['--locale',locale]);
    assert.equal(localized.initialized.instructions,translate(locale,'mcp.instructions'));
    const listing=(await localized.request('tools/list')).result.tools;
    assert.equal(listing.length,baseline.length);
    for (let i=0;i<listing.length;i++) {
      const {description:oldDescription,...old}=baseline[i],{description,...rest}=listing[i];
      assert.deepEqual(rest,old);
      const operation=Object.keys(schemas).find(key=>key.replaceAll('.','_')===listing[i].name);
      assert.equal(description,translate(locale,operation?`operation.${operation}`:`mcp.${listing[i].name.slice(6)}`));
    }
    const call=await localized.request('tools/call',{name:'mioon_schema',arguments:{operation:'project.create'}});
    assert.deepEqual(call.result,schemaResult.result);
  }
});
test('launch locale is stripped before RPC and never causes submission replay', {timeout:150000}, async t => {
  const received=[];
  const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received.push(JSON.parse(body));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,data:[]}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const env={MIOON_BASE_URL:`http://127.0.0.1:${server.address().port}`,MIOON_TOKEN:'synthetic-locale-test-token'};
  // Async child so the fixture server stays responsive.
  for(const locale of LOCALES) await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['apps/cli/src/index.mjs','--locale',locale,'project','create','--input','{"name":"Keep 用户 日本語"}'],{cwd:root,env:{...cleanEnv(),...env},stdio:'ignore'});
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('CLI exceeded 30 seconds'));},30000);
    child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`CLI exit ${code}`));});child.on('error',reject);
  });
  assert.equal(received.length,4);
  for (const body of received) assert.deepEqual(body,{operation:'project.create',input:{name:'Keep 用户 日本語'}});
});

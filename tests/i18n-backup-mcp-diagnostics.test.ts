






import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

import {fileURLToPath} from 'node:url';
import {LOCALES, translate} from '../packages/i18n/src/index.ts';





const root = fileURLToPath(new URL('../', import.meta.url));
const secret = 'synthetic-PRIVATE-path-token-error-must-not-appear';
function run(entry: string, args: string[], hook?: string) {
  const prefix = hook ? ['--import', `data:text/javascript,${encodeURIComponent(hook)}`] : [];
  const result = spawnSync(process.execPath, [...prefix, entry, ...args], {cwd:root, encoding:'utf8', timeout:30000, maxBuffer:1024*1024, env:{...process.env, LANG:'ja_JP.UTF-8', MIOON_LOCALE:'ja'}});
  assert.ifError(result.error);
  assert.equal(result.signal,null);
  return result;
}
const mcp = (args: string[], hook?: string) => run('apps/mcp/src/index.ts', args, hook);





test('MCP launch errors retain validated locale without touching stdout or legacy diagnostics', {timeout:180000}, () => {
  for (const locale of LOCALES) {
    for (const [tail,key] of [[['--unknown',secret],'launchOptions'],[['--locale','ja'],'launchOptions'],[['--workspace-origin'],'launchOptions'],[['--workspace-origin','invalid'],'launchOptions']]) {
      const result=mcp(['--locale',locale,...tail]);
      assert.equal(result.status,2); assert.equal(result.stdout,'');
      assert.equal(result.stderr,`VALIDATION_ERROR: ${translate(locale,`mcp.error.${key}` as never, {} as never)}\n`);
      assert.ok(!result.stderr.includes(secret));
    }
  }
  for (const args of [['--unknown','--locale=ja'],['--locale','fr'],['--locale'],['--locale=zh-TW']]) {
    const result=mcp(args); assert.equal(result.status,2); assert.equal(result.stdout,'');
    assert.match(result.stderr,/^VALIDATION_ERROR: (MCP accepts only one optional --locale zh-Hans\|zh-Hant\|en\|ja at process launch\.|--locale (?:must be one of zh-Hans, zh-Hant, en, ja\.|requires an explicit value\.))\n$/);
  }
  assert.equal(mcp(['--workspace-origin','invalid']).stderr,'VALIDATION_ERROR: MCP accepts only one optional --locale zh-Hans|zh-Hant|en|ja at process launch.\n');
});

const transportFailure = `import {registerHooks} from 'node:module'; registerHooks({load(url,context,next){if(url.endsWith('/server/stdio.js'))return {format:'module',shortCircuit:true,source:${JSON.stringify(`export class StdioServerTransport {async start(){throw new Error('${secret}')}}`)}};return next(url,context);}});`;
test('MCP injected stdio startup failure is fixed safe copy in all locales, never raw exception', {timeout:90000}, () => {
  for (const locale of [undefined,...LOCALES]) {
    const result=mcp(locale?['--locale',locale]:[],transportFailure);
    assert.equal(result.status,1); assert.equal(result.stdout,'');
    assert.equal(result.stderr,`${locale?translate(locale,'mcp.error.transport'):'Mioon MCP could not start the stdio transport.'}\n`);
    assert.ok(!result.stderr.includes(secret));
  }
});

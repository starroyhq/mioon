import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {LOCALES, translate, catalogs, validateCatalogs} from '../packages/i18n/src/index.ts';
import {parseBackupArguments} from '../apps/cli/src/backup.ts';
import {backupDiagnostic} from '../apps/cli/src/backup-presentation.ts';
import {errorView} from './helpers/test-error.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
const secret = 'synthetic-PRIVATE-path-token-error-must-not-appear';
function run(entry: string, args: string[], hook?: string) {
  const prefix = hook ? ['--import', `data:text/javascript,${encodeURIComponent(hook)}`] : [];
  const result = spawnSync(process.execPath, [...prefix, entry, ...args], {cwd:root, encoding:'utf8', timeout:30000, maxBuffer:1024*1024, env:{...process.env, LANG:'ja_JP.UTF-8', MIOON_LOCALE:'ja'}});
  assert.ifError(result.error);
  assert.equal(result.signal,null);
  return result;
}
const backup = (args: string[], hook?: string) => run('apps/cli/src/backup.ts', args, hook);
const mcp = (args: string[], hook?: string) => run('apps/mcp/src/index.ts', args, hook);

test('backup explicit locale translates only help prose and preserves legacy help/version', {timeout:180000}, () => {
  assert.deepEqual(validateCatalogs(catalogs),[]);
  const original = backup(['--help']);
  assert.equal(original.stdout,readFileSync(new URL('./fixtures/backup-help-legacy.json',import.meta.url),'utf8'));
  const base = JSON.parse(original.stdout).data;
  for (const locale of LOCALES) {
    const localized = backup(['--locale',locale,'--help']);
    assert.equal(localized.status,0);
    const data=JSON.parse(localized.stdout).data;
    for (const section of ['requirements','privacy','safety']) {
      assert.equal(data[section].length,base[section].length);
      for (let i=0;i<data[section].length;i++) assert.equal(data[section][i],translate(locale,`backup.${section}.${i}` as never, {} as never));
      delete data[section];
    }
    assert.equal(data.output,translate(locale,'backup.output' as never, {} as never)); delete data.output;
    const {requirements,privacy,safety,output,...unchanged}=base;
    assert.deepEqual(data,unchanged);
    assert.equal(backup(['--version','--locale='+locale]).stdout,backup(['--version']).stdout);
    assert.deepEqual(JSON.parse(backup(['restore','--help','--locale',locale]).stdout).data.usage,[base.usage[2]]);
  }
});

test('backup parser does not forward locale; only a valid encountered locale affects safe stderr', {timeout:180000}, () => {
  for (const locale of LOCALES) {
    let captured: string | undefined;
    assert.deepEqual(parseBackupArguments(['verify','--locale',locale,'--directory','/absolute/backup'],(locale: string | undefined)=>{captured=locale;}),{command:'verify',directory:'/absolute/backup'});
    assert.equal(captured,locale);
    const invalid=backup(['--locale',locale,'--unknown',secret]);
    const legacy=backup(['--unknown',secret]);
    assert.equal(invalid.stdout,legacy.stdout);
    assert.equal(invalid.status,2);
    assert.equal(invalid.stderr,`VALIDATION_ERROR: ${translate(locale,'backup.error.VALIDATION_ERROR')}\n`);
    assert.ok(!invalid.stderr.includes(secret));
    for (const tail of [['--locale','fr'],['--locale'],['--locale=ja']]) {
      assert.equal(backup(['--locale',locale,...tail]).stderr,invalid.stderr);
    }
    const badPath=backup(['--locale',locale,'verify','--directory','relative']);
    assert.equal(badPath.stdout,backup(['verify','--directory','relative']).stdout);
    assert.equal(badPath.stderr,`WORKSPACE_BACKUP_INVALID_PATH: ${translate(locale,'backup.error.WORKSPACE_BACKUP_INVALID_PATH')}\n`);
  }
  for (const args of [['--locale','fr'],['--locale'],['--locale=zh-TW'],['--unknown','--locale=ja'],['verify','--directory','relative','--locale=ja']]) {
    const result=backup(args), error=JSON.parse(result.stdout).error;
    assert.equal(result.stderr,`${error.code}: ${error.message}\n`);
  }
});

test('MCP launch errors retain validated locale without touching stdout or legacy diagnostics', {timeout:180000}, () => {
  for (const locale of LOCALES) {
    for (const [tail,key] of [[['--unknown',secret],'launchOptions'],[['--locale','ja'],'launchOptions'],[['--workspace-origin'],'originRequired'],[['--workspace-origin','invalid'],'origin']]) {
      const result=mcp(['--locale',locale,...tail]);
      assert.equal(result.status,2); assert.equal(result.stdout,'');
      assert.equal(result.stderr,`VALIDATION_ERROR: ${translate(locale,`mcp.error.${key}` as never, {} as never)}\n`);
      assert.ok(!result.stderr.includes(secret));
    }
  }
  for (const args of [['--unknown','--locale=ja'],['--locale','fr'],['--locale'],['--locale=zh-TW']]) {
    const result=mcp(args); assert.equal(result.status,2); assert.equal(result.stdout,'');
    assert.match(result.stderr,/^VALIDATION_ERROR: (MCP accepts only one optional --workspace-origin UUID at process launch\.|--locale (?:must be one of zh-Hans, zh-Hant, en, ja\.|requires an explicit value\.))\n$/);
  }
  assert.equal(mcp(['--workspace-origin','invalid']).stderr,'VALIDATION_ERROR: Workspace origin must be an explicit UUID. Preserve the origin saved with an existing request.\n');
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

test('backup fixed code diagnostics are exhaustive and machine error, cleanup, provenance remain English', {timeout:180000}, () => {
  for(const key of Object.keys(catalogs).filter(key=>key.startsWith('backup.error.'))) {
    const code=key.slice('backup.error.'.length);
    for(const locale of LOCALES)assert.equal(backupDiagnostic(code,secret,locale),translate(locale,key as never, {} as never));
    assert.equal(backupDiagnostic(code,secret),secret);
  }
  const failure = `import {registerHooks} from 'node:module'; registerHooks({load(url,context,next){if(url.endsWith('/packages/business/src/workspace-backup.ts'))return {format:'module',shortCircuit:true,source:${JSON.stringify(`export async function verifyWorkspaceBackup(options){if(Object.hasOwn(options,'locale'))throw Error('locale leaked'); throw Object.assign(new Error('${secret}'),{code:'WORKSPACE_BACKUP_IO',cleanupUnconfirmed:true});} export const createWorkspaceBackup=verifyWorkspaceBackup;`)}};return next(url,context);}});`;
  const legacy=backup(['verify','--directory','/absolute/backup'],failure);
  assert.deepEqual(JSON.parse(legacy.stdout).error.details,{sourceLockRelease:'unconfirmed'});
  for(const locale of LOCALES) {
    const result=backup(['--locale',locale,'verify','--directory','/absolute/backup'],failure);
    assert.equal(result.status,1); assert.equal(result.stdout,legacy.stdout);
    assert.equal(result.stderr,`WORKSPACE_BACKUP_IO: ${translate(locale,'backup.error.WORKSPACE_BACKUP_IO')}\n`);
    assert.ok(!result.stdout.includes(secret)); assert.ok(!result.stderr.includes(secret));
  }
});

test('backup restored publication provenance and unknown error fallback never depend on locale', {timeout:90000}, () => {
  const publication={restorationId:'11111111-1111-4111-8111-111111111111',workspaceOrigin:'22222222-2222-4222-8222-222222222222',sourceBackupId:'33333333-3333-4333-8333-333333333333',manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64)};
  for (const code of ['WORKSPACE_RESTORE_PUBLICATION_UNCONFIRMED', 'UNTRUSTED_CODE']) {
    const source=`export async function restoreWorkspaceBackup(options){if(Object.hasOwn(options,'locale'))throw Error('locale leaked'); throw Object.assign(new Error('${secret}'),{code:'${code}',cleanupUnconfirmed:true,publication:${JSON.stringify(publication)}});} export const inspectWorkspaceRestorePublication=restoreWorkspaceBackup;`;
    const hook=`import {registerHooks} from 'node:module'; registerHooks({load(url,context,next){if(url.endsWith('/packages/business/src/workspace-restore.ts'))return {format:'module',shortCircuit:true,source:${JSON.stringify(source)}};return next(url,context);}});`;
    const args=['restore','--directory','/absolute/backup','--destination','/absolute/destination'];
    const legacy=backup(args,hook), error=JSON.parse(legacy.stdout).error;
    assert.equal(error.code,code==='UNTRUSTED_CODE'?'WORKSPACE_BACKUP_IO':code);
    assert.equal(error.details.destinationLockRelease,'unconfirmed');
    if(code!=='UNTRUSTED_CODE')assert.deepEqual(error.details.publication,{...publication,state:'unconfirmed'});
    for(const locale of LOCALES) {
      const result=backup(['--locale',locale,...args],hook);
      assert.equal(result.status,1);assert.equal(result.stdout,legacy.stdout);
      assert.equal(result.stderr,`${error.code}: ${translate(locale,`backup.error.${error.code}` as never, {} as never)}\n`);
      assert.ok(!result.stdout.includes(secret));assert.ok(!result.stderr.includes(secret));
    }
  }
});

test('locale never changes backup parser error precedence for mixed modes or malformed help', {timeout:90000}, () => {
  const uuid='11111111-1111-1111-1111-111111111111';
  const cases=[
    ['restore-status','--restoration-id',uuid,'--destination','relative','--directory','/backup'],
    ['restore-status','--backup-id',uuid,'--destination','relative','--directory','/backup'],
    ['restore-status','--destination','relative','--restoration-id',uuid,'--directory','/backup'],
    ['restore-status','--directory','/backup','--restoration-id',uuid,'--destination','relative'],
    ['create','--help','--source','relative'],
    ['create','--source','relative','--help'],
    ['verify','--help','--directory','relative'],
    ['verify','--directory','relative','--help'],
    ['verify','--unknown','relative','--directory','relative'],
    ['verify','--directory','/backup','--directory','relative'],
  ];
  const codeFor=(args: string[])=>{try{parseBackupArguments(args);assert.fail('Expected parser error');}catch(error: unknown){const failure=errorView(error);assert.ok(failure.code);return {code:failure.code,message:failure.message};}};
  for(const args of cases) for(const locale of LOCALES) {
    assert.deepEqual(codeFor(['--locale',locale,...args]),codeFor(args));
    assert.deepEqual(codeFor([...args,'--locale='+locale]),codeFor(args));
  }
  const legacy=backup(cases[0]);
  assert.equal(JSON.parse(legacy.stdout).error.code,'VALIDATION_ERROR');
  for(const locale of LOCALES)assert.equal(backup(['--locale',locale,...cases[0]]).stdout,legacy.stdout);
});

test('backup locale is rejected inside every business flag/value pair before dispatch', () => {
  const uuid='11111111-1111-1111-1111-111111111111', hash='a'.repeat(64);
  const cases=[
    ['create','--source','/source','--destination','/destination'],
    ['verify','--directory','/backup'],
    ['restore','--directory','/backup','--destination','/destination'],
    ['restore-status','--directory','/backup','--destination','/destination'],
    ['restore-status','--destination','/destination','--restoration-id',uuid,'--backup-id',uuid,'--manifest-hash',hash,'--source-db-hash',hash],
  ];
  for (const args of cases) for (const locale of LOCALES) {
    const expected=parseBackupArguments(args);
    for (const option of [['--locale',locale],['--locale='+locale]]) {
      for (let index=2;index<args.length;index+=2) {
        let captured: string | undefined;
        assert.throws(()=>parseBackupArguments([...args.slice(0,index),...option,...args.slice(index)],(locale: string | undefined)=>{captured=locale;}),{code:'VALIDATION_ERROR'});
        assert.equal(captured,undefined,'An option in a value slot cannot establish locale');
      }
      // Leading, after command, between complete pairs, and trailing remain valid.
      for (const index of [0,1,...Array.from({length:(args.length-1)/2},(_,i)=>3+i*2)]) {
        let captured: string | undefined;
        assert.deepEqual(parseBackupArguments([...args.slice(0,index),...option,...args.slice(index)],(locale: string | undefined)=>{captured=locale;}),expected);
        assert.equal(captured,locale);
      }
    }
  }
});

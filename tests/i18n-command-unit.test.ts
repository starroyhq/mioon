import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {argumentsFor} from '../apps/cli/src/arguments.ts';
import {help} from '../apps/cli/src/help.ts';
import {localizeHelp, localizeToolDescription} from '../packages/i18n/src/presentation.ts';
import {LOCALES, translate, renderMessage} from '../packages/i18n/src/index.ts';
import type {DisplayMessage, Locale, MessageKey} from '../packages/i18n/src/index.ts';
import type {ClientErrorEnvelope} from '@mioon/client';
import {VERSION, EXIT_CODES, discoverSchema, schemas, operationDefinition, successEnvelope, ClientError, errorEnvelope} from '@mioon/client';
const dependencies={VERSION, EXIT_CODES, discoverSchema, schemas};
interface ParsedCommand {words?: string[]; options?: Record<string, string | true>; locale?: Locale; json?: ClientErrorEnvelope; display?: unknown}
type HelpView = {name: string; version: string; usage: string[]; options: Record<string, string>; connection: string[]; exitCodes: Readonly<Record<string, unknown>>; safety: string; operation?: unknown; operations?: string[]};
function parse(argv: string[]): ParsedCommand {
  let locale: Locale | undefined; const errors = new WeakMap<object, DisplayMessage>();
  const fail = (text: string, key?: MessageKey, params?: Record<string, string | number>): never => { const error = new ClientError('VALIDATION_ERROR', text); errors.set(error, { key, params } as unknown as DisplayMessage); throw error; };
  try { return {...argumentsFor(argv, fail, (value: Locale | undefined) => { locale = value; }), locale}; }
  catch (error) { return { json:errorEnvelope(error as ClientError), display: locale ? renderMessage(locale, errors.get(error as object) as DisplayMessage) : (error as Error).message }; }
}
test('pure help retains exact legacy bytes and schema object content in every presentation locale',()=>{
  const original=help(undefined,dependencies);
  const frozen = readFileSync(new URL('./fixtures/cli-help-legacy.json',import.meta.url),'utf8');
  // Application versions follow the root manifest; retain the historical fixture
  // and every other legacy byte, including prose and operation ordering.
  assert.equal(frozen.split('"version":"0.4.1"').length,2);
  const expected = frozen
    .replace('"version":"0.4.1"', `"version":${JSON.stringify(VERSION)}`)
    .replace('"mioon capabilities",', '"mioon capabilities","mioon agent --help",')
    .replace('"mioon export download --input <JSON> --output <new-local-file>"', '"mioon export download --input <JSON> --output <new-local-file>","mioon project export --input <JSON> --output <new-local-file.mioon>","mioon project import --file <local-file.mioon> --request-id <id> [--input <JSON>]","mioon project duplicate --request-id <id> --input <JSON>"')
    .replace('"operations":["lut.import",', '"operations":["export.cancel","export.activity.get","export.output.get","workspace.settings.get","workspace.settings.set","workspace.backup.status","workspace.backup.list","workspace.backup.create","workspace.backup.restore.stage","task.disposition.list","task.disposition.markFailed","task.disposition.archiveCompleted","project.rename","project.delete","project.summary.list","agent.authorization.list","agent.authorization.grant","agent.authorization.revoke","lut.import",')
    .replace('"timeline.loudness.prepare",', '"timeline.loudness.prepare","timeline.clip.loudness",')
    .replace('"timeline.audioPreview.plan",', '"timeline.audioPreview.plan","timeline.audioPreview.continuousPlan",')
    .replace('"asset.disposition.set",', '"asset.disposition.set","asset.annotation.list","asset.annotation.set",')
    .replace('"provider.list",', '"provider.list","video.connection.list",')
    .replace('"timeline.clip.remove",', '"timeline.clip.remove","timeline.clip.rippleRemove",')
    .replace('"timeline.loudness.apply",', '"timeline.loudness.apply","timeline.clip.refreshSources","timeline.shots.append","timeline.clip.splitAtScenes",')
    .replace('"frame.task.recoverResult",', '"frame.task.recoverResult","scene.detect","scene.request.get","scene.task.get","scene.task.list","scene.task.cancel","scene.result.get","scene.cuts.save","scene.shots.create","scene.shots.undo",');
  assert.notEqual(expected, frozen);
  assert.equal(JSON.stringify(successEnvelope(original))+'\n', expected);
  assert.equal(localizeHelp(original),original);
  for(const locale of LOCALES){
    const localized=localizeHelp(original,locale);
    assert.deepEqual(localized.usage,original.usage);
    assert.deepEqual((localized as HelpView).operations,(original as HelpView).operations);
    assert.deepEqual(localized.exitCodes,original.exitCodes);
    assert.equal(((localized as HelpView).options)['--input'],translate(locale,'cli.option.input'));
    assert.equal(((localized as HelpView).options)['--locale'],translate(locale,'cli.option.locale'));
    const command=help('project.create',dependencies),before=structuredClone(command);
    assert.deepEqual((localizeHelp(command,locale) as HelpView).operation,discoverSchema({operation:'project.create'}));
    assert.deepEqual(command,before);
  }
  assert.equal(Object.hasOwn(original.options,'--locale'),false);
});
test('pure parser supports both locale forms and preserves input bytes and command identities',()=>{
  for(const locale of LOCALES){
    for(const flag of [['--locale',locale],[`--locale=${locale}`]]){
      const input='{"name":"Keep 用户 日本語 --locale"}';
      const result=parse([...flag,'project','create','--input',input]);
      assert.deepEqual(result,{words:['project','create'],options:{locale,input},locale});
    }
    const result=parse(['--locale',locale,'--input','--locale']);
    assert.equal((result as {options: Record<string, string | true>}).options.input,'--locale');
    assert.equal(result.locale,locale);
  }
  assert.deepEqual(parse(['project','list']),{words:['project','list'],options:{},locale:undefined});
});
test('owned parser diagnostics translate without modifying machine errors or allowing invalid launch values',()=>{
  const cases=[['--bogus'],['-x'],['--help=yes'],['--input'],['--input','{}','--input','{}']];
  for(const args of cases){
    const original=parse(args);
    for(const locale of LOCALES){
      const localized=parse(['--locale',locale,...args]);
      assert.deepEqual(localized.json,original.json);
      assert.ok(localized.display);
      if(locale!=='en')assert.notEqual(localized.display,original.display);
    }
  }
  for(const args of [['--locale','fr'],['--locale','zh-TW'],['--locale'],['--locale=ja','--locale=en']])assert.equal((parse(args).json as ClientErrorEnvelope).error.code,'VALIDATION_ERROR');
});
test('all operation descriptions translate only their presentation slot; definitions stay unchanged',()=>{
  for(const operation of Object.keys(schemas)){
    const definition=operationDefinition(operation),before=structuredClone(definition);
    assert.equal(localizeToolDescription(operation,definition.description),definition.description);
    for(const locale of LOCALES){
      assert.equal(localizeToolDescription(operation,definition.description,locale),translate(locale,`operation.${operation}` as MessageKey));
      assert.deepEqual(definition,before);
    }
  }
  for(const locale of LOCALES)assert.throws(()=>localizeToolDescription('missing.public.operation','original machine description',locale),/Unknown presentation message key/,'Missing operation prose must fail explicitly rather than silently fall back');
});

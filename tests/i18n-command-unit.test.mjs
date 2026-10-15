import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {argumentsFor} from '../apps/cli/src/arguments.ts';
import {help} from '../apps/cli/src/help.ts';
import {localizeHelp, localizeToolDescription} from '../packages/i18n/src/presentation.ts';
import {LOCALES, translate, renderMessage} from '../packages/i18n/src/index.ts';
import {VERSION, EXIT_CODES, discoverSchema, schemas, operationDefinition, successEnvelope, ClientError, errorEnvelope} from '@mioon/client';
const dependencies={VERSION, EXIT_CODES, discoverSchema, schemas};
function parse(argv) {
  let locale; const errors=new WeakMap();
  const fail=(text,key,params)=>{const error=new ClientError('VALIDATION_ERROR',text);errors.set(error,{key,params});throw error;};
  try { return {...argumentsFor(argv,fail,value=>{locale=value;}),locale}; }
  catch(error) { return {json:errorEnvelope(error), display:locale ? renderMessage(locale,errors.get(error)) : error.message}; }
}
test('pure help retains exact legacy bytes and schema object content in every presentation locale',()=>{
  const original=help(undefined,dependencies);
  const frozen = readFileSync(new URL('./fixtures/cli-help-legacy.json',import.meta.url),'utf8');
  // Only V2 discovery is added; retain the frozen legacy bytes and ordering.
  const expected = frozen.replace('"timeline.audioPreview.plan",', '"timeline.audioPreview.plan","timeline.audioPreview.continuousPlan",');
  assert.notEqual(expected, frozen);
  assert.equal(JSON.stringify(successEnvelope(original))+'\n', expected);
  assert.equal(localizeHelp(original),original);
  for(const locale of LOCALES){
    const localized=localizeHelp(original,locale);
    assert.deepEqual(localized.usage,original.usage);
    assert.deepEqual(localized.operations,original.operations);
    assert.deepEqual(localized.exitCodes,original.exitCodes);
    assert.equal(localized.options['--input'],translate(locale,'cli.option.input'));
    assert.equal(localized.options['--locale'],translate(locale,'cli.option.locale'));
    const command=help('project.create',dependencies),before=structuredClone(command);
    assert.deepEqual(localizeHelp(command,locale).operation,discoverSchema({operation:'project.create'}));
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
    assert.equal(result.options.input,'--locale');
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
  for(const args of [['--locale','fr'],['--locale','zh-TW'],['--locale'],['--locale=ja','--locale=en']])assert.equal(parse(args).json.error.code,'VALIDATION_ERROR');
});
test('all operation descriptions translate only their presentation slot; definitions stay unchanged',()=>{
  for(const operation of Object.keys(schemas)){
    const definition=operationDefinition(operation),before=structuredClone(definition);
    assert.equal(localizeToolDescription(operation,definition.description),definition.description);
    for(const locale of LOCALES){
      assert.equal(localizeToolDescription(operation,definition.description,locale),translate(locale,`operation.${operation}`));
      assert.deepEqual(definition,before);
    }
  }
});

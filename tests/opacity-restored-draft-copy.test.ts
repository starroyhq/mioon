import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {LOCALES, translate, validateCatalogs} from '../packages/i18n/src/index.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
type HtmlEscapeKey = '&'|'<'|'>'|'"'|"'";
const escapeHtml = (value: string) => value.replace(/[&<>"']/gu, (char) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;'}[char as HtmlEscapeKey]));
const copy = (locale: string, key: string, ...args: [options?: {time:string}]) => escapeHtml((translate as (locale:Parameters<typeof translate>[0],key:Parameters<typeof translate>[1],options?:{time:string})=>string)((locale as unknown as Parameters<typeof translate>[0]), (key as unknown as Parameters<typeof translate>[1]), ...(((args!)))));
const button = (html: string, id: string) => html.match(new RegExp(`<button\\b[^>]*data-testid="${id}"[^>]*>`))?.[0];
let rendered: Record<string,Record<string,string>>|undefined;

/** Actual components and providers, synthetic display states only. This does
 * not exercise native GUI, storage, a listener, media or timeline execution. */
function renderCopies() {
  if (rendered) return rendered;
  const fixture = `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server.browser';
    import ClipDraftRecovery from './src/ClipDraftRecovery.tsx';import OpacityRestoredNotice from './src/OpacityRestoredNotice.tsx';
    import {I18nProvider} from './src/i18n/I18nProvider.tsx';import {ConfirmationProvider} from '@mioon/ui/components/workbench-confirm';
    import {message} from '../../packages/i18n/src/index.ts';
    const noop=()=>{}, forbidden=()=>{throw Error('Disclosure rendering must not restore, discard or execute input');};
    const controller={capture:forbidden,restore:forbidden,discardStored:forbidden,load:forbidden,abandonCurrentInput:forbidden,canAbandon:()=>true};
    const raw={name:'Synthetic clip',trackId:'00000000-0000-4000-8000-000000000001',startFrame:'0',durationFrames:'10',sourceInFrame:'0',gain:'1',rect:{x:'0',y:'0',width:'64',height:'64'},opacityEnvelope:{profileId:'mioon-clip-linear-opacity-v1',points:[{frame:'0',opacity:'.'}]}};
    const source={assetId:'00000000-0000-4000-8000-000000000002',assetSha256:'a'.repeat(64)};
    const state={raw,source,baseRevision:3,dirty:false,conflict:false,phase:'ready',error:'',candidate:null,savedAt:null,submitting:false,businessPending:false,compositionPending:false,autosavePaused:false,failure:null,retainedRecord:false};
    const candidate={raw,source,baseRevision:3,updatedAt:'2026-10-16T00:00:00.000Z'};
    const unknown={...state,dirty:true,phase:'error',error:'Synthetic unknown acknowledgement',autosavePaused:true,retainedRecord:true,failure:{code:'LOCAL_DRAFT_PROTOCOL_UNKNOWN',kind:'unknown',status:null}};
    const recovery=(next,extra={})=><ClipDraftRecovery state={next} controller={controller} pending={false} restoredPersistence {...extra}/>;
    const components={noticeDefault:<OpacityRestoredNotice/>,noticeMemory:<OpacityRestoredNotice draftsPersistent={false}/>,noticePersistent:<OpacityRestoredNotice draftsPersistent/>,
      ready:recovery(state),candidate:recovery({...state,candidate}),dirtyCandidate:recovery({...state,candidate,dirty:true}),
      candidatePending:recovery({...state,candidate},{pending:true}),candidateComposing:recovery({...state,candidate,compositionPending:true}),
      saved:recovery({...state,phase:'saved',dirty:true}),unknown:recovery(unknown),unknownDescriptor:recovery({...unknown,errorDisplay:message('recovery.notice.protocol')}),
      old43:recovery({...state,phase:'unsupported'},{memoryOnly:true,restoredPersistence:false}),ordinary42:recovery(state,{restoredPersistence:false})};
    export const html=Object.fromEntries(['zh-Hans','zh-Hant','en','ja'].map(locale=>{
      const snapshot={locale,preference:locale,persistence:'session',saving:false,ready:true},store={subscribe:()=>noop,getSnapshot:()=>snapshot,connect:()=>noop,setPreference:async()=>{}};
      return [locale,Object.fromEntries(Object.entries(components).map(([name,component])=>[name,renderToStaticMarkup(<I18nProvider store={store}><ConfirmationProvider>{component}</ConfirmationProvider></I18nProvider>)]))];
    }));`;
  const script = `import {build} from 'esbuild';globalThis.fetch=()=>{throw Error('SSR must not fetch');};
    const {outputFiles}=await build({stdin:{contents:${JSON.stringify(fixture)},loader:'tsx',resolveDir:${JSON.stringify(path.join(root, 'apps/web'))}},bundle:true,format:'esm',platform:'browser',write:false,loader:{'.css':'empty'},jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
    const result=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64')).catch(error=>{process.stderr.write(error.stack.replace(/data:text\\/javascript;base64,[A-Za-z0-9+/=]+/g,'<bundle>'));process.exit(1);});
    await new Promise(resolve=>process.stdout.write(JSON.stringify(result.html),resolve));process.exit(0);`;
  rendered = JSON.parse((execFileSync(process.execPath, ['--input-type=module'], {cwd: root, input: script, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024}) as string));
  return rendered;
}

test('restored43 draft disclosure has complete simplified Chinese, region-neutral traditional Chinese, English and Japanese catalogs', () => {
  assert.deepEqual(LOCALES, ['zh-Hans', 'zh-Hant', 'en', 'ja']);
  assert.deepEqual(validateCatalogs(), []);
  for (const locale of LOCALES) for (const key of ['sourceDrafts', 'draftsPersistent', 'draftDisclosure', 'draftStorage', 'draftUnavailable'] as const) {
    const text = translate(locale, `opacity.restored.${key}`);
    assert.ok(text.length > 0);assert.notEqual(text, `opacity.restored.${key}`);
  }
});

test('actual restored notice separates source42 exclusions from new43 storage and preserves the default memory fallback in all four locales', () => {
  for (const locale of LOCALES) {
    const html = renderCopies()![locale];
    assert.equal(html.noticeDefault, html.noticeMemory);
    assert.ok(html.noticeMemory.includes(copy(locale, 'opacity.restored.drafts')));
    assert.doesNotMatch(html.noticeMemory, /data-testid="opacity-restored-draft-storage"/u);
    const sourcePolicy = html.noticePersistent.match(/<p data-testid="opacity-restored-draft-policy">(.*?)<\/p>/u)?.[1];
    assert.equal(sourcePolicy, copy(locale, 'opacity.restored.sourceDrafts'));
    assert.ok(html.noticePersistent.includes(copy(locale, 'opacity.restored.draftsPersistent')));
    assert.match(html.noticePersistent, /data-testid="opacity-restored-draft-storage"/u);
    assert.match(html.noticePersistent, /local-drafts-restored43-v1\.json/u);
    assert.ok(!html.noticePersistent.includes(copy(locale, 'opacity.restored.drafts')));
    assert.ok(html.noticePersistent.includes(copy(locale, 'opacity.restored.view')));
  }
});

test('actual persistent recovery explains origin, confirmation and explicit timeline saving without the old memory-only claim in all four locales', () => {
  for (const locale of LOCALES) {
    const html = renderCopies()![locale].ready;
    for (const key of ['opacity.restored.draftDisclosure', 'opacity.restored.draftStorage', 'recovery.storage.clipCapacity', 'recovery.storage.clipDiscard'] as const) assert.ok(html.includes(copy(locale, key)));
    for (const key of ['opacity.restored.currentDraft', 'opacity.restored.drafts', 'recovery.clip.shortDisclosure', 'recovery.clip.unsupported', 'recovery.storage.clipBackup'] as const) assert.ok(!html.includes(copy(locale, key)));
    assert.match(html, /data-testid="clip-draft-disclosure"/u);
    assert.equal(button(html, 'restore-clip-draft'), undefined);
    assert.equal(button(html, 'discard-stored-clip-draft'), undefined);
  }
});

test('actual restored candidate offers explicit restore and discard while protecting newer, pending and composing input in all four locales', () => {
  for (const locale of LOCALES) {
    const html = renderCopies()![locale];
    assert.ok(html.candidate.includes(copy(locale, 'recovery.clip.candidate', {time: ''})));
    for (const key of ['recovery.clip.restore', 'recovery.clip.discard'] as const) assert.ok(html.candidate.includes(copy(locale, key)));
    assert.doesNotMatch((button(html.candidate, 'restore-clip-draft') as unknown as Parameters<typeof assert.doesNotMatch>[0]), /\bdisabled=/u);
    assert.doesNotMatch((button(html.candidate, 'discard-stored-clip-draft') as unknown as Parameters<typeof assert.doesNotMatch>[0]), /\bdisabled=/u);
    assert.match((button(html.dirtyCandidate, 'restore-clip-draft') as unknown as Parameters<typeof assert.match>[0]), /\bdisabled=/u);
    assert.doesNotMatch((button(html.dirtyCandidate, 'discard-stored-clip-draft') as unknown as Parameters<typeof assert.doesNotMatch>[0]), /\bdisabled=/u);
    assert.ok(html.dirtyCandidate.includes(copy(locale, 'recovery.clip.newInput')));
    for (const name of ['candidatePending', 'candidateComposing'] as const) for (const id of ['restore-clip-draft', 'discard-stored-clip-draft'] as const) assert.match((button(html[name], id) as unknown as Parameters<typeof assert.match>[0]), /\bdisabled=/u);
  }
});

test('unknown restored draft outcomes retain accurate persistence disclosure and offer read-only recheck in all four locales', () => {
  for (const locale of LOCALES) {
    const html = renderCopies()![locale];
    assert.ok(html.unknown.includes(copy(locale, 'opacity.restored.draftUnavailable')));
    for (const name of ['unknown', 'unknownDescriptor'] as const) {
      for (const key of ['recovery.clip.paused', 'recovery.clip.unknown', 'recovery.clip.recheckOnly', 'opacity.restored.draftDisclosure', 'opacity.restored.draftStorage'] as const) assert.ok(html[name].includes(copy(locale, key)));
      assert.ok(!html[name].includes(copy(locale, 'opacity.restored.currentDraft')));
      assert.ok(!html[name].includes(copy(locale, 'opacity.restored.drafts')));
      assert.ok(!html[name].includes(copy(locale, 'recovery.clip.saved', {time: ''})));
      assert.match(html[name], /role="alert"/u);
      assert.ok(button(html[name], 'reload-clip-draft'));
    }
    assert.ok(html.unknownDescriptor.includes(copy(locale, 'recovery.notice.protocol')));
  }
});

test('confirmed draft status still discloses explicit timeline saving and excludes the old restored memory fallback in all four locales', () => {
  for (const locale of LOCALES) {
    const html = renderCopies()![locale].saved;
    assert.ok(html.includes(copy(locale, 'recovery.clip.saved', {time: ''})));
    assert.ok(html.includes(copy(locale, 'opacity.restored.draftDisclosure')));
    assert.ok(!html.includes(copy(locale, 'opacity.restored.currentDraft')));
    assert.ok(!html.includes(copy(locale, 'opacity.restored.draftUnavailable')));
  }
});

test('old restored43 memory-only fallback and ordinary42 storage disclosure remain distinct in all four locales', () => {
  for (const locale of LOCALES) {
    const html = renderCopies()![locale];
    assert.ok(html.old43.includes(copy(locale, 'opacity.restored.currentDraft')));
    assert.ok(html.old43.includes(copy(locale, 'recovery.clip.unsupported')));
    assert.doesNotMatch(html.old43, /data-testid="clip-draft-disclosure"|data-testid="restore-clip-draft"|data-testid="discard-stored-clip-draft"/u);
    assert.ok(!html.old43.includes(copy(locale, 'opacity.restored.draftDisclosure')));
    assert.ok(html.ordinary42.includes(copy(locale, 'recovery.clip.shortDisclosure')));
    assert.ok(html.ordinary42.includes(copy(locale, 'recovery.storage.clipBackup')));
    assert.match(html.ordinary42, /data-testid="clip-draft-disclosure"/u);
    assert.ok(!html.ordinary42.includes(copy(locale, 'opacity.restored.draftDisclosure')));
    assert.ok(!html.ordinary42.includes(copy(locale, 'opacity.restored.draftStorage')));
  }
});

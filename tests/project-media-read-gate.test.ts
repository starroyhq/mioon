import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {build} from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = join(root, 'tests/fixtures/project-file-ui');
const code = `
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ProjectMediaProvider,ProjectMediaImage} from './src/project-media-read-gate.tsx';
import {createProjectMediaController} from './src/project-media-state.ts';
import {Media} from './src/Nodes.tsx';
import {SubjectImage} from './src/SubjectLibrary.tsx';
import {VideoFrameSummary} from './src/VideoFrameControls.tsx';
import SubjectVideoSummary from './src/SubjectVideoSummary.tsx';
import {ComparisonVideo} from './src/VersionComparison.tsx';
import Preview from './src/Preview.tsx';
import {MediaRelinkDialog} from './src/project-file/MediaRelinkDialog.tsx';
import {OutsideLocationsDialog} from './src/project-file/OutsideLocationsDialog.tsx';
const id = n => '00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const projectId=id(900), url='/api/projects/'+projectId+'/media/'+id(1);
const asset={id:id(1),projectId,name:'synthetic.png',mimeType:'image/png',referenceRevision:1,sha256:'a'.repeat(64)};
const version={id:id(2),assetId:id(1),projectId,subjectId:id(3),number:1,sha256:asset.sha256,width:16,height:16,mimeType:'image/png'};
const noop=()=>{};
const controller=createProjectMediaController({readOwner:()=>null,readAssets:()=>[]});
export function render(kind,readable=false,status='unconfirmed-found') {
 const media={controller,state:controller.getState(),statusFor:()=>status==='missing'?{kind:status,reason:'not-found'}:{kind:status},canRead:value=>readable&&Boolean(value&&value.id===asset.id&&(!value.projectId||value.projectId===projectId)&&(!value.referenceRevision||value.referenceRevision===1))};
 let child;
 if(kind==='image')child=<Media asset={asset}/>;
 if(kind==='video')child=<Media asset={{...asset,mimeType:'video/mp4'}}/>;
 if(kind==='audio')child=<Media asset={{...asset,mimeType:'audio/wav'}} controls/>;
 if(kind==='version')child=<Media asset={asset} version={{id:id(3),projectId,assetId:id(99)}}/>;
 if(kind==='subject')child=<SubjectImage version={version} assets={[asset]}/>;
 if(kind==='summary')child=<VideoFrameSummary shot={{referenceAssetIds:[asset.id]}} assets={[asset]}/>;
 if(kind==='subject-summary')child=<SubjectVideoSummary reference={{subjectName:'synthetic subject',subjectKind:'character',subjectVersionId:version.id,subjectVersion:version}} assets={[asset]}/>;
 if(kind==='comparison')child=<ComparisonVideo binding={{projectId,assetId:asset.id,url,key:'synthetic-binding'}} label="synthetic" register={noop} onPlay={noop} onError={noop}/>;
 if(kind==='foreign-comparison')child=<ComparisonVideo binding={{projectId:id(999),assetId:asset.id,url,key:'synthetic-binding'}} label="synthetic" register={noop} onPlay={noop} onError={noop}/>;
 if(kind==='preview')child=<Preview kind="source" asset={asset} onKind={noop} playhead={0} onSeek={noop} onRender={noop}/>;
 if(kind==='unknown')child=<ProjectMediaImage asset={{id:id(99),projectId}} src={url} alt="unknown"/>;
 return renderToStaticMarkup(<ProjectMediaProvider media={media}>{child}</ProjectMediaProvider>);
}
export function relink(capability,selected=false) {
 return renderToStaticMarkup(<MediaRelinkDialog open projectName="synthetic" state={{kind:'ready',value:{rows:[{assetId:asset.id,name:asset.name,mediaKind:'image',from:'/real/original.png',to:null,outcome:'changed'}],foundBy:null}}} apply={{kind:'idle'}}
   {...(capability?{onChooseFile:noop}: {})} onUseNewFile={noop} changedSelected={selected?[asset.id]:[]} canApply={selected} onApply={noop} onRetry={noop} onClose={noop}/>);
}
export function outside() {return renderToStaticMarkup(<OutsideLocationsDialog open projectName="synthetic" fromAnotherComputer={false} state={{kind:'ready',value:[{directory:'/offline',volume:null,assetCount:1,available:false}]}} rulesUntrusted action={{kind:'idle'}} onOpenOnly={noop} onAllow={noop} onRetry={noop} onClose={noop}/>);}
`;
const built = await build({stdin: {contents: code, loader: 'tsx', resolveDir: join(root, 'apps/web')}, bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', loader: {'.css': 'empty'}, define: {'process.env.NODE_ENV': '"production"'}, nodePaths: [join(root, 'apps/web/node_modules')], plugins: [{name: 'media-read-gate-ssr', setup(builder) {
  builder.onResolve({filter: /^@mioon\/ui\/components\/(?:dialog|dropdown-menu)$/}, () => ({path: join(fixtures, 'ssr-overlays.tsx')}));
  builder.onResolve({filter: /\/i18n\/I18nProvider\.tsx$/}, () => ({path: join(fixtures, 'ssr-i18n.tsx')}));
}}]});
const module = {exports: {} as {render(kind: string, readable?: boolean, status?: string): string; relink(capability: boolean, selected?: boolean): string; outside(): string}};
Function('require', 'module', 'exports', built.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
const ui = module.exports;
const button = (markup: string, testId: string): string => new RegExp(`<button\\b(?=[^>]*data-testid="${testId}")[^>]*>`, 'u').exec(markup)?.[0] ?? '';

test('all concrete media readers omit image/video/audio sources while permission or availability is unknown', () => {
  for (const kind of ['image', 'video', 'audio', 'subject', 'summary', 'subject-summary', 'comparison', 'preview']) for (const status of ['checking', 'check-failed', 'missing', 'changed', 'unconfirmed-found', 'unconfirmed-maybe-changed']) {
    const markup = ui.render(kind, false, status);
    assert.doesNotMatch(markup, /<(?:img|video|audio)\b[^>]*\bsrc=/u, `${kind}/${status}`);
    assert.match(markup, new RegExp(`data-media-status="${status}"`, 'u'), `${kind}/${status}`);
  }
});

test('online current media renders content; a different version/foreign project/unknown ID cannot borrow its authority', () => {
  for (const kind of ['image', 'video', 'audio', 'subject', 'summary', 'subject-summary', 'comparison', 'preview']) assert.match(ui.render(kind, true, 'online'), /<(?:img|video|audio)\b[^>]*\bsrc=/u, kind);
  for (const kind of ['version', 'foreign-comparison', 'unknown']) assert.doesNotMatch(ui.render(kind, true), /<(?:img|video|audio)\b[^>]*\bsrc=/u, kind);
});

test('a missing chooser removes its action, and a changed-only staged selection enables explicit apply', () => {
  assert.doesNotMatch(ui.relink(false), /data-testid="pf-relink-choose-/u);
  assert.match(ui.relink(true), /data-testid="pf-relink-choose-/u);
  assert.match(button(ui.relink(false), 'pf-relink-apply'), /\sdisabled=""/u);
  assert.doesNotMatch(button(ui.relink(false, true), 'pf-relink-apply'), /\sdisabled=""/u);
  assert.match(ui.relink(false, true), /aria-pressed="true"/u);
  assert.match(ui.relink(false, true), /将添加为新素材/u);
});

test('an unavailable outside directory cannot be granted; the real independent rules note makes no trust grant', () => {
  const markup = ui.outside();
  assert.match(button(markup, 'pf-outside-allow'), /\sdisabled=""/u);
  assert.match(markup, /尚未在此设备启用/u);
  assert.doesNotMatch(markup, /data-testid="pf-outside-enable-rules"/u);
});

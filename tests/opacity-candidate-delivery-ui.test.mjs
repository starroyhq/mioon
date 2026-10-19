import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createOpacityRenderSnapshotPlan} from '../packages/contracts/src/timeline-opacity-render-candidate.ts';
import {resolveTimelineExportDelivery, TIMELINE_EXPORT_DEFAULT_SETTINGS} from '@mioon/contracts';
import {row, id, projectId} from './helpers/export-sample-peak-ui-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function candidate(purpose = 'export', fields = {}) {
  const result = row(10, fields);result.purpose = purpose;
  result.snapshot.timeline.clips[0].opacityEnvelope = {profileId: 'mioon-clip-linear-opacity-v1', points: [{frame: 0, opacity: 0}, {frame: 60, opacity: 1}]};
  result.snapshot.opacityPlan = createOpacityRenderSnapshotPlan(result.snapshot, purpose);
  return result;
}
let rendered;
before(() => {
  const exported = candidate(), preview = candidate('preview');
  const named = candidate('export', {deliveryName: 'Frozen title', exportRange: {startFrame: 12, endFrame: 30}});
  named.snapshot.delivery = resolveTimelineExportDelivery(named.snapshot.timeline, TIMELINE_EXPORT_DEFAULT_SETTINGS);
  const invalid = structuredClone(exported);invalid.snapshot.opacityPlan.clips[0].assetSha256 = 'b'.repeat(64);
  const fakeUrl = {...exported, url: 'https://attacker.invalid/output'};
  const fixtures = {exported, preview, named, invalid, fakeUrl};
  const fixture = `import React from 'react';
    import {renderToStaticMarkup} from 'react-dom/server.browser';
    import Preview from './src/Preview.tsx';
    import ExportHistoryList from './src/ExportHistoryList.tsx';
    import ExportPreview from './src/ExportPreview.tsx';
    import {createOpacityCandidateApplication, readOpacityCandidateApplication} from './src/opacity-candidate-application.ts';
    import * as contracts from '@mioon/contracts';
    import {rpc} from './src/api.ts';
    import {createEditTaskClient} from './src/edit-task-client.ts';
    import {exportPreviewResult} from './src/export-preview-state.ts';
    const f = ${JSON.stringify(fixtures)}, projectId = ${JSON.stringify(projectId)};
    const token = createOpacityCandidateApplication({...contracts,rpc,createEditTaskClient}, () => {throw Error('presentation must not fetch');});
    const app = readOpacityCandidateApplication(token);
    const noop = () => {};
    function main(job, patch={}) {return renderToStaticMarkup(<Preview kind="timeline" visible timeline={f.exported.snapshot.timeline} job={job} playhead={0} onSeek={noop} onRender={noop} opacityApplication={token} candidateConnected {...patch}/>);}
    function history(item, patch={}) {return renderToStaticMarkup(<ExportHistoryList orderedExports={[item]} projectId={projectId} projectName="Current project" timelineRevision={20} opacityApplication={token} candidateConnected {...patch}/>);}
    const input = {projectId, requestId: f.named.requestId, expectedRevision: f.named.timelineRevision, purpose:'export', exportSettings:f.named.snapshot.delivery.exportSettings, deliveryName:f.named.snapshot.deliveryName, exportRange:f.named.snapshot.exportRange};
    const attempt = {scope:'workspace:project:epoch', timelineId:f.named.snapshot.timeline.id, contextKey:'frozen', input, exportId:f.named.id, submitting:false, receipt:f.named};
    const context = {scope:attempt.scope, contextKey:'frozen', connected:true, isRenderRecord:app.isTimelineRenderRecord};
    const result = exportPreviewResult(attempt,[f.named],context);
    export const html = {
      preview:main(f.preview), exported:main(f.exported), held:main(f.exported,{heldExportIds:[f.exported.id]}), disconnected:main(f.exported,{candidateConnected:false}),
      invalid:main(f.invalid), fakeUrl:main(f.fakeUrl), foreign:main(f.exported,{timeline:{...f.exported.snapshot.timeline,projectId:${JSON.stringify(id(99))}}}),
      wrongTimeline:main(f.exported,{timeline:{...f.exported.snapshot.timeline,id:${JSON.stringify(id(98))}}}),
      copiedToken:main(f.exported,{opacityApplication:{...token}}), decodedToken:main(f.exported,{opacityApplication:JSON.parse(JSON.stringify(token))}),
      default:main({...f.exported,url:'/media/legacy-default'},{opacityApplication:null}),
      candidateEmpty:main(null,{kind:'source',timeline:{...f.exported.snapshot.timeline,clips:[]},onImport:noop}),
      ordinaryEmpty:main(null,{kind:'source',opacityApplication:null,onCanvas:noop,onImport:noop}),
      missingCanvas:main(null,{kind:'source',opacityApplication:null,onImport:noop}),
      invalidCanvas:main(null,{kind:'source',opacityApplication:null,onCanvas:true,onImport:noop}),
      unnamedHistory:history(f.exported), namedHistory:history(f.named), heldUnnamed:history(f.exported,{heldExportIds:[f.exported.id]}),
      heldNamed:history(f.named,{heldExportIds:[f.named.id]}), disconnectedHistory:history(f.named,{candidateConnected:false}), invalidHistory:history(f.invalid), foreignHistory:history(f.exported,{projectId:${JSON.stringify(id(99))}}),
      previewHistory:history(f.preview), copiedHistory:history(f.named,{opacityApplication:{...token}}),
      sample:renderToStaticMarkup(<ExportPreview result={result} visible canSelect={false} canGenerate={false} onSelect={noop} onGenerate={noop} onBeforePlay={noop} onRegisterMediaPause={()=>noop} rangeDraft={null} onRangeChange={noop} preflightState={null} canCheck={false} onCheck={noop}/>),
    };
    export const state = {url:result.url, held:exportPreviewResult(attempt,[f.named],{...context,heldExportIds:[f.named.id]}).url,
      disconnected:exportPreviewResult(attempt,[f.named],{...context,connected:false}).url,
      stale:exportPreviewResult(attempt,[f.named],{...context,contextKey:'changed'}).url,
      duplicate:exportPreviewResult(attempt,[f.named,f.named],context).url,
      malformed:exportPreviewResult(attempt,[{...f.named,snapshot:f.invalid.snapshot}],context).url};`;
  const script = `import {build} from 'esbuild';
    globalThis.fetch = () => {throw Error('presentation must never fetch');};
    const {outputFiles} = await build({stdin:{contents:${JSON.stringify(fixture)},loader:'jsx',resolveDir:${JSON.stringify(path.join(root,'apps/web'))}},bundle:true,format:'esm',platform:'browser',write:false,loader:{'.css':'empty'},jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
    const result = await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64')).catch(error=>{process.stderr.write(error.stack.replace(/data:text\\/javascript;base64,[A-Za-z0-9+/=]+/g,'<bundle>'));process.exit(1);});
    await new Promise(resolve=>process.stdout.write(JSON.stringify({html:result.html,state:result.state}),resolve));process.exit(0);`;
  rendered = JSON.parse(execFileSync(process.execPath,['--input-type=module'],{cwd:root,input:script,encoding:'utf8',timeout:30000}));
});

test('real shared Preview plays candidate preview and export through exact managed identity URLs', () => {
  for (const html of [rendered.html.preview, rendered.html.exported]) {
    assert.match(html, /data-testid="timeline-preview-video"/);
    assert.ok(html.includes(`src="/media/${id(110)}?preview=1&amp;exportId=${id(10)}"`));
    assert.doesNotMatch(html, /opacityPlan|opacityEnvelope|attacker/);
  }
  assert.match(rendered.html.default, /src="\/media\/legacy-default"/, 'unselected production presentation preserves its existing URL');
});
test('real empty Preview only offers canvas navigation when an actionable callback exists', () => {
  assert.match(rendered.html.ordinaryEmpty, /返回画板/);
  for (const name of ['candidateEmpty','missingCanvas','invalidCanvas']) {
    assert.doesNotMatch(rendered.html[name], /返回画板/, name);
    assert.match(rendered.html[name], /导入/, 'Import remains available in the empty state');
  }
});
test('candidate Preview removes player for held, invalid, foreign and counterfeit application bindings', () => {
  for (const name of ['held','disconnected','invalid','fakeUrl','foreign','wrongTimeline','copiedToken','decodedToken'])
    assert.doesNotMatch(rendered.html[name], /timeline-preview-video|<video|attacker/, name);
});
test('candidate named and unnamed downloads keep frozen metadata and use receipt query identities', () => {
  for (const name of ['unnamedHistory','namedHistory']) {
    assert.match(rendered.html[name], /data-testid="download-export"/);
    assert.ok(rendered.html[name].includes(`href="/media/${id(110)}?download=1&amp;exportId=${id(10)}"`));
  }
  assert.match(rendered.html.namedHistory, /Frozen title/);assert.match(rendered.html.namedHistory, /720 × 1280/);
  assert.match(rendered.html.namedHistory, /12/);assert.match(rendered.html.namedHistory, /30/);
});
test('candidate history never gives held, malformed, foreign or preview-only rows a download', () => {
  for (const name of ['heldUnnamed','heldNamed','disconnectedHistory','invalidHistory','foreignHistory','previewHistory','copiedHistory'])
    assert.doesNotMatch(rendered.html[name], /download-export|href=/, name);
  for (const name of ['invalidHistory','foreignHistory','copiedHistory']) assert.match(rendered.html[name], /candidate-delivery-invalid/);
});
test('real sample player consumes fixed candidate ACK validator and keeps all existing attempt fences', () => {
  assert.equal(rendered.state.url, `/media/${id(110)}?preview=1&exportId=${id(10)}`);
  assert.match(rendered.html.sample, /data-testid="export-preview-player"/);
  for (const name of ['held','disconnected','stale','duplicate','malformed']) assert.equal(rendered.state[name], null, name);
});

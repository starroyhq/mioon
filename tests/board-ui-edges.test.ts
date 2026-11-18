import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {build} from 'esbuild';
import type {ChainNodeKind, ChainReferenceRole} from '../packages/contracts/src/board-sequence.ts';
import type {BoardPortEndpoint} from '../apps/web/src/board-ui/connection-ports.ts';
import {LOCALES, translate} from '../packages/i18n/src/index.ts';
import type {Locale} from '../packages/i18n/src/index.ts';

interface Scenes {
  edge(kind: 'sequence'|'reference', locale: Locale, role?: ChainReferenceRole, reduced?: boolean, layout?: 'turn'|'straight'|'folded'): string;
  ports(locale: Locale, drag?: BoardPortEndpoint, disabled?: boolean): string;
}
const root = fileURLToPath(new URL('../', import.meta.url));
let scenes: Promise<Scenes> | undefined;
function fixture(): Promise<Scenes> {
  return scenes ??= (async () => {
    const entry = `import React from 'react';
      import {renderToStaticMarkup} from 'react-dom/server';
      import {ReactFlow, ReactFlowProvider, Position} from '@xyflow/react';
      import {I18nProvider,createLanguageStore} from './src/i18n/I18nProvider.tsx';
      import {SequenceEdgeView,ReferenceEdgeView} from './src/board-ui/BoardEdges.tsx';
      import {BoardPorts} from './src/board-ui/BoardPorts.tsx';
      const props={id:'test-edge',source:'a',target:'b',sourceX:10,sourceY:20,targetX:300,targetY:150,
        sourcePosition:Position.Right,targetPosition:Position.Left,selectable:true,deletable:true,selected:false};
      const language=(locale,children)=><I18nProvider store={createLanguageStore({systemLanguages:[locale]})}>{children}</I18nProvider>;
      export function edge(kind,locale,role='first_frame',reduced=false,layout='turn'){
        const coords=layout==='folded' ? {sourceX:500,sourceY:100,targetX:100,targetY:360}
          : layout==='straight' ? {sourceX:10,sourceY:20,targetX:300,targetY:20} : {};
        return renderToStaticMarkup(language(locale,<svg>{kind==='sequence'
          ? <SequenceEdgeView {...props} {...coords} markerEnd="forbidden-arrow" data={{reduceMotion:reduced}}/>
          : <ReferenceEdgeView {...props} {...coords} markerEnd="forbidden-arrow" data={{role,reduceMotion:reduced}}/>}</svg>));
      }
      export function ports(locale,drag,disabled=false){
        const kinds=['film','shot','image','video','audio','subject','previs','text'];
        const nodes=kinds.map((kind,index)=>({id:kind,type:'ports',position:{x:index*100,y:100},width:80,height:80,data:{kind}}));
        const nodeTypes={ports:({id,data})=><div><BoardPorts nodeId={id} kind={data.kind} drag={drag} isConnectable={!disabled}/></div>};
        return renderToStaticMarkup(language(locale,<ReactFlowProvider initialNodes={nodes} initialWidth={1000} initialHeight={500}>
          <ReactFlow width={1000} height={500} nodes={nodes} edges={[]} nodeTypes={nodeTypes}/>
        </ReactFlowProvider>));
      }`;
    const result = await build({stdin: {contents: entry, loader: 'tsx', resolveDir: path.join(root, 'apps/web')}, bundle: true,
      platform: 'node', format: 'cjs', write: false, jsx: 'automatic', loader: {'.css': 'empty'}, define: {'process.env.NODE_ENV': '"production"'}});
    const loaded = {exports: {}};
    Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
    return loaded.exports as Scenes;
  })();
}

const roles = {
  first_frame: 'boardUi.role.firstFrame', subject_reference: 'boardUi.role.subject', composition: 'boardUi.role.composition',
  reference_audio: 'boardUi.role.audio', reference_video: 'boardUi.role.video',
} as const;
function port(html: string, id: string, kind: ChainNodeKind): string {
  return html.match(new RegExp(`<div[^>]*data-testid="board-port-${kind}-${id}"[^>]*>`))?.[0] ?? '';
}
function sequencePaths(html: string) {
  const line = html.match(/<path[^>]*class="react-flow__edge-path board-sequence-line"[^>]*>/u)?.[0] ?? '';
  const path = line.match(/\bd="([^"]+)"/u)?.[1];
  const motion = html.match(/<circle[^>]*offset-path:path\(&#x27;([^&]+)&#x27;\) view-box[^>]*>/u)?.[1];
  assert.ok(path); assert.equal(motion, path, 'the dot consumes the exact line path in the same view-box');
  return path;
}
function pathPoints(path: string): number[] {
  return (path.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/giu) ?? []).map(Number);
}

test('sequence edges render one moving dot on a solid path and never forward arrow markers', async () => {
  const html = (await fixture()).edge('sequence', 'zh-Hans');
  assert.match(html, /data-board-edge-kind="sequence"/);
  assert.match(html, /class="react-flow__edge-path board-sequence-line"[^>]*stroke-dasharray:none/);
  assert.equal((html.match(/<circle /gu) ?? []).length, 1);
  const points = pathPoints(sequencePaths(html));
  assert.deepEqual(points.slice(0, 2), [10, 20]);
  assert.deepEqual(points.slice(-2), [300, 150]);
  assert.doesNotMatch(html, /marker-end|forbidden-arrow/);
  assert.doesNotMatch(html, /board-reference-label|<animateMotion/);
});

test('sequence routes keep a shared dot path at straight neighbours and rounded row returns', async () => {
  const render = await fixture();
  const straight = pathPoints(sequencePaths(render.edge('sequence', 'en', 'first_frame', false, 'straight')));
  assert.deepEqual(straight.slice(0, 2), [10, 20]);
  assert.deepEqual(straight.slice(-2), [300, 20]);
  assert.ok(straight.filter((_, index) => index % 2 === 1).every(y => y === 20));
  const folded = sequencePaths(render.edge('sequence', 'en', 'first_frame', false, 'folded'));
  const points = pathPoints(folded);
  assert.deepEqual(points.slice(0, 2), [500, 100]);
  assert.deepEqual(points.slice(-2), [100, 360]);
  assert.ok(Math.max(...points.filter((_, index) => index % 2 === 0)) > 500, 'the return first leaves the source right side');
  assert.ok(Math.min(...points.filter((_, index) => index % 2 === 0)) < 100, 'the return enters the target from its left side');
  let x = 500, y = 100;
  for (const segment of folded.matchAll(/([MLQ])([^MLQ]*)/gu)) {
    const values = pathPoints(segment[2]!);
    if (segment[1] === 'L') assert.ok(values[0] === x || values[1] === y, 'straight portions stay orthogonal between rounded corners');
    x = values.at(-2)!; y = values.at(-1)!;
  }
});

test('reference edge role labels use the current locale for all five supported roles', async () => {
  const render = await fixture();
  for (const locale of LOCALES) for (const [role, key] of Object.entries(roles)) {
    const html = render.edge('reference', locale, role as ChainReferenceRole);
    assert.match(html, /data-board-edge-kind="reference"/);
    assert.match(html, /class="react-flow__edge-path board-reference-line"[^>]*stroke-dasharray:7 6/);
    assert.ok(html.includes(translate(locale, key)), `${locale}/${role}`);
    assert.doesNotMatch(html, /<circle |marker-end|forbidden-arrow/);
  }
});

test('edge motion overrides are carried by each rendered edge without SVG timeline animation', async () => {
  const render = await fixture();
  for (const kind of ['sequence', 'reference'] as const) {
    assert.match(render.edge(kind, 'en', 'composition', true), /data-reduce-motion="true"/);
    assert.doesNotMatch(render.edge(kind, 'en', 'composition'), /data-reduce-motion="true"/);
  }
  const css = readFileSync(new URL('../apps/web/src/board-ui/edges.css', import.meta.url), 'utf8');
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)[\s\S]*animation:none!important/);
  assert.match(css, /\[data-reduce-motion="true"\][\s\S]*animation:none!important/);
});

test('ports render the allowed sides for film, shots and references with localized accessible names', async () => {
  const render = await fixture();
  for (const locale of LOCALES) {
    const html = render.ports(locale);
    assert.match(port(html, 'sequence-out', 'film'), /data-port-side="right"/);
    assert.equal(port(html, 'sequence-in', 'film'), '');
    assert.match(port(html, 'sequence-in', 'shot'), /data-port-side="left"/);
    assert.match(port(html, 'reference-in-top', 'shot'), /data-port-side="top"/);
    assert.match(port(html, 'reference-in-bottom', 'shot'), /data-port-side="bottom"/);
    assert.ok(port(html, 'reference-in-top', 'shot').includes(translate(locale, 'boardUi.port.referenceInTop')));
    assert.match(port(html, 'reference-out-top', 'image'), /data-port-type="source"/);
    assert.match(port(html, 'reference-out-bottom', 'video'), /data-port-type="source"/);
    for (const kind of ['audio', 'subject', 'previs'] as const) assert.equal(port(html, 'sequence-out', kind), '');
    assert.doesNotMatch(html, /data-testid="board-port-text-/);
  }
});

test('drag highlights match port family in both directions and disabled ports never become candidates', async () => {
  const render = await fixture();
  const forward: BoardPortEndpoint = {nodeId: 'image', kind: 'image', portId: 'reference-out-top'};
  const html = render.ports('zh-Hans', forward);
  assert.match(port(html, 'reference-in-top', 'shot'), /data-candidate="true"/);
  assert.match(port(html, 'reference-in-bottom', 'shot'), /data-candidate="true"/);
  assert.match(port(html, 'sequence-in', 'shot'), /data-candidate="false"/);
  assert.match(port(html, 'reference-out-top', 'image'), /data-candidate="false"/);
  const reverse = render.ports('en', {nodeId: 'shot', kind: 'shot', portId: 'reference-in-bottom'});
  for (const kind of ['image', 'video', 'audio', 'subject', 'previs'] as const)
    assert.match(port(reverse, 'reference-out-top', kind), /data-candidate="true"/);
  assert.match(port(reverse, 'sequence-out', 'film'), /data-candidate="false"/);
  assert.doesNotMatch(render.ports('en', forward, true), /data-candidate="true"/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as references from '../apps/web/src/reference-connections.js';

const projectId = 'project-a';
const asset = { id: 'asset-a', projectId, name: '花园首帧.png', mimeType: 'image/png' };
const source = { id: '12345678-0000-4000-8000-000000000001', projectId, label: '花园构图', type: 'image', assetId: asset.id };
const shot = { id: 'shot-a', projectId, title: '推近花园', orderIndex: 4, referenceAssetIds: [] };
const edge = { id: 'edge-a', projectId, kind: 'reference', role: 'first_frame', source: source.id, sourceAssetId: asset.id, target: shot.id };
const details = patch => references.referenceSourceDetails({ sourceId: source.id, assetId: asset.id, projectId, nodes: [source], assets: [asset], ...patch });

test('reference source includes the material, node name and a collision-free identity', () => {
  const other = { ...source, id: '12345678-0000-4000-8000-000000000002' };
  const first = details(), second = details({ sourceId: other.id, nodes: [other] });
  assert.equal(first.asset, asset);
  assert.equal(first.source, source);
  assert.ok(first.description.includes(asset.name));
  assert.ok(first.description.includes(source.label));
  assert.ok(first.sourceLabel.includes(source.id));
  assert.ok(second.sourceLabel.includes(other.id));
  assert.notEqual(first.sourceLabel, second.sourceLabel, 'Equal names and ID prefixes remain distinguishable even with only one node available');
});

test('target labels distinguish duplicate titles in the supplied storyboard order without mutating records', () => {
  const shots = [shot, { ...shot, id: 'shot-b' }, { ...shot, id: 'foreign', projectId: 'other', title: 'FOREIGN_TITLE' }];
  const before = structuredClone(shots), options = references.referenceTargetOptions(shots, projectId);
  assert.deepEqual(options.map(option => option.label), ['镜头 01 · 推近花园', '镜头 02 · 推近花园']);
  assert.deepEqual(options.map(option => option.shot.id), ['shot-a', 'shot-b']);
  assert.equal(options[0].shot, shot);
  assert.deepEqual(shots, before);
  assert.ok(!JSON.stringify(options).includes('FOREIGN_TITLE'));
});

test('long names remain complete and blank names receive readable fallbacks', () => {
  const longName = '雨后的花园🌿'.repeat(24);
  const value = details({ nodes: [{ ...source, label: longName }], assets: [{ ...asset, name: `${longName}.png` }] });
  assert.ok(value.sourceLabel.includes(longName));
  assert.equal(value.assetLabel, `${longName}.png`);
  assert.ok(value.description.includes(`${longName}.png`));
  assert.equal(references.referenceTargetOptions([{ ...shot, title: longName }], projectId)[0].label, `镜头 01 · ${longName}`);
  const empty = details({ nodes: [{ ...source, label: '  ' }], assets: [{ ...asset, name: '' }] });
  assert.match(empty.sourceLabel, /未命名图片节点/);
  assert.equal(empty.assetLabel, '未命名图片素材');
  assert.equal(references.referenceTargetOptions([{ ...shot, title: '\t' }], projectId)[0].label, '镜头 01 · 未命名镜头');
});

test('missing source and missing asset fall back independently without inventing a replacement', () => {
  const noSource = details({ nodes: [] }), noAsset = details({ assets: [] });
  assert.equal(noSource.source, undefined);
  assert.equal(noSource.sourceLabel, '来源节点不可用');
  assert.equal(noSource.asset, asset);
  assert.equal(noAsset.asset, undefined);
  assert.equal(noAsset.source, source);
  assert.match(noAsset.assetLabel, /素材不可用/);
});

test('foreign records with matching IDs cannot supply labels, media or inspect targets', () => {
  const foreignNode = { ...source, projectId: 'other', label: 'FOREIGN_NODE' };
  const foreignAsset = { ...asset, projectId: 'other', name: 'FOREIGN_ASSET', url: '/FOREIGN_MEDIA' };
  const value = details({ nodes: [foreignNode], assets: [foreignAsset] });
  assert.equal(value.source, undefined);
  assert.equal(value.asset, undefined);
  assert.ok(!JSON.stringify(value).includes('FOREIGN'));
  assert.equal(details({ nodes: [foreignNode, source], assets: [foreignAsset, asset] }).source, source);
  assert.equal(details({ nodes: [foreignNode, source], assets: [foreignAsset, asset] }).asset, asset);
});

test('bound source resolution keeps the edge asset and refuses a mismatched node', () => {
  const changed = { ...source, assetId: 'replacement', label: 'UNRELATED_NODE' };
  const replacement = { ...asset, id: changed.assetId, name: 'UNRELATED_IMAGE' };
  const before = structuredClone({ changed, replacement, asset });
  const value = details({ nodes: [changed], assets: [replacement, asset] });
  assert.equal(value.asset, asset);
  assert.equal(value.source, undefined);
  assert.ok(!value.description.includes('UNRELATED'));
  assert.deepEqual({ changed, replacement, asset }, before);
});

test('unscoped records and non-image records do not acquire reference labels', () => {
  for (const scope of [undefined, null, '']) {
    const value = details({ projectId: scope, nodes: [{ ...source, projectId: scope }], assets: [{ ...asset, projectId: scope }] });
    assert.equal(value.source, undefined);
    assert.equal(value.asset, undefined);
    assert.deepEqual(references.referenceTargetOptions([{ ...shot, projectId: scope }], scope), []);
  }
  assert.equal(details({ nodes: [{ ...source, type: 'video' }] }).source, undefined);
  assert.equal(details({ assets: [{ ...asset, mimeType: 'video/mp4' }] }).asset, undefined);
  assert.deepEqual(references.referenceTargetOptions([{ ...shot, id: undefined }, { ...shot, id: '' }], projectId), []);
});

// Match existing component tests: execute real JSX with a small hook/control
// harness. Missing local esbuild is an explicit skip, never an install or a
// fallback to another checkout; pure presentation tests above still run.
let esbuildUrl;
try { esbuildUrl = import.meta.resolve('esbuild'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const transformSync = esbuildUrl ? (await import(esbuildUrl)).transformSync : null;
const componentTest = { skip: !transformSync && 'Local esbuild is not installed; component rendering requires parent UI verification' };
const treeNodes = tree => Array.isArray(tree) ? tree.flatMap(treeNodes) : tree && typeof tree === 'object' ? [tree, ...treeNodes(tree.props?.children)] : [];
const textContent = tree => Array.isArray(tree) ? tree.map(textContent).join('') : tree && typeof tree === 'object' ? textContent(tree.props?.children) : typeof tree === 'string' ? tree : '';
function harness(name) {
  let selected = '', tree;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: () => [selected, value => { selected = value; }],
  };
  react.default = react;
  const code = transformSync(readFileSync(new URL('../apps/web/src/ReferenceConnections.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
  const module = { exports: {} };
  Function('module', 'exports', 'require', code)(module, module.exports, id => {
    if (id === 'react') return react;
    if (id === './reference-connections.js') return references;
    if (id === './WorkspaceControls.jsx') return { WorkbenchSelect: 'WorkbenchSelect' };
    if (id === './icons.jsx') return { default: 'Icon', __esModule: true };
    if (id === './api.js') return { assetUrl: value => `/media/${value.id}` };
    if (id === '@mioon/ui/components/button') return { Button: 'Button' };
    if (id === '@mioon/ui/components/label') return { Label: 'Label' };
    throw Error(`Unexpected component dependency: ${id}`);
  });
  return {
    render(props) { return tree = module.exports[name](props); },
    nodes: () => treeNodes(tree),
    find: testId => treeNodes(tree).find(node => node.props?.['data-testid'] === testId),
  };
}
const sourceProps = patch => ({ node: source, project: { id: projectId }, assets: [asset], shots: [shot], edges: [], busy: false, pending: false, dirty: false, conflict: false, onAttach: () => {}, onInspect: () => {}, ...patch });
const boundProps = patch => ({ edge, nodes: [source], assets: [asset], busy: false, pending: false, dirty: false, conflict: false, onDetach: () => {}, onInspect: () => {}, ...patch });

test('source panel wires readable labels and full selected-target descriptions to the shared control', componentTest, () => {
  const h = harness('ReferenceSourcePanel'), attached = [], longTitle = '完整目标名称'.repeat(30);
  const props = sourceProps({ shots: [{ ...shot, title: longTitle }, { ...shot, id: 'shot-b', title: longTitle }], onAttach: (...ids) => attached.push(ids) });
  h.render(props);
  assert.equal(textContent(h.find('reference-source-label')), details().displayDescription);
  assert.equal(h.find('reference-source-label').props.title, details().description);
  assert.equal(h.find('reference-source-label').props['aria-label'], details().description);
  assert.ok(!textContent(h.find('reference-source-label')).includes(source.id), 'Full identity stays accessible without crowding visible names');
  const options = h.nodes().filter(node => node.type === 'option' && node.props.value);
  assert.notEqual(textContent(options[0]), textContent(options[1]));
  h.find('attach-reference-target').props.onChange({ target: { value: 'shot-b' } });
  h.render(props);
  const select = h.find('attach-reference-target'), description = h.nodes().find(node => node.props.id === select.props['aria-describedby']);
  assert.equal(select.props.value, 'shot-b');
  assert.equal(select.props.title, `镜头 02 · ${longTitle}`);
  assert.equal(textContent(description), select.props.title);
  assert.equal(h.find('attach-reference').props.disabled, false);
  h.find('attach-reference').props.onClick();
  assert.deepEqual(attached, [[source.id, 'shot-b']]);
});

test('connected target labels ignore decorative and foreign edges and never navigate to missing targets', componentTest, () => {
  const h = harness('ReferenceSourcePanel'), inspected = [], foreign = { ...shot, id: 'foreign-shot', projectId: 'other', title: 'FOREIGN_TITLE' };
  const tree = h.render(sourceProps({ shots: [shot, foreign], edges: [edge, { ...edge, id: 'missing', target: 'missing-shot' }, { ...edge, id: 'foreign-target', target: foreign.id }, { ...edge, id: 'foreign-edge', projectId: 'other' }, { ...edge, id: 'visual', kind: 'decorative' }], onInspect: id => inspected.push(id) }));
  const links = h.nodes().filter(node => node.props['aria-label']?.startsWith('查看已连接目标'));
  assert.equal(links.length, 1);
  assert.equal(textContent(links[0]), '镜头 01 · 推近花园');
  links[0].props.onClick();
  assert.deepEqual(inspected, [shot.id]);
  assert.match(textContent(tree), /目标镜头不可用/);
  assert.ok(!JSON.stringify(tree).includes('FOREIGN_TITLE'));
  assert.equal(h.nodes().filter(node => node.type === 'option').length, 2);
});

test('a target that disappears or moves projects no longer remains selected or attachable', componentTest, () => {
  const h = harness('ReferenceSourcePanel'), props = sourceProps();
  h.render(props);
  h.find('attach-reference-target').props.onChange({ target: { value: shot.id } });
  h.render({ ...props, shots: [{ ...shot, projectId: 'other', title: 'FOREIGN_TITLE' }] });
  assert.equal(h.find('attach-reference-target').props.value, '');
  assert.equal(h.find('attach-reference-target').props['aria-describedby'], undefined);
  assert.equal(h.find('attach-reference').props.disabled, true);
  assert.ok(!JSON.stringify(h.nodes()).includes('FOREIGN_TITLE'));
});

test('bound reference uses complete accessible names and preserves inspect/detach IDs and guards', componentTest, () => {
  const h = harness('BoundReference'), inspected = [], detached = [], props = boundProps({ onInspect: id => inspected.push(id), onDetach: id => detached.push(id) });
  h.render(props);
  const link = h.nodes().find(node => node.props['aria-label']?.startsWith('查看来源节点'));
  assert.ok(link.props['aria-label'].includes(source.label));
  assert.ok(link.props['aria-label'].includes(source.id));
  assert.ok(!textContent(h.find('bound-reference')).includes(source.id));
  assert.ok(h.find('bound-reference').props['aria-label'].includes(asset.name));
  assert.equal(h.nodes().find(node => node.type === 'img').props.alt, asset.name);
  link.props.onClick(); h.find('detach-reference').props.onClick();
  assert.deepEqual(inspected, [source.id]); assert.deepEqual(detached, [edge.id]);
  for (const guard of ['busy', 'dirty', 'conflict']) {
    h.render({ ...props, [guard]: true });
    assert.equal(h.find('detach-reference').props.disabled, true);
  }
});

test('unavailable bound records expose neither foreign labels nor media and keep detach available', componentTest, () => {
  const h = harness('BoundReference');
  const tree = h.render(boundProps({ nodes: [{ ...source, projectId: 'other', label: 'FOREIGN_NODE' }], assets: [{ ...asset, projectId: 'other', name: 'FOREIGN_ASSET' }] }));
  assert.ok(!JSON.stringify(tree).includes('FOREIGN'));
  assert.ok(!h.nodes().some(node => node.type === 'img'));
  assert.equal(h.nodes().find(node => node.props['aria-label']?.startsWith('查看来源节点')).props.disabled, true);
  assert.ok(!h.find('detach-reference').props.disabled);
  assert.equal(h.render(boundProps({ edge: { ...edge, kind: 'decorative' } })), null);
});

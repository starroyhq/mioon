import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../packages/ui/', import.meta.url));

test('application compositions render with real React/Base UI under the shipped classic JSX transform', () => {
  const fixture = `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server.browser';
    import assert from 'node:assert/strict';
    import { Button } from './src/components/button.tsx';
    import { WorkbenchButton, WorkbenchTabs, WorkbenchChip, WorkbenchBadge, WorkbenchAlert, WorkbenchEmptyState, WorkbenchProgress, WorkbenchPanel, WorkbenchGroup, WorkbenchToastRegion, WorkbenchToast } from './src/components/workbench-controls.tsx';
    const click = () => {};
    const control = WorkbenchButton({ variant: 'danger', onClick: click, children: 'Remove', 'data-testid': 'remove' });
    assert.equal(control.type, Button);
    assert.equal(control.props.onClick, click);
    assert.equal(control.props['data-testid'], 'remove');
    for (const variant of ['primary', 'secondary', 'ghost', 'danger', 'danger-ghost', 'icon']) {
      for (const size of ['compact', 'default', 'large']) {
        const html = renderToStaticMarkup(<WorkbenchButton variant={variant} size={size} aria-label="Action">Action</WorkbenchButton>);
        assert.ok(html.includes('data-variant="' + variant + '"'));
        assert.ok(html.includes('data-size="' + size + '"'));
        assert.ok(html.includes('wb-button'));
      }
    }
    const loading = renderToStaticMarkup(<WorkbenchButton loading>Generate</WorkbenchButton>);
    assert.ok(loading.includes('aria-busy="true"'));
    assert.ok(loading.includes('disabled=""'));
    assert.ok(loading.includes('aria-hidden="true"'));
    assert.ok(loading.includes('Generate'));
    const chip = renderToStaticMarkup(<WorkbenchChip selected>Video</WorkbenchChip>);
    assert.ok(chip.includes('aria-pressed="true"'));
    const tabs = renderToStaticMarkup(<WorkbenchTabs value="canvas" label="Mode" onValueChange={() => {}} options={[{value:'canvas',label:'Canvas'},{value:'editing',label:'Editing'}]} />);
    assert.ok(tabs.includes('role="tablist"'));
    assert.ok(tabs.includes('role="tab"'));
    assert.ok(tabs.includes('aria-selected="true"'));
    const group = renderToStaticMarkup(<WorkbenchGroup title="Audio" defaultOpen>Draft</WorkbenchGroup>);
    assert.ok(group.includes('aria-expanded="true"'));
    assert.ok(group.includes('Draft'));
    const badge = renderToStaticMarkup(<WorkbenchBadge tone="success" media="audio" dot>A1</WorkbenchBadge>);
    assert.ok(badge.includes('data-media="audio"'));
    assert.ok(badge.includes('aria-hidden="true"'));
    assert.ok(renderToStaticMarkup(<WorkbenchAlert tone="danger">Failed</WorkbenchAlert>).includes('role="alert"'));
    assert.ok(renderToStaticMarkup(<WorkbenchAlert>Ready</WorkbenchAlert>).includes('role="status"'));
    const empty = renderToStaticMarkup(<WorkbenchEmptyState title="No shots" description="Add a shot" actions={<WorkbenchButton>Add</WorkbenchButton>} />);
    assert.ok(empty.includes('<h3>No shots</h3>'));
    const panel = renderToStaticMarkup(<WorkbenchPanel title="Properties" footer={<WorkbenchButton>Save</WorkbenchButton>}>Draft</WorkbenchPanel>);
    assert.ok(panel.includes('aria-labelledby="'));
    assert.ok(panel.includes('wb-panel-footer'));
    for (const [value, expected] of [[-1, 0], [50, 50], [101, 100], [NaN, 0], [Infinity, 0]]) {
      const html = renderToStaticMarkup(<WorkbenchProgress value={value} label="Rendering" />);
      assert.ok(html.includes('aria-valuenow="' + expected + '"'));
      assert.ok(html.includes('width:' + expected + '%'));
    }
    const toasts = renderToStaticMarkup(<WorkbenchToastRegion label="Notifications"><WorkbenchToast>Saved</WorkbenchToast></WorkbenchToastRegion>);
    assert.ok(toasts.includes('aria-live="polite"'));
    assert.ok(toasts.includes('<li'));
    console.log('Workbench controls verified');
    process.exit(0);
  `;
  const bundle = buildSync({ stdin: { contents: fixture, loader: 'tsx', resolveDir: root }, absWorkingDir: root, bundle: true, platform: 'node', format: 'cjs', jsx: 'transform', write: false, logLevel: 'silent' }).outputFiles[0].text;
  const output = execFileSync(process.execPath, ['--input-type=commonjs', '-'], { input: bundle, encoding: 'utf8', timeout: 30_000 });
  assert.match(output, /Workbench controls verified/);
});

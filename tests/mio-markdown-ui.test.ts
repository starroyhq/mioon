import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {build} from 'esbuild';

const fixture = await build({
  stdin: {contents: `
    import React from 'react';
    import {renderToStaticMarkup} from 'react-dom/server';
    import MioMarkdown from './MioMarkdown.tsx';
    export const render = text => renderToStaticMarkup(<MioMarkdown>{text}</MioMarkdown>);
  `, loader: 'tsx', resolveDir: fileURLToPath(new URL('../apps/web/src/', import.meta.url))},
  bundle: true, format: 'cjs', platform: 'node', write: false,
  define: {'process.env.NODE_ENV': '"production"'}, logLevel: 'silent',
});
const module = {exports: {} as {render(text: string): string}};
new Function('module', 'exports', 'require', fixture.outputFiles![0]!.text)(module, module.exports, createRequire(import.meta.url));
const {render} = module.exports;

test('renders headings as bold paragraphs and preserves plain line breaks', () => {
  assert.equal(render('# 项目摘要\r\n第一行\r\n第二行\n\n下一段'), '<p><strong>项目摘要</strong></p><p>第一行\n第二行</p><p>下一段</p>');
});

test('renders nested emphasis and keeps formatting tokens inside code literal', () => {
  assert.equal(render('**粗体 *内层斜体***，*斜体 **内层粗体***，***两种强调***，`**代码**`，foo_bar_baz'),
    '<p><strong>粗体 <em>内层斜体</em></strong>，<em>斜体 <strong>内层粗体</strong></em>，<em><strong>两种强调</strong></em>，<code>**代码**</code>，foo_bar_baz</p>');
});

test('renders both list types and nests indented items inside their parent', () => {
  assert.equal(render('3. 核对\n   - **通过**\n   - 复验\n4. 记录\n\n* 归档'),
    '<ol start="3"><li>核对<ul><li><strong>通过</strong></li><li>复验</li></ul></li><li>记录</li></ol><ul><li>归档</li></ul>');
});

test('keeps fenced text, spacing and long code lines intact in a focusable code block', () => {
  const command = 'code_'.repeat(256);
  assert.equal(render('```txt\n  **literal**\n' + command + '\n```\n之后'),
    '<pre tabindex="0"><code>  **literal**\n' + command + '</code></pre><p>之后</p>');
  assert.equal(render('~~~\nunfinished'), '<pre tabindex="0"><code>unfinished</code></pre>');
  assert.equal(render('尝试 ``a`b``'), '<p>尝试 <code>a`b</code></p>');
  assert.equal(render('`tail\\` and \\`literal'), '<p><code>tail\\</code> and `literal</p>');
});

test('shows HTML, images and unsafe destinations as text only', () => {
  const html = render('<img src="x" onerror="alert(1)">\n<script>alert(1)</script>\n[文档](https://example.invalid)\n[命令](javascript:alert(1))\n![图片](https://example.invalid/image)');
  assert.match(html, /&lt;img src=&quot;x&quot; onerror=&quot;alert\(1\)&quot;&gt;/u);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(html, /文档 \(https:\/\/example\.invalid\)/u);
  assert.match(html, /命令 \(javascript:alert\(1\)\)/u);
  assert.match(html, /!\[图片\]\(https:\/\/example\.invalid\/image\)/u);
  assert.doesNotMatch(html, /<(?:a|img|script)\b|\bhref=/iu);
});

test('keeps unfinished inline spans readable as streaming text is appended', () => {
  const prefix = '# 摘要\n\n正文与 **已完成**，';
  for (const partial of ['*', '**', '**进一步', '**进一步*']) {
    assert.equal(render(prefix + partial), `<p><strong>摘要</strong></p><p>正文与 <strong>已完成</strong>，${partial}</p>`);
  }
  assert.equal(render(prefix + '**进一步**'), '<p><strong>摘要</strong></p><p>正文与 <strong>已完成</strong>，<strong>进一步</strong></p>');
  assert.equal(render('文本 `未完成'), '<p>文本 `未完成</p>');
  assert.equal(render('文本 \\*字面*'), '<p>文本 *字面*</p>');
});

test('preserves an unfinished outer span and treats long unfinished link input as text', () => {
  assert.equal(render('前文 **接下来 *已确认*，等待'), '<p>前文 **接下来 <em>已确认</em>，等待</p>');
  assert.equal(render('前文 **接下来 *已确认*，等待**'), '<p>前文 <strong>接下来 <em>已确认</em>，等待</strong></p>');
  const unfinishedLinks = '[没有链接'.repeat(10_000);
  assert.equal(render(unfinishedLinks), '<p>' + unfinishedLinks + '</p>');
});

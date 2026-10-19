import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_DRAFT_LIMITS } from '@mioon/contracts/local-drafts';
import { LOCAL_DELIVERY_LIMITS } from '@mioon/contracts/local-delivery';
import { LOCAL_SHOT_TEXT_LIMITS } from '@mioon/contracts/local-shot-text';
import { DURABLE_EDIT_OPERATIONS, EDIT_TASK_LIMITS } from '@mioon/contracts';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = readFileSync(path.join(root, 'apps/web/src/RecoveryStorageDetails.tsx'), 'utf8');
const ids = {
  clip: 'clip-draft-disclosure',
  delivery: 'delivery-draft-disclosure',
  'shot-text': 'shot-text-draft-disclosure',
  'task-center': 'recovery-task-storage-disclosure',
};
let rendered;

before(() => {
  const fixture = `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server.browser';
    import { ConfirmationProvider } from '@mioon/ui/components/workbench-confirm';
    import RecoveryStorageDetails from './src/RecoveryStorageDetails.tsx';
    import ClipDraftRecovery from './src/ClipDraftRecovery.tsx';
    import DeliveryDraftRecovery from './src/DeliveryDraftRecovery.tsx';
    import ShotTextDraftRecovery from './src/ShotTextDraftRecovery.tsx';
    const render = element => renderToStaticMarkup(element);
    const props = [
      { domain: 'clip' }, { domain: 'delivery' }, { domain: 'shot-text' },
      { domain: 'task-center', durableOperationCount: ${DURABLE_EDIT_OPERATIONS.length} },
    ];
    const controller = new Proxy({}, { get() { return () => { throw Error('Passive disclosure invoked a controller action'); }; } });
    const state = { phase: 'ready', dirty: false, raw: { title: '', prompt: '' } };
    export const html = {
      domains: Object.fromEntries(props.map(props => [props.domain, render(<RecoveryStorageDetails {...props} />)])),
      repeated: props.map(props => render(<RecoveryStorageDetails {...props} />)),
      injected: [7, 41].map(durableOperationCount => render(<RecoveryStorageDetails domain="task-center" durableOperationCount={durableOperationCount} />)),
      hosts: {
        clip: render(<ConfirmationProvider><ClipDraftRecovery state={state} controller={controller} pending={false} /></ConfirmationProvider>),
        delivery: render(<DeliveryDraftRecovery state={state} controller={controller} />),
        'shot-text': render(<ShotTextDraftRecovery state={state} controller={controller} />),
      },
    };
  `;
  const script = `
    import { build } from 'esbuild';
    globalThis.fetch = () => { throw Error('Passive disclosure fetched'); };
    for (const key of ['localStorage', 'sessionStorage']) Object.defineProperty(globalThis, key, { get() { throw Error('Passive disclosure accessed browser storage'); } });
    const { outputFiles } = await build({
      stdin: { contents: ${JSON.stringify(fixture)}, loader: 'tsx', resolveDir: ${JSON.stringify(path.join(root, 'apps/web'))} },
      bundle: true, format: 'esm', platform: 'browser', write: false, jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
    });
    const result = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
    process.stdout.write(JSON.stringify(result.html));
    process.exit(0);
  `;
  rendered = JSON.parse(execFileSync(process.execPath, ['--input-type=module'], {
    cwd: root, input: script, encoding: 'utf8', timeout: 30_000,
  }));
});

test('all four domains use one native, initially collapsed disclosure with an accessible summary', () => {
  for (const [domain, id] of Object.entries(ids)) {
    const html = rendered.domains[domain];
    assert.equal((html.match(/<details\b/g) || []).length, 1, domain);
    assert.equal((html.match(/<summary>/g) || []).length, 1, domain);
    assert.match(html, new RegExp(`^<details[^>]*data-testid="${id}"[^>]*><summary>`));
    const summary = domain === 'task-center' ? '保存范围与容量说明' : '本地保存什么？';
    assert.ok(html.includes(`<summary>${summary}</summary>`), domain);
    assert.doesNotMatch(html, /<details[^>]*\sopen(?:[\s=>])|tabindex=|role="(?:button|dialog)"/);
  }
});

test('disclosures have no custom actions, state, network, storage, or unsafe type escape', () => {
  for (const html of Object.values(rendered.domains)) {
    assert.doesNotMatch(html, /<(?:button|input|textarea|select|form|a|dialog)\b|\son[a-z]+=/i);
  }
  assert.deepEqual(rendered.repeated, Object.values(rendered.domains));
  // The disclosure is presentational: its only module imports are React and the
  // read-only i18n context, and its only hook is the i18n reader. No state,
  // effect, reducer, ref, custom action handler, transport or storage is allowed.
  assert.deepEqual([...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(match => match[1]), ['./i18n/I18nProvider.tsx', 'react']);
  assert.deepEqual([...new Set([...source.matchAll(/\b(use[A-Z]\w*)\b/g)].map(match => match[1]))], ['useI18n']);
  assert.equal([...source.matchAll(/\buse[A-Z]\w*\s*\(/g)].length, 1, 'only one i18n hook call is allowed');
  assert.doesNotMatch(source, /\bon[A-Z]\w*\s*=|\bfetch\b|\b(?:localStorage|sessionStorage|setTimeout|setInterval)\b|dangerouslySetInnerHTML/);
  assert.doesNotMatch(source, /:\s*any\b|\bas\s+any\b|@ts-ignore|@ts-nocheck/);
});

test('every domain discloses plaintext privacy, unconfirmed input loss, backup exclusion and restored limits', () => {
  for (const [domain, html] of Object.entries(rendered.domains)) {
    for (const phrase of ['本机私有目录', '明文', '不保存账号或认证配置', '自由文本仍可能包含隐私', '最后未收到确认的输入可能丢失', '离线备份', '恢复分支', '仍可使用']) {
      assert.ok(html.includes(phrase), `${domain}: ${phrase}`);
    }
    assert.match(html, /不包含在工作区(?:离线)?备份中/);
  }
});

test('clip capacity counts cumulative target slots and retained cleared revisions without inventing its own intent', () => {
  const html = rendered.domains.clip;
  assert.ok(html.includes(`累计最多 ${LOCAL_DRAFT_LIMITS.slots} 个项目/时间线/片段目标槽位`));
  assert.match(html, /清除草稿后保留的版本记录仍占位/);
  assert.match(html, /尚未提供槽位清理/);
  assert.match(html, /容量限制不表示磁盘已满/);
  assert.match(html, /原始输入、原时间线版本和素材来源/);
  assert.match(html, /恢复到属性表单不会保存到时间线/);
  assert.match(html, /原业务请求仍由任务中心单独核对/);
  assert.match(html, /只重置表单，不取消在途草稿写入/);
  assert.match(html, /不会取消原业务请求或清除其记录/);
  assert.doesNotMatch(html, /片段(?:原)?意图|原导出请求|原文字请求/);
});

test('delivery distinguishes raw name from retained exact export parameters and captured-name retention', () => {
  const html = rendered.domains.delivery;
  assert.ok(html.includes(`最多保留 ${LOCAL_DELIVERY_LIMITS.slots} 个项目槽位`));
  assert.match(html, /清除名称后保留的版本记录与最新原导出请求仍占位/);
  assert.match(html, /不保存可编辑的输出规格/);
  assert.match(html, /包括本次输出规格和已有检查的摘要标识/);
  assert.match(html, /恢复名称不会导出/);
  assert.match(html, /均不会提交或重试导出/);
  assert.match(html, /明确恢复原请求才会按原编号与精确参数核对或执行/);
  assert.match(html, /不会取消原导出请求，也不保证清除原请求已捕获的名称/);
  assert.match(html, /尚未提供槽位清理/);
  assert.match(html, /容量限制不表示磁盘已满/);
});

test('shot text distinguishes original text, retained exact save intent and unchanged non-text fields', () => {
  const html = rendered.domains['shot-text'];
  assert.ok(html.includes(`最多保留 ${LOCAL_SHOT_TEXT_LIMITS.slots} 个项目/镜头槽位`));
  assert.match(html, /清除草稿后保留的版本记录与最新原文字请求仍占位/);
  assert.match(html, /原始标题、提示词、原文字与保存版本/);
  assert.match(html, /不保存参考图或生成参数/);
  assert.match(html, /单独持久保存原请求编号与精确文字修改/);
  assert.match(html, /只替换标题和提示词，其他输入保留/);
  assert.match(html, /不会改用当前输入，也不会调用模型或生成镜头/);
  assert.match(html, /不会取消原文字请求，也不保证清除原请求已捕获的文字/);
  assert.match(html, /尚未提供槽位清理/);
  assert.match(html, /旁文件载荷上限/);
  assert.match(html, /容量限制不表示磁盘已满/);
});

test('task center keeps injected operation counts separate from the retained SQL identity quota', () => {
  const html = rendered.domains['task-center'];
  assert.ok(html.includes(`${DURABLE_EDIT_OPERATIONS.length} 类本地编辑请求`));
  assert.ok(html.includes(`最多保留 ${EDIT_TASK_LIMITS.rows} 个请求身份`));
  assert.match(html, /现有 SQLite 任务台账保留原编号与完整参数/);
  assert.match(html, /已完成并关闭的记录也占容量/);
  assert.match(html, /达到上限会阻止新建此类任务，不表示磁盘已满/);
  assert.match(html, /不是整个数据库或 WAL 的大小上限/);
  for (const [index, count] of [7, 41].entries()) {
    assert.ok(rendered.injected[index].includes(`${count} 类本地编辑请求`));
    assert.ok(rendered.injected[index].includes(`最多保留 ${EDIT_TASK_LIMITS.rows} 个请求身份`));
    assert.ok(!rendered.injected[index].includes(`${DURABLE_EDIT_OPERATIONS.length} 类本地编辑请求`));
  }
});

test('task center explains sidecar exceptions without claiming complete recovery coverage or automatic dispatch', () => {
  const html = rendered.domains['task-center'];
  for (const phrase of ['普通时间线渲染/预览', '当前浏览器会话', '非文字或混合修改', '生成提交', '普通工作区中的例外', 'purpose=export', '标题/提示词专用保存', '原交付面板或镜头面板明确恢复']) {
    assert.ok(html.includes(phrase), phrase);
  }
  assert.match(html, /不会汇总这些旁文件中的全部原请求/);
  assert.match(html, /不会自动执行业务或调用模型/);
  assert.match(html, /原请求恢复只使用保存的原编号与精确参数/);
  assert.match(html, /以上四类旁文件均不包含在工作区离线备份中/);
  assert.match(html, /放弃草稿或重置当前输入不会取消原请求，也不保证清除原请求已捕获的文本/);
});

test('last-project remains one overwritten location, separate from all three bounded draft domains', () => {
  const html = rendered.domains['task-center'];
  const rows = [...html.matchAll(/<li>(.*?)<\/li>/g)].map(match => match[1]);
  assert.equal(rows.length, 4);
  assert.ok(rows[0].includes(`${LOCAL_DRAFT_LIMITS.slots} 个项目/时间线/片段目标槽位`));
  assert.ok(rows[1].includes(`${LOCAL_DELIVERY_LIMITS.slots} 个项目槽位`));
  assert.ok(rows[2].includes(`${LOCAL_SHOT_TEXT_LIMITS.slots} 个项目/镜头槽位`));
  assert.match(rows[3], /最近项目定位：仅保留 1 条位置记录，成功记住新项目会覆盖上一条/);
  assert.doesNotMatch(rows[3], /128|槽位/);
  assert.match(html, /前三类清除草稿后仍保留版本记录并占用槽位/);
});

test('all three actual recovery panels mount their domain disclosure once and preserve existing status regions', () => {
  for (const [domain, html] of Object.entries(rendered.hosts)) {
    assert.equal(html.split(`data-testid="${ids[domain]}"`).length - 1, 1, domain);
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /<details[^>]*\sopen(?:[\s=>])/);
  }
  assert.match(rendered.hosts.clip, /data-testid="clip-draft-status"/);
  assert.match(rendered.hosts.delivery, /data-testid="delivery-draft-status"/);
  assert.match(rendered.hosts['shot-text'], /data-testid="shot-text-draft-status"/);
});

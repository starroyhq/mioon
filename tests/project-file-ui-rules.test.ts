import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES, translate } from '../packages/i18n/src/index.ts';
import type { MessageArguments, MessageKey } from '../packages/i18n/src/index.ts';
import { assertGroupEvidence, escapeHtml, projectFileScenes, tagOf } from './helpers/project-file-ui.ts';

// U1 group 4: project rules (12-12), the notice (12-13) and Mio's change card (12-14).
const ui = await projectFileScenes();
const html = (id: string) => ui.render(id, 'zh-Hans');
const text = <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => escapeHtml(translate('zh-Hans', key, ...args));
const disabled = (tag: string | null) => tag !== null && /\sdisabled=""/u.test(tag);
const busy = (tag: string | null) => tag !== null && /aria-busy="true"/u.test(tag);
const label = (markup: string, testId: string) => new RegExp(`data-testid="${testId}"[^>]*>(?:<span class="wb-spinner" aria-hidden="true"></span>)?([^<]*)<`, 'u').exec(markup)?.[1];

test('every rules scene renders in all four languages', () => {
  const scenes = ui.list.filter(scene => scene.group === 'rules');
  assert.ok(scenes.length >= 18);
  for (const scene of scenes) for (const locale of LOCALES) assert.ok(ui.render(scene.id, locale).length > 200, `${scene.id}/${locale}`);
});

test('12-12 trusted rules: byte count, path, "enabled" and save', () => {
  const page = html('12-12');
  assert.match(tagOf(page, 'pf-rules-count') ?? '', /data-testid="pf-rules-count"/u);
  assert.match(page, /data-testid="pf-rules-count"[^>]*>\d+ \/ 8192 字节</u);
  assert.match(page, /data-testid="pf-rules-path">~\/Movies\/Mioon\/UI 走查项目\/AGENTS\.md</u);
  assert.equal(label(page, 'pf-rules-status'), text('projectFile.rules.enabled'));
  assert.equal(label(page, 'pf-rules-save'), text('projectFile.rules.save'));
  assert.equal(disabled(tagOf(page, 'pf-rules-save')), false);
  assert.equal(tagOf(page, 'pf-rules-enable'), null);
  assert.ok(page.includes(text('projectFile.rules.description', { file: 'AGENTS.md' })));
});

test('12-12 untrusted rules offer "enable", never "enabled"; with edits "save and enable"', () => {
  for (const id of ['12-12-untrusted', '12-12-untrusted-edited']) {
    const page = html(id);
    assert.equal(label(page, 'pf-rules-status'), text('projectFile.rules.notEnabled'), id);
    assert.ok(!page.includes(`>${text('projectFile.rules.enabled')}<`), id);
    assert.ok(page.includes(text('projectFile.rules.untrustedNote')), id);
    assert.equal(tagOf(page, 'pf-rules-save'), null, id);
    assert.equal(disabled(tagOf(page, 'pf-rules-enable')), false, id);
  }
  assert.equal(label(html('12-12-untrusted'), 'pf-rules-enable'), text('projectFile.rules.enable'));
  assert.equal(label(html('12-12-untrusted-edited'), 'pf-rules-enable'), text('projectFile.rules.saveAndEnable'));
});

test('12-12 too long cannot be saved; a new file says where it goes', () => {
  const long = html('12-12-too-long');
  assert.equal(disabled(tagOf(long, 'pf-rules-save')), true);
  assert.match(tagOf(long, 'pf-rules-count') ?? '', /data-over="true"/u);
  assert.ok(long.includes(text('projectFile.rules.tooLong', { limit: 8192 })));
  assert.match(tagOf(long, 'pf-rules-text') ?? '', /aria-invalid="true"/u);
  const fresh = html('12-12-new');
  assert.match(tagOf(fresh, 'pf-rules-text') ?? '', new RegExp(`placeholder="${text('projectFile.rules.placeholder')}"`, 'u'));
  assert.ok(fresh.includes(text('projectFile.rules.newFile', { file: 'AGENTS.md' })));
  assert.equal(tagOf(fresh, 'pf-rules-status'), null);
  assert.equal(disabled(tagOf(fresh, 'pf-rules-save')), true);
});

test('12-12 loading, error, saving, save failed and conflict', () => {
  assert.match(tagOf(html('12-12-loading'), 'pf-rules-loading') ?? '', /role="status"/u);
  assert.equal(disabled(tagOf(html('12-12-loading'), 'pf-rules-save')), true);
  const error = html('12-12-error');
  assert.match(tagOf(error, 'pf-rules-error') ?? '', /role="alert"/u);
  assert.ok(tagOf(error, 'pf-rules-retry'));
  const saving = html('12-12-saving');
  assert.equal(busy(tagOf(saving, 'pf-rules-save')), true);
  assert.match(tagOf(saving, 'pf-rules-text') ?? '', /readOnly=""/u);
  assert.equal(disabled(tagOf(saving, 'pf-rules-discard')), true);
  assert.ok(html('12-12-save-error').includes(text('projectFile.rules.saveFailed')));
  const conflict = html('12-12-conflict');
  assert.ok(conflict.includes(text('projectFile.rules.conflict', { file: 'AGENTS.md' })));
  assert.ok(tagOf(conflict, 'pf-rules-load-latest'));
});

test('12-13 notice: review and later, enabling and enable failed', () => {
  const notice = html('12-13');
  assert.ok(notice.includes(text('projectFile.rules.notice', { file: 'AGENTS.md' })));
  assert.equal(label(notice, 'pf-rules-review'), text('projectFile.rules.review'));
  assert.equal(label(notice, 'pf-rules-later'), text('projectFile.rules.later'));
  const enabling = html('12-13-enabling');
  assert.equal(busy(tagOf(enabling, 'pf-rules-review')), true);
  assert.equal(disabled(tagOf(enabling, 'pf-rules-later')), true);
  const error = html('12-13-error');
  assert.match(tagOf(error, 'pf-rules-notice-error') ?? '', /role="alert"/u);
  assert.equal(disabled(tagOf(error, 'pf-rules-review')), false);
});

test('12-14 change card: section, added and removed lines, the note and the decision', () => {
  const card = html('12-14');
  assert.equal(label(card, 'pf-rules-card-status'), text('projectFile.rules.change.needsConfirm'));
  assert.match(card, /<span>AGENTS\.md<\/span><span data-testid="pf-rules-diff-counts">「做事方式」新增 2 行<\/span>/u);
  assert.equal((card.match(/<li data-kind="add">/gu) ?? []).length, 2);
  assert.ok(card.includes(text('projectFile.rules.change.note')));
  assert.ok(tagOf(card, 'pf-rules-allow') && tagOf(card, 'pf-rules-reject'));
  const mixed = html('12-14-mixed');
  assert.ok(mixed.includes(`${text('projectFile.rules.change.added', { count: 1 })}，${text('projectFile.rules.change.removed', { count: 1 })}`));
  assert.match(mixed, /<li data-kind="remove"><span class="pf-rules-diff-sign" aria-hidden="true">-<\/span>/u);
  const submitting = html('12-14-submitting');
  assert.equal(busy(tagOf(submitting, 'pf-rules-allow')), true);
  assert.equal(disabled(tagOf(submitting, 'pf-rules-reject')), true);
  const error = html('12-14-error');
  assert.ok(error.includes(text('projectFile.rules.change.failed')));
  assert.equal(disabled(tagOf(error, 'pf-rules-allow')), false);
});

test('12-14 allowed and rejected cards show only the outcome, without buttons', () => {
  for (const [id, status, result] of [['12-14-allowed', 'projectFile.rules.change.allowed', 'projectFile.rules.change.allowedResult'], ['12-14-rejected', 'projectFile.rules.change.rejected', 'projectFile.rules.change.rejectedResult']] as const) {
    const card = html(id);
    assert.equal(label(card, 'pf-rules-card-status'), text(status), id);
    assert.ok(card.includes(text(result, { file: 'AGENTS.md' })), id);
    assert.doesNotMatch(card, /<button\b/u, id);
  }
});

test('rules screenshots match the scene table', async () => {
  await assertGroupEvidence('rules');
});

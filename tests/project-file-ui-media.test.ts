import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES, translate } from '../packages/i18n/src/index.ts';
import type { MessageArguments, MessageKey } from '../packages/i18n/src/index.ts';
import type { MediaStatus } from '../packages/contracts/src/media-reference.ts';
import type { MediaStatusReason as L1MediaStatusReason, MediaStatusResult } from '../packages/business/src/media-reference/access.ts';
import { mediaStatusDisplay } from '../apps/web/src/project-file/media-status.ts';
import type { MediaStatusDisplay, MediaStatusReason, MediaStatusView } from '../apps/web/src/project-file/media-status.ts';
import { assertGroupEvidence, escapeHtml, projectFileScenes, tagOf } from './helpers/project-file-ui.ts';

// U1 group 2: media status (12-04), relink (12-05) and outside locations (12-06).

// The web app copies L1's reasons and result fields; these fail to compile when L1 changes them.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const reasonsMatchL1: Same<MediaStatusReason, L1MediaStatusReason> = true;
const viewFitsL1Result = (result: MediaStatusResult): MediaStatusView => result;
void reasonsMatchL1; void viewFitsL1Result;

/** Every status L1's evaluation can give, and what the screens show for it. */
const TABLE: readonly (readonly [MediaStatus, MediaStatusReason, boolean, boolean, MediaStatusDisplay])[] = [
  ['online', 'same-stats', false, true, { kind: 'online' }],
  ['online', 'same-stats', true, true, { kind: 'online' }],
  ['online', 'same-stats', true, false, { kind: 'unconfirmed-found' }],
  ['online', 'same-content', false, true, { kind: 'online' }],
  ['online', 'same-content', true, true, { kind: 'online' }],
  ['changed', 'unverified', true, false, { kind: 'unconfirmed-maybe-changed' }],
  ['changed', 'size', false, true, { kind: 'changed' }],
  ['changed', 'size', true, false, { kind: 'changed' }],
  ['changed', 'content', false, true, { kind: 'changed' }],
  ['changed', 'content', true, true, { kind: 'changed' }],
  ['changed', 'not-media', false, false, { kind: 'changed' }],
  ['changed', 'not-media', true, false, { kind: 'changed' }],
  ['missing', 'not-found', false, false, { kind: 'missing', reason: 'not-found' }],
  ['missing', 'not-found', true, false, { kind: 'missing', reason: 'not-found' }],
  ['missing', 'no-access', true, false, { kind: 'missing', reason: 'no-access' }],
  ['missing', 'not-downloaded', false, false, { kind: 'missing', reason: 'not-downloaded' }],
  ['missing', 'other-platform', true, false, { kind: 'missing', reason: 'other-platform' }],
  ['missing', 'not-a-file', false, false, { kind: 'missing', reason: 'not-a-file' }],
];
const ALL_REASONS = ['same-stats', 'same-content', 'not-found', 'no-access', 'not-downloaded', 'other-platform', 'not-a-file', 'size', 'content', 'not-media', 'unverified'] as const satisfies readonly MediaStatusReason[];
const reasonsListed: [Exclude<MediaStatusReason, typeof ALL_REASONS[number]>] extends [never] ? true : false = true;
void reasonsListed;

test('L1 statuses map to what the screens show, including the two unconfirmed states', () => {
  for (const [status, reason, outside, readable, expected] of TABLE) assert.deepEqual(mediaStatusDisplay({ status, reason, outside, readable }), expected, `${status}/${reason}/${outside}/${readable}`);
  assert.deepEqual([...new Set(TABLE.map(row => row[1]))].sort(), [...ALL_REASONS].sort(), 'every L1 reason has a row');
  // Never "online" while the file may not be read yet, and "unverified" is never a plain change.
  for (const reason of ALL_REASONS) for (const status of ['online', 'changed', 'missing'] as const) for (const outside of [false, true]) {
    const display = mediaStatusDisplay({ status, reason, outside, readable: false });
    if (outside && status === 'online') assert.notEqual(display.kind, 'online', `${status}/${reason}`);
    if (status === 'changed' && reason === 'unverified') assert.equal(display.kind, 'unconfirmed-maybe-changed');
  }
});

const ui = await projectFileScenes();
const html = (id: string) => ui.render(id, 'zh-Hans');
const text = <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => escapeHtml(translate('zh-Hans', key, ...args));
const disabled = (tag: string | null) => tag !== null && /\sdisabled=""/u.test(tag);
const busy = (tag: string | null) => tag !== null && /aria-busy="true"/u.test(tag);

test('every media scene renders in all four languages', () => {
  const scenes = ui.list.filter(scene => scene.group === 'media');
  assert.ok(scenes.length >= 17);
  for (const scene of scenes) for (const locale of LOCALES) {
    const markup = ui.render(scene.id, locale);
    if (scene.id === '12-04-none') assert.equal(markup, '', `${scene.id}/${locale}`);
    else assert.ok(markup.length > 100, `${scene.id}/${locale}`);
  }
});

test('12-04 badges: missing, changed, both unconfirmed states, checking and check failed; none when online', () => {
  const cards = html('12-04-badges');
  const card = (kind: string) => cards.slice(cards.indexOf(`data-testid="fixture-media-${kind}"`)).split('data-testid="fixture-media-')[1] ?? '';
  const badgeIn = (markup: string) => /(<span\b[^>]*\bpf-media-badge\b[^>]*>)(?:<span class="wb-spinner" aria-hidden="true"><\/span>)?([^<]*)</u.exec(markup);
  assert.equal(badgeIn(card('online')), null);
  for (const [kind, tone] of [['missing', 'danger'], ['changed', 'warning'], ['unconfirmed-found', 'neutral'], ['unconfirmed-maybe-changed', 'warning'], ['checking', 'neutral'], ['check-failed', 'warning']] as const) {
    const badge = badgeIn(card(kind));
    assert.ok(badge, kind);
    assert.match(badge[1], new RegExp(`data-tone="${tone}"`, 'u'), kind);
    assert.match(badge[1], new RegExp(`data-media-status="${kind}"`, 'u'), kind);
    assert.equal(badge[2], text(`projectFile.media.badge.${kind}`), kind);
  }
  assert.ok(card('unconfirmed-found').includes(text('projectFile.media.note.unconfirmed-found')));
  assert.ok(card('unconfirmed-maybe-changed').includes(text('projectFile.media.note.unconfirmed-maybe-changed')));
  assert.equal(text('projectFile.media.note.unconfirmed-found'), '找到了，确认后可用');
  assert.equal(text('projectFile.media.note.unconfirmed-maybe-changed'), '可能已变化，确认后核对');
  assert.ok(card('missing').includes(text('projectFile.media.note.missing.not-found')));
});

test('12-04 banner: count and relink, checking, error with retry; nothing when no media need attention', () => {
  const ready = html('12-04-banner');
  assert.ok(ready.includes(text('projectFile.media.attention', { count: 3 })));
  assert.ok(tagOf(ready, 'pf-media-banner-relink'));
  const checking = html('12-04-banner-checking');
  assert.match(tagOf(checking, 'pf-media-banner') ?? '', /role="status"/u);
  assert.equal(tagOf(checking, 'pf-media-banner-relink'), null);
  const error = html('12-04-banner-error');
  assert.match(tagOf(error, 'pf-media-banner') ?? '', /role="alert"/u);
  assert.ok(tagOf(error, 'pf-media-banner-retry'));
  assert.equal(html('12-04-none'), '');
});

test('12-05 relink: found files, the changed file and the missing file get the right buttons', () => {
  const ready = html('12-05');
  assert.ok(ready.includes(text('projectFile.media.relink.foundBy', { name: 'scene-c.mp4', count: 1 })));
  assert.ok(ready.includes(text('projectFile.media.relink.subtitle', { name: 'UI 走查项目', count: 3 })));
  assert.ok(ready.includes(text('projectFile.media.relink.summary', { found: 2, pending: 1 })));
  assert.ok(ready.includes(text('projectFile.media.relink.changedHelp')));
  assert.match(ready, /data-outcome="picked"[\s\S]*你选的位置/u);
  assert.ok(tagOf(ready, 'pf-relink-use-new-d0c0ffee-0000-4000-8000-00000000000d'));
  assert.ok(tagOf(ready, 'pf-relink-choose-d0c0ffee-0000-4000-8000-00000000000d'));
  for (const id of ['00000000000c', '00000000000f']) {
    assert.equal(tagOf(ready, `pf-relink-use-new-d0c0ffee-0000-4000-8000-${id}`), null);
    assert.equal(tagOf(ready, `pf-relink-choose-d0c0ffee-0000-4000-8000-${id}`), null);
  }
  assert.match(ready, /~\/Movies\/Mioon\/UI 走查项目\/素材\/scene-d\.mp4/u);
  const missing = html('12-05-missing');
  assert.ok(tagOf(missing, 'pf-relink-choose-d0c0ffee-0000-4000-8000-000000000010'));
  assert.equal(tagOf(missing, 'pf-relink-use-new-d0c0ffee-0000-4000-8000-000000000010'), null);
  assert.ok(missing.includes(text('projectFile.media.relink.summary', { found: 2, pending: 2 })));
  assert.equal(disabled(tagOf(ready, 'pf-relink-apply')), false);
});

test('12-05 relink states: searching, nothing to do, failed, applying and apply failed', () => {
  const searching = html('12-05-searching');
  assert.match(tagOf(searching, 'pf-relink-searching') ?? '', /role="status"/u);
  assert.equal(disabled(tagOf(searching, 'pf-relink-apply')), true);
  const empty = html('12-05-empty');
  assert.ok(empty.includes(text('projectFile.media.relink.emptyTitle')));
  assert.ok(tagOf(empty, 'pf-relink-close'));
  assert.equal(tagOf(empty, 'pf-relink-apply'), null);
  const error = html('12-05-error');
  assert.match(tagOf(error, 'pf-relink-error') ?? '', /role="alert"/u);
  assert.ok(tagOf(error, 'pf-relink-retry'));
  const applying = html('12-05-applying');
  assert.equal(busy(tagOf(applying, 'pf-relink-apply')), true);
  assert.equal(disabled(tagOf(applying, 'pf-relink-cancel')), true);
  assert.equal(disabled(tagOf(applying, 'pf-relink-use-new-d0c0ffee-0000-4000-8000-00000000000d')), true);
  assert.ok(html('12-05-apply-error').includes(text('projectFile.media.relink.applyFailed')));
});

test('12-06 outside locations: rows, the rules note and the buttons in each state', () => {
  const ready = html('12-06');
  assert.ok(ready.includes(text('projectFile.media.outside.fromAnother')));
  assert.ok(ready.includes(text('projectFile.media.outside.body', { count: 3 })));
  assert.equal((ready.match(/data-testid="pf-outside-row"/gu) ?? []).length, 3);
  assert.match(ready, /data-available="false"[^>]*>[\s\S]*?这台电脑上没有这个位置[\s\S]*?找不到/u);
  assert.match(ready, /~\/Music\/配乐/u);
  assert.ok(ready.includes(text('projectFile.media.outside.rules', { file: 'AGENTS.md' })));
  assert.ok(tagOf(ready, 'pf-outside-open') && tagOf(ready, 'pf-outside-allow'));
  assert.equal(tagOf(html('12-06-no-rules-note'), 'pf-outside-rules'), null);
  const loading = html('12-06-loading');
  assert.match(tagOf(loading, 'pf-outside-loading') ?? '', /role="status"/u);
  assert.equal(disabled(tagOf(loading, 'pf-outside-allow')), true);
  const empty = html('12-06-empty');
  assert.ok(empty.includes(text('projectFile.media.outside.emptyBody')));
  assert.match(empty, /data-testid="pf-outside-open"[^>]*>打开</u);
  assert.equal(tagOf(empty, 'pf-outside-allow'), null);
  const error = html('12-06-error');
  assert.match(tagOf(error, 'pf-outside-error') ?? '', /role="alert"/u);
  assert.ok(tagOf(error, 'pf-outside-retry'));
  assert.match(error, /data-testid="pf-outside-open"[^>]*>只打开项目</u);
  assert.equal(tagOf(error, 'pf-outside-allow'), null);
  const allowing = html('12-06-allowing');
  assert.equal(busy(tagOf(allowing, 'pf-outside-allow')), true);
  assert.equal(disabled(tagOf(allowing, 'pf-outside-open')), true);
});

test('media screenshots match the scene table', async () => {
  await assertGroupEvidence('media');
});

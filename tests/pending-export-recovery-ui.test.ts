import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {LOCALES, translate} from '../packages/i18n/src/index.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = (file: string): string => readFileSync(path.join(root, file), 'utf8');
const app = source('apps/web/src/App.tsx'), preflight = source('apps/web/src/TimelineExportPreflight.tsx');
const recovery = source('apps/web/src/DeliveryDraftRecovery.tsx');

test('step 1 owns the pending-export choice and no longer points at an unreachable step-2 recovery', () => {
  for (const fragment of ['export-pending-recovery', 'continue-pending-export', 'discard-pending-export', 'retry-pending-export',
    "t('export.pending.continue')", "t('export.pending.discard')", "t('export.pending.retry')", "t('export.pending.notStarted')",
    "t('export.pending.timelineChanged')", "t('export.pending.unavailable')"]) assert.ok(preflight.includes(fragment), fragment);
  assert.ok(preflight.indexOf('{pendingBanner}') < preflight.indexOf('export-check-result'));
  assert.ok(app.includes('controller.checkIntent()'));
  assert.ok(app.includes('controller.discardIntent()'));
  assert.ok(app.includes('await localDeliveryRef.current!.controller.recover(token)'));
  assert.doesNotMatch(recovery, /if\(?original\?\.outcome\.status === 'pending'\)?/u);
  assert.doesNotMatch(preflight, /export\.preflight\.pending/);
});

test('four-locale pending copy uses plain product language', () => {
  for (const locale of LOCALES) {
    for (const key of ['export.pending.notStarted', 'export.pending.notExecuted', 'export.pending.continue',
      'export.pending.discard', 'export.pending.timelineChanged', 'export.pending.unavailable', 'export.pending.retry',
      'export.pending.reasonConflict', 'export.pending.reasonBlocked', 'export.pending.reasonGeneric'] as const) {
      const text = translate(locale, key, {reason: 'x'} as never);
      assert.ok(text.length > 0, `${locale}:${key}`);
      assert.doesNotMatch(text, /请求|請求|还原入口|還原入口|重送|核对同一请求|核對同一請求|リクエスト/u, `${locale}:${key}`);
    }
  }
});

test('the production dialog wires automatic check, continue, discard and the failed-record reexport', () => {
  for (const fragment of ['runPendingExportCheck', 'pendingExportCheckFlight', 'setPendingExportCheck',
    'pendingExportCheck={pendingExportCheck}', 'onContinuePending=', 'onDiscardPending=', 'onRetryPending=',
    "setDeliveryAttempt({projectId, id: after.intent.outcome.exportId})", "intent?.outcome.status === 'accepted'",
    "setDeliveryAttempt({projectId, id: intent.outcome.exportId})"]) assert.ok(app.includes(fragment), fragment);
  // A settled pending intent no longer freezes the history re-export button.
  assert.match(app, /reexportDisabled=\{!timeline\?\.clips\.length \|\| pendingTimelineExport/u);
  assert.match(app, /const pendingTimelineExport = activePending\.some\(entry => entry\.key === 'timeline:render:export'\) \|\| \(localDelivery\.state\.pending\)/u);
});

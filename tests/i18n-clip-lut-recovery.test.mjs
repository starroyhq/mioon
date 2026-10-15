import test from 'node:test';
import assert from 'node:assert/strict';
import { createClipLutRecovery, ClipLutRecoveryError } from '../apps/web/src/clip-lut-recovery.ts';
const identity = { workspaceScope: 'a'.repeat(64), projectId: '90000000-0000-4000-8000-000000000001' };
test('LUT recovery preserves application-owned error codes, independent of diagnostic language', async () => {
  for (const text of ['Storage changed', '復元記録が変更されました', '']) {
    const original = new ClipLutRecoveryError('LUT_RECOVERY_CONFLICT', text);
    const recovery = createClipLutRecovery({ lock: async () => { throw original; } });
    await assert.rejects(recovery.read(identity), error => error === original && error.code === 'LUT_RECOVERY_CONFLICT');
  }
});
test('LUT-like text from an arbitrary storage error cannot impersonate a recovery error', async () => {
  for (const text of ['LUT external storage failed', '无法安全 external storage failed', 'Storage denied']) {
    const recovery = createClipLutRecovery({ lock: async () => { throw new Error(text); } });
    await assert.rejects(recovery.read(identity), error => error instanceof ClipLutRecoveryError && error.code === 'LUT_RECOVERY_UNAVAILABLE');
  }
});

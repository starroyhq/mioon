import { clickWorkbenchAction } from './browser-workbench-actions.mjs';
/** Supported own-cloud CUA acceptance against the ordinary authenticated server.
 * No renderer mocks, new provider POSTs, browser security changes or real keys.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { openStore } from '../packages/business/src/db.mjs';
export async function runRunwayParityBrowserAcceptance({ tab, runtime, outDir }) {
  assert.ok(path.resolve(runtime).endsWith('/evidence/q1-runway-parity/runtime'));
  await mkdir(outDir, { recursive: true });
  const fixture = JSON.parse(await readFile(path.join(runtime, 'fixture.json'), 'utf8'));
  const server = JSON.parse(await readFile(path.join(runtime, 'server.json'), 'utf8'));
  assert.equal(new URL(server.url).hostname, '127.0.0.1');
  const report = { startedAt: new Date().toISOString(), source: fixture.source, browser: 'Own-cloud CUA Chromium; unchanged sandbox', checks: [], screenshots: [] };
  const record = (name, details = {}) => report.checks.push({ name, passed: true, ...details });
  const capture = async name => { await writeFile(path.join(outDir, name), await tab.screenshot({ fullPage: true })); report.screenshots.push(name); };
  const store = openStore(path.join(runtime, 'workspace'), { lock: false });
  try {
    await clickWorkbenchAction(tab, 'jobs-button');
    const job = tab.playwright.getByTestId(`job-${fixture.jobId}`);
    await job.waitFor({ state: 'visible', timeoutMs: 10000 });
    assert.match(await job.innerText(), /服务商可能已接受任务并计费/);
    assert.match(await job.innerText(), /提交 1 次/);
    assert.equal(await tab.playwright.getByTestId(`retry-job-${fixture.jobId}`).count(), 0);
    record('Actual HTTP 409 worker result renders unknown acceptance, charge warning and no retry action');
    await capture('01-http409-unknown-no-retry.jpg');
    const http = JSON.parse(await readFile(path.join(runtime, 'http-checks.json'), 'utf8'));
    assert.equal(http.jobId, fixture.jobId); assert.equal(http.retry.status, 409); assert.equal(http.retry.code, 'UNSAFE_RETRY');
    record('Authenticated ordinary HTTP job.retry refuses a new request ID (host-runtime check)', http.retry);
    await tab.playwright.getByTestId(`reconcile-job-${fixture.jobId}`).click();
    await tab.playwright.getByText('已核对已有任务状态，没有重新提交生成', { exact: true }).waitFor({ state: 'visible', timeoutMs: 10000 });
    const jobs = store.list('jobs', fixture.projectId);
    assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'submission_unknown'); assert.equal(jobs[0].submissionCount, 1);
    assert.equal(jobs[0].providerJobId, null);
    assert.equal(await tab.playwright.getByTestId(`retry-job-${fixture.jobId}`).count(), 0);
    record('UI reconciliation retains one unknown job and one original POST, no new generation');
    await capture('02-reconciled-still-unknown.jpg');
    await tab.reload(); await tab.playwright.getByTestId('workbench-actions').waitFor({ state: 'visible', timeoutMs: 10000 });
    await clickWorkbenchAction(tab, 'jobs-button'); await job.waitFor({ state: 'visible', timeoutMs: 10000 });
    assert.match(await job.innerText(), /提交 1 次/); assert.equal(await tab.playwright.getByTestId(`retry-job-${fixture.jobId}`).count(), 0);
    assert.equal(http.allLiveDisabled, true);
    record('Reload preserves the warning; all live providers remain disabled in the browser runtime');
    await capture('03-reload-preserves-unknown.jpg');
    report.result = 'passed'; report.jobId = fixture.jobId; report.projectId = fixture.projectId;
  } catch (error) { report.result = 'failed'; report.error = String(error.stack || error); try { await capture('failure.jpg'); } catch {} throw error; }
  finally { store.close(); report.finishedAt = new Date().toISOString(); await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2)); }
  return report;
}

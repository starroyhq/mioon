// Product-path project opening for the Windows packaged checks. The launcher
// home owns the one-use renderer permit, so driving its real open button is the
// only way to open a registered project without weakening the sealed entry.
import assert from 'node:assert/strict';
import type {BrowserWindow} from 'electron';
import {BrowserWindow as BrowserWindowRuntime} from 'electron';

export const waitForWindowCondition = async (window: BrowserWindow, check: () => Promise<boolean>, timeoutMs: number, message: string, code: string): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (window.isDestroyed()) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Object.assign(new Error(message), {code});
};
const evaluate = (window: BrowserWindow, script: string): Promise<unknown> => window.webContents.executeJavaScript(script, true);
const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const openButton = (projectId: string): string => {
  const id = projectId.replace(/[^0-9a-f-]/gu, '');
  // The launcher home renders the recent-project catalog (pf-card-open); the
  // dialog surface keeps the project-home-open prefix.
  return `[data-testid="pf-card-open-${id}"],[data-testid="project-home-open-${id}"]`;
};
/** Refreshes the launcher home and clicks the project's real open button. */
export async function openRegisteredProject(launcher: BrowserWindow, backendUrl: string, projectId: string,
  onStep: (step: 'home' | 'list' | 'window' | 'workbench') => Promise<void> = async () => {}): Promise<BrowserWindow> {
  assert.ok(launcher && !launcher.isDestroyed(), 'The launcher window must be live');
  assert.match(backendUrl, /^https?:\/\/127\.0\.0\.1:\d+$/u);
  try { launcher.show(); launcher.focus(); } catch { /* Best effort in CI sessions. */ }
  const button = openButton(projectId);
  await waitForWindowCondition(launcher, async () => Boolean(await evaluate(launcher,
    `Boolean(document.querySelector('[data-testid="project-home"]'))`).catch(() => false)), 60000, 'The launcher home did not become ready', 'PROJECT_OPEN_HOME_TIMEOUT');
  await onStep('home');
  const homeTitle = `[data-testid="project-home"]`;
  const pageLink = (id: string): string => `[data-testid="launcher-nav-${id}"]`;
  const cardReady = async (): Promise<boolean> => Boolean(await evaluate(launcher, `(() => {
    const target = document.querySelector(${JSON.stringify(button)});
    return target instanceof HTMLElement && !target.matches(':disabled');
  })()`));
  const reloadLauncher = async (): Promise<void> => {
    const loaded = new Promise<void>(resolve => launcher.webContents.once('did-finish-load', () => resolve()));
    launcher.webContents.reload();
    await Promise.race([loaded, new Promise<void>(resolve => setTimeout(resolve, 30000))]);
    await waitForWindowCondition(launcher, async () => Boolean(await evaluate(launcher,
      `Boolean(document.querySelector(${JSON.stringify(homeTitle)}))`).catch(() => false)), 60000,
      'The launcher home did not reload', 'PROJECT_OPEN_HOME_TIMEOUT');
    await onStep('home');
  };
  let ready = false;
  for (let attempt = 0; attempt < 4 && !ready; attempt += 1) {
    if (attempt === 1) await reloadLauncher();
    if (attempt === 3) {
      // The launcher's own refresh lives on the help page; use that product path
      // after a plain reload has not shown a project created outside the UI.
      await evaluate(launcher, `(() => { const nav = document.querySelector(${JSON.stringify(pageLink('help'))}); if (nav instanceof HTMLElement) nav.click(); return true; })()`);
      await waitForWindowCondition(launcher, async () => Boolean(await evaluate(launcher,
        `Boolean(document.querySelector('[data-testid="launcher-help"]'))`).catch(() => false)), 20000,
        'The launcher help page did not open', 'PROJECT_OPEN_LIST_TIMEOUT');
      await evaluate(launcher, `(() => { const refresh = document.querySelector('[data-testid="launcher-help-refresh"]'); if (refresh instanceof HTMLElement) refresh.click(); return true; })()`);
      await evaluate(launcher, `(() => { const nav = document.querySelector(${JSON.stringify(pageLink('projects'))}); if (nav instanceof HTMLElement) nav.click(); return true; })()`);
    }
    try { await waitForWindowCondition(launcher, cardReady, attempt === 1 ? 30000 : 15000, 'The launcher home did not list the new project', 'PROJECT_OPEN_LIST_TIMEOUT'); ready = true; }
    catch { if (attempt === 3) break; }
  }
  if (!ready) {
    const diagnostic = record(await evaluate(launcher, `(async () => {
      const cards = document.querySelectorAll('[data-testid^="pf-card-open-"],[data-testid^="project-home-open-"]');
      const target = document.querySelector(${JSON.stringify(button)});
      let bridge = null;
      try { const recent = await window.__mioonProjectEntries.listRecent();
        bridge = {count: recent.registered.length, has: recent.registered.some(value => value.project.projectId === ${JSON.stringify(projectId)})}; }
      catch { bridge = {count: -1, has: false}; }
      return {home: Boolean(document.querySelector('[data-testid="project-home"]')), cards: cards.length,
        has: Boolean(target), disabled: target instanceof HTMLElement ? target.matches(':disabled') : null, bridge};
    })()`) as unknown);
    const bridge = record(record(diagnostic).bridge);
    const has = record(diagnostic).has === true, bridgeHas = bridge.has === true, count = Number(bridge.count);
    throw Object.assign(new Error('The launcher home did not list the new project'), {
      code: has ? 'PROJECT_OPEN_LIST_DISABLED' : bridgeHas ? 'PROJECT_OPEN_LIST_STALE' : count === 0 ? 'PROJECT_OPEN_LIST_EMPTY' : 'PROJECT_OPEN_LIST_MISSING',
    });
  }
  await onStep('list');
  const clicked = await evaluate(launcher, `(() => {
    const button = document.querySelector(${JSON.stringify(button)});
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, 'The launcher project open button was unavailable');
  const expectedUrl = new URL(`/?project=${projectId}`, backendUrl).href;
  await waitForWindowCondition(launcher, async () => Promise.resolve(BrowserWindowRuntime.getAllWindows()
    .some(window => !window.isDestroyed() && window.webContents.getURL() === expectedUrl)),
  30000, 'The project window did not open', 'PROJECT_OPEN_WINDOW_TIMEOUT');
  await onStep('window');
  const editor = BrowserWindowRuntime.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL() === expectedUrl);
  assert.ok(editor, 'The project window was not found');
  await waitForWindowCondition(editor, async () => Boolean(await evaluate(editor,
    `Boolean(document.querySelector('[data-testid="workbench"]'))`).catch(() => false)), 60000,
    'The project workbench did not become ready', 'PROJECT_OPEN_WORKBENCH_TIMEOUT');
  await onStep('workbench');
  return editor;
}

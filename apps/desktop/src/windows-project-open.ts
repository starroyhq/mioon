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
/** A renderer that never finishes loading must not hang the whole check: each
 * DOM read is bounded and treated as "not ready" so the caller reports its own
 * fixed timeout code instead of the outer app timeout. */
const evaluateBounded = async (window: BrowserWindow, script: string, timeoutMs = 5000): Promise<unknown> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      evaluate(window, script),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Renderer read timed out'), {code: 'PROJECT_OPEN_EVALUATE_TIMEOUT'})), timeoutMs); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
};
const rendererBoolean = async (window: BrowserWindow, script: string): Promise<boolean> => {
  try { return Boolean(await evaluateBounded(window, script)); } catch { return false; }
};
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
  await waitForWindowCondition(launcher, () => rendererBoolean(launcher,
    `Boolean(document.querySelector('[data-testid="project-home"]'))`), 60000, 'The launcher home did not become ready', 'PROJECT_OPEN_HOME_TIMEOUT');
  await onStep('home');
  const homeTitle = `[data-testid="project-home"]`;
  const pageLink = (id: string): string => `[data-testid="launcher-nav-${id}"]`;
  const cardReady = async (): Promise<boolean> => rendererBoolean(launcher, `(() => {
    const target = document.querySelector(${JSON.stringify(button)});
    return target instanceof HTMLElement && !target.matches(':disabled');
  })()`);
  const reloadLauncher = async (): Promise<void> => {
    const loaded = new Promise<void>(resolve => launcher.webContents.once('did-finish-load', () => resolve()));
    launcher.webContents.reload();
    await Promise.race([loaded, new Promise<void>(resolve => setTimeout(resolve, 30000))]);
    await waitForWindowCondition(launcher, () => rendererBoolean(launcher,
      `Boolean(document.querySelector(${JSON.stringify(homeTitle)}))`), 60000,
      'The launcher home did not reload', 'PROJECT_OPEN_HOME_TIMEOUT');
    await onStep('home');
  };
  // A launcher home fetched before this RPC-created project cannot list it;
  // reload once up front, then fall back to the help-page refresh path.
  await reloadLauncher();
  let ready = false;
  for (let attempt = 0; attempt < 3 && !ready; attempt += 1) {
    if (attempt === 1) await reloadLauncher();
    if (attempt === 2) {
      // The launcher's own refresh lives on the help page; use that product path
      // after plain reloads have not shown a project created outside the UI.
      await evaluate(launcher, `(() => { const nav = document.querySelector(${JSON.stringify(pageLink('help'))}); if (nav instanceof HTMLElement) nav.click(); return true; })()`);
      await waitForWindowCondition(launcher, () => rendererBoolean(launcher,
        `Boolean(document.querySelector('[data-testid="launcher-help"]'))`), 20000,
        'The launcher help page did not open', 'PROJECT_OPEN_LIST_TIMEOUT');
      await evaluate(launcher, `(() => { const refresh = document.querySelector('[data-testid="launcher-help-refresh"]'); if (refresh instanceof HTMLElement) refresh.click(); return true; })()`);
      await evaluate(launcher, `(() => { const nav = document.querySelector(${JSON.stringify(pageLink('projects'))}); if (nav instanceof HTMLElement) nav.click(); return true; })()`);
    }
    try { await waitForWindowCondition(launcher, cardReady, 25000, 'The launcher home did not list the new project', 'PROJECT_OPEN_LIST_TIMEOUT'); ready = true; }
    catch { if (attempt === 2) break; }
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
  // The launcher home can re-render between the readiness probe and the click
  // (async recent-list refresh); retry the same exact button within a bounded
  // window instead of failing on one transiently detached element.
  let clicked = false;
  const clickDeadline = Date.now() + 10000;
  while (!clicked && Date.now() < clickDeadline) {
    try {
      clicked = await evaluate(launcher, `(() => {
        const button = document.querySelector(${JSON.stringify(button)});
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()`) as boolean;
    } catch { clicked = false; }
    if (!clicked) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(clicked, true, 'The launcher project open button was unavailable');
  const expectedUrl = new URL(`/?project=${projectId}`, backendUrl).href;
  await waitForWindowCondition(launcher, async () => Promise.resolve(BrowserWindowRuntime.getAllWindows()
    .some(window => !window.isDestroyed() && window.webContents.getURL() === expectedUrl)),
  30000, 'The project window did not open', 'PROJECT_OPEN_WINDOW_TIMEOUT');
  await onStep('window');
  const editor = BrowserWindowRuntime.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL() === expectedUrl);
  assert.ok(editor, 'The project window was not found');
  try {
    await waitForWindowCondition(editor, () => rendererBoolean(editor,
      `Boolean(document.querySelector('[data-testid="workbench"]'))`), 60000,
      'The project workbench did not become ready', 'PROJECT_OPEN_WORKBENCH_TIMEOUT');
  } catch (error) {
    // Bounded DOM evidence only: a fixed surface name, never page text.
    const surface = String(await evaluateBounded(editor, `(() => {
      if (document.querySelector('[data-testid="workbench"]')) return 'workbench';
      if (document.querySelector('[role="alert"]')) return 'alert';
      if (document.querySelector('[data-testid="project-home"]')) return 'launcher-home';
      if (document.querySelector('[data-testid="project-home-create-form"]')) return 'create-form';
      return 'blank:' + document.readyState;
    })()`, 3000).catch(() => 'unreadable'));
    const code = surface === 'workbench' ? 'PROJECT_OPEN_WORKBENCH_TIMEOUT'
      : surface === 'alert' ? 'PROJECT_OPEN_WORKBENCH_ALERT'
      : surface === 'unreadable' ? 'PROJECT_OPEN_WORKBENCH_UNREADABLE' : 'PROJECT_OPEN_WORKBENCH_BLANK';
    throw Object.assign(new Error('The project workbench did not become ready'), {code, surface});
  }
  await onStep('workbench');
  return editor;
}

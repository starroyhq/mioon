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
const openButton = (projectId: string): string => `[data-testid="project-home-open-${projectId.replace(/[^0-9a-f-]/gu, '')}"]`;
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await evaluate(launcher, `(() => {
      const refresh = document.querySelector('[data-testid="launcher-help-refresh"],[data-testid="project-home-refresh"]');
      if (refresh instanceof HTMLElement) refresh.click();
      return true;
    })()`);
    try {
      await waitForWindowCondition(launcher, async () => Boolean(await evaluate(launcher,
        `(() => { const button = document.querySelector(${JSON.stringify(button)}); return button instanceof HTMLElement && !button.matches(':disabled'); })()`)),
        20000, 'The launcher home did not list the new project', 'PROJECT_OPEN_LIST_TIMEOUT');
      await onStep('list');
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      // A home list created before this project cannot know it yet; reload the
      // real launcher page and retry against its own catalog fetch.
      launcher.webContents.reload();
      await waitForWindowCondition(launcher, async () => Boolean(await evaluate(launcher,
        `Boolean(document.querySelector('[data-testid="project-home"]'))`).catch(() => false)), 60000, 'The launcher home did not reload', 'PROJECT_OPEN_HOME_TIMEOUT');
    }
  }
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
    `Boolean(document.querySelector('[data-testid="workbench"]'))`).catch(() => false)), 60000, 'The project workbench did not become ready', 'PROJECT_OPEN_WORKBENCH_TIMEOUT');
  await onStep('workbench');
  return editor;
}

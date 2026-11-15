/** Real browser regression. Open an isolated format-4 project with at least one
 * live card and one archived item. Run with an existing Playwright page:
 *   pnpm test:browser:canvas-archive --session <playwright-cli-session>
 * With no arguments, print the function for use with an existing runner.
 */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {testEnv} from './helpers/test-env.ts';

export async function runCanvasArchiveEscape(page) {
  const board = page.getByTestId('canvas-drop-zone');
  const selected = board.locator('.react-flow__node.selected');
  const selectedIds = () => selected.evaluateAll(nodes => nodes.map(node => node.dataset.id).sort());
  const trigger = page.getByTestId('canvas-archive-trigger');
  const popover = page.getByTestId('canvas-archive-popover');
  await board.locator('.react-flow__node-shot .node-title').first().click();
  const before = await selectedIds();
  if (!before.length) throw new Error('Select a live card in the format-4 fixture first');

  for (const fromTrigger of [false, true]) {
    await trigger.press('Enter');
    await popover.waitFor({state: 'visible'});
    const from = fromTrigger ? trigger : popover.locator('[data-testid^="canvas-restore-"]:not([data-testid="canvas-restore-all"])').first();
    await from.focus();
    if (!await from.evaluate(element => document.activeElement === element)) throw new Error('Archive Escape target did not receive focus');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => {
      const trigger = document.querySelector('[data-testid="canvas-archive-trigger"]');
      return trigger?.getAttribute('aria-expanded') === 'false' && document.activeElement === trigger;
    });
    if (JSON.stringify(await selectedIds()) !== JSON.stringify(before)) {
      throw new Error(`Archive Escape changed the selection when focus started at the ${fromTrigger ? 'trigger' : 'popup'}`);
    }
  }

  await popover.waitFor({state: 'hidden'});
  await page.keyboard.press('Escape');
  await selected.first().waitFor({state: 'detached'});
  return {archiveEscapeFromPopup: true, archiveEscapeFromTrigger: true, canvasEscapeClearsSelection: true};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , option, session, ...extra] = process.argv;
  const source = runCanvasArchiveEscape.toString();
  if (!option) console.log(source);
  else {
    if (option !== '--session' || !session || extra.length) throw new Error('Expected --session <playwright-cli-session>');
    const result = spawnSync('playwright-cli', [`-s=${session}`, 'run-code', source], {encoding: 'utf8', env: testEnv()});
    if (result.error) throw result.error;
    const outcome = /^### Result\r?\n(.*)$/um.exec(result.stdout)?.[1];
    if (result.status !== 0 || !outcome) throw new Error(result.stderr || result.stdout || 'Archive Escape browser regression failed');
    console.log(outcome);
  }
}

/** Real-App browser regression. Run with a Playwright page against a disposable
 * project, e.g. runSaveVersionDialogAcceptance(page, {url, projectId, locale:'zh-Hant'}).
 * Uses production menus, portals and history runtime; never stubs Dialog. */
import {translate} from '../packages/i18n/src/index.ts';

export async function runSaveVersionDialogAcceptance(page, {url, projectId, locale = 'zh-Hant', messages}) {
  const text = messages ?? {
    title: translate(locale, 'projectHistory.save.title'),
    name: translate(locale, 'projectHistory.save.name'),
    save: translate(locale, 'projectFile.menu.saveVersion'),
    saved: translate(locale, 'projectHistory.saved'),
  };
  const equal = (actual, expected, message = 'Browser assertion failed') => {
    if (!Object.is(actual, expected)) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const {title, name: nameLabel} = text;
  const result = {checks: []};
  for (const entry of ['menu', 'history']) {
    await page.goto(url);
    await page.getByTestId(`pf-card-open-${projectId}`).click();
    await page.getByTestId('project-switcher').click();
    await page.getByTestId(entry === 'menu' ? 'project-menu-save-version' : 'project-menu-history').click();
    if (entry === 'history') {
      await page.getByTestId('pf-versions-dialog')
        .getByRole('button', {name: text.save, exact: true}).click();
    }
    // Hidden ancestors are deliberately not included by these role queries.
    const input = page.getByRole('textbox', {name: nameLabel, exact: true});
    await input.waitFor({state: 'visible', timeout: 5000});
    const dialog = page.getByRole('dialog').filter({has: input}).last();
    equal(await dialog.count(), 1, `${entry}: accessible save dialog`);
    const submit = dialog.getByRole('button', {name: title, exact: true});
    equal(await input.count(), 1, `${entry}: accessible named textbox`);
    equal(await submit.count(), 1, `${entry}: accessible submit button`);
    equal(await dialog.evaluate(node => node.closest('[aria-hidden="true"], [inert]') === null), true);
    await input.fill(`P02 ${entry} regression`);
    if (entry === 'menu') await input.press('Escape');
    else await submit.click();
    await dialog.waitFor({state: 'hidden', timeout: 10000});
    await page.getByTestId('pf-versions-dialog').waitFor({state: 'visible'});
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'pf-versions-save', null, {timeout: 5000});
    const save = page.getByRole('button', {name: text.save, exact: true});
    equal(await save.evaluate(node => node === document.activeElement), true, `${entry}: focus returns to the history save action`);
    if (entry === 'history') equal(await page.getByText(text.saved, {exact: true}).count(), 1);
    result.checks.push({entry, accessibleDialog: true, accessibleTextbox: true, accessibleSubmit: true,
      closedBy: entry === 'menu' ? 'Escape' : 'confirmed save', focus: 'pf-versions-save'});
  }
  return result;
}

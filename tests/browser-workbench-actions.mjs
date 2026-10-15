/** UI-only action-menu adapter. This does not start an app or change QA fixtures. */
export async function workbenchAction(tab, testId) {
  const action = tab.playwright.getByTestId(testId);
  if (!await action.isVisible()) await tab.playwright.getByTestId('workbench-actions').click();
  return action;
}
export async function clickWorkbenchAction(tab, testId) {
  await (await workbenchAction(tab, testId)).click();
}

/** UI-only entry adapter. Opening menus/popovers never submits work. */
export async function workbenchAction(tab, testId) {
  if (testId === 'jobs-button') {
    const all = tab.playwright.getByTestId('task-overview-all');
    if (!await all.isVisible()) await tab.playwright.getByTestId('jobs-button').click();
    return all;
  }
  const action = tab.playwright.getByTestId(testId);
  if (await action.isVisible()) return action;
  if (['export-button', 'timeline-format-open'].includes(testId)) await tab.playwright.getByTestId('project-switcher').click();
  else if (['add-video-track', 'add-audio-track', 'seed-timeline', 'timeline-render-preview'].includes(testId)) await tab.playwright.getByRole('button', {name: '轨道', exact: true}).click();
  else if (testId === 'export-timeline' || testId === 'export-history') {
    const exportButton = tab.playwright.getByTestId('export-timeline');
    if (!await exportButton.isVisible()) await tab.playwright.getByTestId('workspace-editing').click();
    if (testId === 'export-history') await exportButton.click();
  } else await tab.playwright.getByTestId('workbench-actions').click();
  return action;
}
export async function clickWorkbenchAction(tab, testId) {
  await (await workbenchAction(tab, testId)).click();
}

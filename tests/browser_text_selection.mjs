/** Run with a real Playwright page on a disposable, authenticated project.
 * Seed one text node through the normal local service first. No model calls,
 * DOM state injection or business mocks are used. Clipboard reads follow a
 * synthetic write, so the user's pre-existing clipboard is never inspected. */
export async function runTextSelectionAcceptance({page, noteId, noteText}) {
  const check = (value, message) => {if (!value) throw Error(message);};
  const node = page.getByTestId(`text-node-${noteId}`);
  const body = node.getByText(noteText, {exact: true});
  await body.waitFor({state: 'visible'});
  const start = page.getByTestId('canvas-drop-zone').getByTestId('agent-editing-start');
  if (await start.isVisible()) await start.click();
  await page.locator(`.react-flow__node[data-id="${noteId}"].draggable`).waitFor();
  const geometry = element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const rect = range.getClientRects()[0];
    return {x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      node: element.closest('.react-flow__node').style.transform,
      viewport: element.closest('.react-flow__viewport').style.transform,
      selectable: getComputedStyle(element).userSelect};
  };
  const before = await body.evaluate(geometry);
  check(before.selectable === 'text', 'The authored note must allow text selection');
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.mouse.move(before.x + 1, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width - 1, before.y + before.height / 2, {steps: 15});
  await page.mouse.up();
  const selected = await page.evaluate(() => getSelection().toString());
  const after = await body.evaluate(geometry);
  check(selected.length > 0 && noteText.includes(selected), 'Mouse drag must select authored text');
  check(after.node === before.node && after.viewport === before.viewport, 'Selecting text must move neither node nor canvas');

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {origin: new URL(page.url()).origin});
  await page.evaluate(() => navigator.clipboard.writeText('text-selection-disposable-sentinel'));
  await page.keyboard.press('ControlOrMeta+c');
  check(await page.evaluate(() => navigator.clipboard.readText()) === selected, 'Native Copy must preserve the text selection');

  await body.click();
  const editor = page.locator('#node-text');
  await editor.click(); await page.keyboard.press('ControlOrMeta+a');
  const input = await editor.evaluate(element => ({value: element.value, start: element.selectionStart, end: element.selectionEnd}));
  check(input.value === noteText && input.start === 0 && input.end === noteText.length, 'Native Select All must remain scoped to the editor');
  await page.keyboard.press('ControlOrMeta+c');
  check(await page.evaluate(() => navigator.clipboard.readText()) === noteText, 'Native editor Copy must remain available');
  // Native input selections can remain visible while a drag deliberately keeps
  // focus in the editor. Collapse this test's selection before checking chrome.
  await editor.press('ArrowRight');

  const header = node.locator('.node-header');
  const headerBefore = await header.evaluate(geometry);
  check(headerBefore.selectable === 'none', 'Node interaction chrome must not select text');
  const rect = await header.boundingBox();
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + 60, rect.y + rect.height / 2 + 25, {steps: 12});
  await page.mouse.up();
  const headerAfter = await header.evaluate(geometry);
  check(headerAfter.node !== headerBefore.node && headerAfter.viewport === headerBefore.viewport, 'Header dragging must still move the node without panning');
  check(await page.evaluate(() => getSelection().toString()) === '', 'Header dragging must not select chrome text');
  return {noteSelection: true, selectionDoesNotMoveNodeOrCanvas: true, nativeCopy: true, nativeEditorSelectionAndCopy: true, headerDrag: true};
}

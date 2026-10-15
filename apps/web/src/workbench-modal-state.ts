/** A retained, closed settings popup is still in the DOM. Only a reachable
 * modal blocks editing shortcuts; open confirmation dialogs remain blockers. */
export function hasOpenWorkbenchModal(root: Pick<ParentNode, 'querySelectorAll'>): boolean {
  return Array.from(root.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]'))
    .some(dialog => !dialog.closest('[hidden], [inert], [data-closed], [aria-hidden="true"]'));
}

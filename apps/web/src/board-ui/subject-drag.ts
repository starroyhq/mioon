/** HTML5 drag payload from the subject library to the format-5 board. */
export const SUBJECT_DRAG = 'application/x-workbench-subject';
export function dragSubject(event: DragEvent, subjectId: string): void {
  event.dataTransfer?.setData(SUBJECT_DRAG, subjectId);
  event.dataTransfer?.setData('text/plain', subjectId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
}
export function droppedSubject(event: DragEvent): string | null {
  const subjectId = event.dataTransfer?.getData(SUBJECT_DRAG) ?? '';
  return subjectId.length ? subjectId : null;
}

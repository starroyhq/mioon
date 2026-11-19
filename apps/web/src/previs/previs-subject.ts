import type {SubjectResponse} from '../../../../packages/contracts/src/subjects.ts';

// Format 5 lets a mannequin or a prop stand for a subject. The previs editor
// shows the project's subjects from the one subject controller the workbench
// already loads (`useSubjects`); nothing here reads subjects itself.
export interface PrevisSubjectChoice {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly headVersionId: string;
  readonly headVersionNumber: number;
}

/** The subject dropdown entries of one project, by name. A subject is offered
 * with its current head version: choosing "follow" tracks that head, choosing
 * "lock" pins the version shown here. */
export function previsSubjectChoices(subjects: Readonly<Record<string, SubjectResponse>> | null | undefined): PrevisSubjectChoice[] {
  if (!subjects) return [];
  return Object.values(subjects).map(subject => ({id: subject.id, name: subject.name, kind: subject.kind,
    headVersionId: subject.headVersionId, headVersionNumber: subject.headVersion.number}))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

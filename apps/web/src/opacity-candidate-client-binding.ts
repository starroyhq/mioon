interface Validation {readonly isTaskEnvelope: (value: unknown) => boolean; readonly isTaskList: (value: unknown) => boolean; readonly isWorkspaceInspection?: (value: unknown) => boolean}
const bindings = new WeakMap<object, Validation>();
export type OpacityCandidateClientBinding = Readonly<{kind: 'internal-opacity-client'}>;
export function createOpacityCandidateClientBinding(validation: Validation): OpacityCandidateClientBinding {
  const value = Object.freeze({kind: 'internal-opacity-client'} as const);bindings.set(value, Object.freeze({...validation}));return value;
}
export function readOpacityCandidateClientBinding(value: unknown) {
  return value !== null && typeof value === 'object' ? bindings.get(value) ?? null : null;
}

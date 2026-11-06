/** A captured application/project view owner, checked live at every boundary. */
export interface ProjectFeatureAdmission {readonly key: string;readonly scope: string;readonly isCurrent: () => boolean}
export function featureAdmissionAllowed(admission?: ProjectFeatureAdmission, key?:string): boolean {
  const expectedKey = arguments.length > 1 ? key : admission?.key;
  if (!admission) return expectedKey === undefined;
  if (admission.key !== expectedKey || !admission.key || typeof admission.isCurrent !== 'function') return false;
  try {return admission.isCurrent() === true;} catch {return false;}
}

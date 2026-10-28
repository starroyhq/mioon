import { useLayoutEffect, useRef, useState } from 'react';
import { createSubjectVariantController } from './subject-variant-state.ts';
import type { SubjectVariantController, SubjectVariantOptions, SubjectVariantState } from './subject-variant-state.ts';

export interface UseSubjectVariantsOptions extends Omit<SubjectVariantOptions, 'onChange'> {
  scope: string | null;
  /** Null while no ordinary project is open; a restored workspace has no batches. */
  projectId: string | null | undefined;
}
export interface UseSubjectVariantsResult { state: SubjectVariantState | null; controller: SubjectVariantController }

// One controller for the window. A project or scope change starts a fresh state,
// and the previous project's state is withheld until the new context is installed.
export function useSubjectVariants({ scope, projectId, read, write, image, approve, settings, requestId, onVersions }: UseSubjectVariantsOptions): UseSubjectVariantsResult {
  const callbacks = useRef({ read, write, image, approve, settings, onVersions });
  callbacks.current = { read, write, image, approve, settings, onVersions };
  const [state, setState] = useState<SubjectVariantState | null>(null), controller = useRef<SubjectVariantController | null>(null);
  if (!controller.current) controller.current = createSubjectVariantController({
    read: (operation, input) => callbacks.current.read(operation, input),
    write: (operation, input) => callbacks.current.write(operation, input),
    image: (operation, input) => callbacks.current.image(operation, input),
    approve: review => callbacks.current.approve(review),
    settings: () => callbacks.current.settings(),
    ...(requestId ? { requestId } : {}),
    onChange: setState,
    onVersions: (subjectId, hidden) => callbacks.current.onVersions?.(subjectId, hidden),
  });
  useLayoutEffect(() => { controller.current!.setContext(projectId ? { scope, projectId } : null); }, [scope, projectId]);
  useLayoutEffect(() => () => controller.current?.dispose(), []);
  return { state: state?.scope === scope && state.projectId === projectId ? state : null, controller: controller.current };
}

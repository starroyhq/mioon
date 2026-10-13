import React, { useCallback, useInsertionEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { createSettingsNavigationRegistry } from './settings-navigation-state.ts';
import type { SettingsNavigationState } from './settings-navigation-state.ts';

type Registry = ReturnType<typeof createSettingsNavigationRegistry>;
type Registration = ReturnType<Registry['register']>;

/** Owns status reports only. It never receives credentials or form fields. */
export default function SettingsNavigationSlot({ registry, slot, children }: {
  registry?: Registry;
  slot: string;
  children: (report: (state: SettingsNavigationState) => void) => ReactNode;
}) {
  const owner = useMemo(() => ({ closed: false, registration: null as Registration | null }), [registry, slot]);
  const report = useCallback((state: SettingsNavigationState) => {
    if (!registry || owner.closed) return;
    // Child layout effects report before their parent's layout effect. Register
    // on that first report; the form's own lifetime rejects late callbacks.
    owner.registration ??= registry.register(slot);
    owner.registration.update(state);
  }, [registry, slot, owner]);
  // Retire the report capability before descendant layout cleanup can emit its
  // final reset. An old callback must not recreate a released registration.
  useInsertionEffect(() => {
    owner.closed = false;
    return () => { owner.closed = true; owner.registration?.release(); owner.registration = null; };
  }, [owner]);
  return <>{children(report)}</>;
}

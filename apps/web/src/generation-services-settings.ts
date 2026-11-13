import type {ReactNode} from 'react';
import type {SettingsNavigationState} from './settings-navigation-state.ts';

/** Presentation and redacted status only. Credentials stay in each panel's DOM. */
export interface GenerationServiceDetail {
  key: string;
  label: string;
  providerId: string;
  kind: 'video' | 'image';
  custom: boolean;
  configured: boolean | null;
  dirty?: boolean;
  available: boolean | null;
  content: ReactNode;
}
export type GenerationDomainOutcome = 'saved' | 'error' | 'unknown' | 'blocked';
/** A local, single-use transport capability, never navigation or React state.
 * Dispose must release even the requests skipped after an earlier domain fails. */
export interface GenerationSaveTicket {
  run(): Promise<GenerationDomainOutcome>;
  dispose(): void;
}
export interface GenerationServiceDomain {
  services: readonly GenerationServiceDetail[];
  ready: boolean;
  navigation: SettingsNavigationState;
  notice?: ReactNode;
  /** Null means unchanged. Validation failure throws a safe, redacted error. */
  prepareSave(): GenerationSaveTicket | null;
  clearKeys(): void;
  discard(): void;
  add?(): string | null;
}
export interface GenerationServiceDomainOptions {
  pageVisible: boolean;
  /** Synchronous page-wide edit fence. Preparing and committing the already
   * admitted Save use their own capability and do not consult this callback. */
  interactionAllowed?: () => boolean;
  onNavigationStateChange?: (state: SettingsNavigationState) => void;
  onSelect?: (key: string) => void;
}

export interface GenerationSaveResult {
  state: 'saved' | 'error' | 'unknown' | 'partial' | 'blocked';
  confirmed: number;
}

/** Capture and clear every domain before the first await. Cross-file saves
 * deliberately stop on failure; confirmed files are not rolled back or retried. */
export async function saveGenerationServiceDomains(
  domains: readonly Pick<GenerationServiceDomain, 'prepareSave' | 'clearKeys'>[],
): Promise<GenerationSaveResult> {
  const tickets: GenerationSaveTicket[] = [];
  let invalid = false, confirmed = 0;
  try {
    for (const domain of domains) {
      try {
        const ticket = domain.prepareSave();
        if (ticket) tickets.push(ticket);
      } catch { invalid = true; }
      finally { domain.clearKeys(); }
    }
    if (invalid) return {state: 'error', confirmed};
    for (const ticket of tickets) {
      let outcome: GenerationDomainOutcome;
      try { outcome = await ticket.run(); }
      catch { outcome = 'unknown'; }
      if (outcome !== 'saved') return {state: confirmed ? 'partial' : outcome, confirmed};
      confirmed++;
    }
    return {state: 'saved', confirmed};
  } finally { for (const ticket of tickets) ticket.dispose(); }
}

// Reviewed strict-typing view for assertion predicates over thrown/rejected
// values. Runtime values are unchanged; tests still inspect the exact code,
// message, status and dispatch/uncertainty fields at their assertion sites.
export interface ErrorView {
  readonly code?: string;
  readonly message?: string;
  readonly status?: number;
  readonly dispatched?: boolean;
  readonly outcomeUnknown?: boolean;
  readonly [key: string]: unknown;
}
export const errorView = (error: unknown): ErrorView => error as ErrorView;

// This protocol identity keeps its compatibility version stable for retained
// requests. A future API-version change must preserve this profile for recovery.
export const ANTHROPIC_MESSAGES_API_VERSION = '2023-06-01';
export const ANTHROPIC_MESSAGES_FIELDS = Object.freeze({thinking: Object.freeze({type: 'disabled' as const})});

import type { MessageCatalog } from '../types.ts';
import { assertNoDuplicateMessageKeys } from '../catalog-integrity.ts';
import { creationUiMessages } from './creation-ui.ts';
import { connectionMessages } from './creation-connections.ts';
import { creationStateMessages } from './creation-state.ts';
import { creationExtraMessages } from './creation-extra.ts';
assertNoDuplicateMessageKeys(creationUiMessages, connectionMessages, creationStateMessages, creationExtraMessages);
export const creationMessages = { ...creationUiMessages, ...connectionMessages, ...creationStateMessages, ...creationExtraMessages } as const satisfies MessageCatalog;

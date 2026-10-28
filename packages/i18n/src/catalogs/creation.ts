import type { MessageCatalog } from '../types.ts';
import { assertNoDuplicateMessageKeys } from '../catalog-integrity.ts';
import { creationUiMessages } from './creation-ui.ts';
import { connectionMessages } from './creation-connections.ts';
import { creationStateMessages } from './creation-state.ts';
import { creationExtraMessages } from './creation-extra.ts';
import { previsMessages } from './previs.ts';
assertNoDuplicateMessageKeys(creationUiMessages, connectionMessages, creationStateMessages, creationExtraMessages, previsMessages);
export const creationMessages = { ...creationUiMessages, ...connectionMessages, ...creationStateMessages, ...creationExtraMessages, ...previsMessages } as const satisfies MessageCatalog;

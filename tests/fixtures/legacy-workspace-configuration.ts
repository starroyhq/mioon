// Explicit historical-format entry point for backup/restore unit coverage.
// This never starts a server or installs a production legacy fallback.
import {openLegacyWorkspaceStore} from '../../packages/business/src/db.ts';
import {createServices} from '../../packages/business/src/services.ts';

export function openLegacyWorkspaceConfiguration(root: string, options: {backupQuiescent?: () => boolean} = {}) {
  const store = openLegacyWorkspaceStore(root);
  try {
    const services = createServices(store, new Map(), {env: {MIOON_ENABLE_LIVE_PROVIDER: '0'}, ...options});
    let closed = false;
    return {store, services, async close() {if (closed) return; closed = true; await services.drain(); store.close();}};
  } catch (error) {store.close(); throw error;}
}

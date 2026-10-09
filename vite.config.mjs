// Compatibility with a root-level Vite invocation; normal scripts target apps/web.
import config from './apps/web/vite.config.mjs';
export default {...config,root:'apps/web'};

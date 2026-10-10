// Legacy command name retained; the local tooling doctor reads no workspace,
// credential or user configuration and never installs or repairs prerequisites.
import {main} from './tooling.mjs';
process.exitCode = await main(['doctor', ...process.argv.slice(2)]);

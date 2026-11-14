import {startServer as startApplicationServer, type ServerOptions} from '../../apps/server/src/index.ts';
import {isolateTestProviderEnvironment} from './test-env.ts';

export type {InspectApplication, InspectProject, ServerOptions} from '../../apps/server/src/index.ts';

/** The hosted project still reads provider settings from this test process. */
export function startServer(options?: ServerOptions) {
  isolateTestProviderEnvironment();
  return startApplicationServer(options);
}

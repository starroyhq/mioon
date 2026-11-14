import {startServer as startApplicationServer, type ServerOptions} from '../../apps/server/src/index.ts';
import {composeHostedProject as composeApplicationHost} from '../../apps/server/src/project-host/runtime.ts';
import {composeProjectRuntime as composeApplicationProject} from '../../apps/server/src/project-runtime.ts';
import {isolateTestProviderEnvironment} from './test-env.ts';

export {ProjectRuntimeCleanupError} from '../../apps/server/src/project-runtime.ts';
export type {ProjectRuntime, ProjectRuntimeOptions} from '../../apps/server/src/project-runtime.ts';
export type {InspectApplication, InspectProject, ServerOptions} from '../../apps/server/src/index.ts';

/** The hosted project still reads provider settings from this test process. */
export function startServer(options?: ServerOptions) {
  isolateTestProviderEnvironment();
  return startApplicationServer(options);
}

export function composeHostedProject(...args: Parameters<typeof composeApplicationHost>) {
  isolateTestProviderEnvironment();
  return composeApplicationHost(...args);
}

export function composeProjectRuntime(...args: Parameters<typeof composeApplicationProject>) {
  isolateTestProviderEnvironment();
  return composeApplicationProject(...args);
}

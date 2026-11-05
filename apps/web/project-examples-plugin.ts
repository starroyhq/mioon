import path from 'node:path';
import type {Plugin, ResolvedConfig} from 'vite';
import {stageProjectExampleResources} from '../../packages/business/src/project-example-resources.ts';

/** Built into the web artifact once, then reused by desktop staging. The
 * running server never needs this repository's source examples directory. */
export function projectExamplesPlugin(sourceDirectory: string): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'mioon-project-examples', apply: 'build',
    configResolved(value) {config = value;},
    async closeBundle() {
      await stageProjectExampleResources(sourceDirectory, path.resolve(config.root, config.build.outDir, 'project-examples'));
    },
  };
}

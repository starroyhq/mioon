import {runInCliUtility} from './cli-runtime-stdio.ts';

runInCliUtility(async () => {
  const {runCli} = await import('../../cli/src/run.ts');
  await runCli();
}, 'Mioon CLI could not start the desktop runtime.');

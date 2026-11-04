import {readFileSync} from 'node:fs';
import {createBackgroundLifecycleHost} from './project-background-lifecycle-host.ts';

const input: {dataDir: string; remote: string; projectId: string} = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const host = createBackgroundLifecycleHost(input);
try {
  const restored = await host.restore();
  if (restored.failures.length) throw new Error('Restore failed');
  process.send?.({type: 'ready', taskLeases: host.manager.status(input.projectId)?.leases.task ?? 0});
  process.on('message', message => {if (message === 'stop') void host.close().then(() => process.exit(0));});
} catch {
  process.send?.({type: 'failed'});
  await host.close(); process.exitCode = 1;
}

import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {closeQaProject, createQaProject} from './kernel-qa-fixture.mjs';
import {startServer} from './test-server.ts';

const [dataDir, distDir, token] = process.argv.slice(2);
if (!dataDir || !distDir || !token) throw new Error('Expected a temporary data directory, web build and fixture token');

const projects = [];
for (const count of [1, 3, 30]) {
  const name = `Canvas fit · ${count}`;
  const fixture = await createQaProject(dataDir, {name, media: false});
  const projectId = fixture.project.id;
  const columns = Math.min(count, 6);
  try {
    for (let index = 0; index < count; index++) {
      await fixture.services.call('shot.create', {
        projectId, requestId: randomUUID(), title: `合成镜头 ${index + 1}`,
        aspectRatio: '16:9', duration: 4,
        position: {x: (index % columns) * 232 + 120, y: Math.floor(index / columns) * 264 + 120},
      });
    }
  } finally {
    await closeQaProject(fixture);
  }
  projects.push({projectId, count});
}

const server = await startServer({dataDir, port: 0, distDir, token});
process.once('SIGTERM', () => { void server.close(); });
await writeFile(path.join(dataDir, 'ready.json'), JSON.stringify({origin: server.url, projects}), {mode: 0o600, flag: 'wx'});

import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {startServer} from './helpers/test-server.ts';
import {prepareFormat5Release} from './helpers/format5-release-fixture.ts';
import {releaseProjectPaths} from './helpers/format4-release-fixture.ts';
import {projectFormatReadOnlyViewSchema} from '../packages/contracts/src/project-format-upgrade.ts';

const TOKEN = 'format4-read-only-test-token-2026';

/** Real server read-only path: a registered released format-3 and format-4
 * project is read through the application HTTP route without opening the host
 * or migrating the project. No test doubles stand in for the server route. */
test('server format-upgrade read-only route reads released format-3 and format-4 projects without writing', async t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'format4-readonly-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const dataDir = path.join(root, 'data'), projectsDir = path.join(dataDir, 'projects');
  mkdirSync(projectsDir, {recursive: true, mode: 0o700});
  mkdirSync(path.join(root, 'cache'), {recursive: true, mode: 0o700});
  mkdirSync(path.join(root, 'dist'), {recursive: true, mode: 0o700});
  type Release = 'v0.1.0' | 'v0.2.0';
  const expected: Record<Release, string> = {'v0.1.0': '', 'v0.2.0': ''};
  for (const release of ['v0.1.0', 'v0.2.0'] as const) {
    const prepared = prepareFormat5Release(root, release);
    const projectDir = path.join(projectsDir, release);
    cpSync(prepared.sample, projectDir, {recursive: true});
    for (const directory of [projectDir, ...Object.values(releaseProjectPaths(projectDir).location)]) mkdirSync(directory, {recursive: true, mode: 0o700});
    expected[release] = prepared.evidence.projectId;
  }
  const library = openAppLibrary({dataDir, findMovedRoots: [projectsDir]});
  try {
    for (const [release, projectId] of Object.entries(expected)) {
      const projectFile = path.join(projectsDir, release, 'project.mioon');
      const identity = library.projectFileIdentity(projectFile);
      assert.ok(identity);
      library.registry.upsert({projectId, projectFile, fileIdentity: identity, name: release, lastOpenedAt: null, summary: null});
    }
  } finally {library.close();}
  const service = await startServer({dataDir, projectsDir, cacheDir: path.join(root, 'cache'), distDir: path.join(root, 'dist'),
    port: 0, token: TOKEN});
  t.after(() => service.close());
  const fetchReadOnly = (projectId: string): Promise<{status: number; body: string}> => new Promise((resolve, reject) => {
    const request = http.get(service.url + `/api/projects/${projectId}/format-upgrade/read-only`,
      {headers: {authorization: 'Bearer ' + TOKEN}}, response => {
        let body = ''; response.setEncoding('utf8');
        response.on('data', chunk => {body += chunk;});
        response.on('end', () => resolve({status: response.statusCode ?? 0, body}));
      });
    request.on('error', reject);
  });
  for (const [release, expectedVersion] of [['v0.1.0', 3], ['v0.2.0', 4]] as const) {
    const projectId = expected[release];
    const projectFile = path.join(projectsDir, release, 'project.mioon');
    const before = statSync(projectFile).size, digest = readFileSync(projectFile).subarray(0, 64).toString('hex');
    const response = await fetchReadOnly(projectId);
    assert.equal(response.status, 200, response.body);
    const body = JSON.parse(response.body) as {ok: boolean; data: unknown};
    assert.equal(body.ok, true);
    const view = projectFormatReadOnlyViewSchema.parse(body.data);
    assert.equal(view.projectId, projectId);
    assert.equal(view.projectVersion, expectedVersion);
    assert.equal(view.shots.length, 1);
    assert.equal(view.nodes.length, 1);
    assert.equal(view.timeline?.clips.length, 1);
    assert.equal(statSync(projectFile).size, before, 'read-only must not write the project file');
    assert.equal(readFileSync(projectFile).subarray(0, 64).toString('hex'), digest, 'read-only keeps the header bytes');
  }
});

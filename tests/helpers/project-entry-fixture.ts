import {projectEntriesResponseSchema} from '../../packages/contracts/src/project-entry.ts';
import type {ProjectEntriesResponse} from '../../packages/contracts/src/project-entry.ts';
import {createProjectEntryDirectoryClient} from '../../apps/web/src/project-entry-directory-client.ts';
import {createProjectEntryIdentityOwner} from '../../apps/web/src/project-entry-identity.ts';

export const PROJECT_ENTRY_TEST_SCOPE = 'a'.repeat(64);
export const PROJECT_ENTRY_TEST_INSTANCE = '77000000-0000-4000-8000-000000000009';

/** A complete directory with deliberately absent cached metadata. Membership
 * never relies on a made-up summary, revision or last-opened timestamp. */
export function projectEntryFixture(projects: readonly {id: string; name?: string}[] = [], identity: {appLibraryScope?: string; instanceId?: string} = {}): ProjectEntriesResponse {
  return projectEntriesResponseSchema.parse({version: 1, appLibraryScope: identity.appLibraryScope ?? PROJECT_ENTRY_TEST_SCOPE,
    instanceId: identity.instanceId ?? PROJECT_ENTRY_TEST_INSTANCE, registered: projects.map((project, index) => ({
      project: {projectId: project.id, name: project.name ?? `项目 ${index + 1}`, projectFile: `/synthetic/${project.id}.mioon`,
        fileIdentity: {dev: '1', ino: String(index + 1)}, lastOpenedAt: null, summary: null},
      availability: {state: 'available'}, coverUrl: null,
    }))});
}

/** The App harness keeps both the real strict GET reader and identity owner.
 * Only the remote response is controlled, so unexpected old addresses fail. */
export function projectEntryOwnerFixture(read: () => unknown | Promise<unknown>, calls: unknown[][] = []) {
  const client = createProjectEntryDirectoryClient({fetcher: async (url, init) => {
    calls.push(['directory', String(url), init?.method]);
    if (url !== '/api/project-entries' || init?.method !== 'GET') throw Error('Unexpected application directory request');
    const data = await read();
    return new Response(JSON.stringify({ok: true, data}), {status: 200, headers: {'content-type': 'application/json'}});
  }});
  const owner = createProjectEntryIdentityOwner({read: client.list}); owner.activate();
  return owner;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {schemas} from '../packages/contracts/src/index.ts';
import {discoverSchema} from '../packages/client/src/index.ts';
import {isProjectCopyOperation, projectCopyInputSchema, projectCopyResponseSchema, projectCopySchemas} from '../packages/contracts/src/project-copies.ts';
import type {ProjectCopyInput, ProjectCopyResponse} from '../packages/contracts/src/project-copies.ts';
import {projectEntrySaveAsInputSchema} from '../packages/contracts/src/project-entry-native.ts';
import {isAppLevelOperation, rpcPathFor} from '../packages/contracts/src/project-addressing.ts';

const sourceId = '12345678-1234-4234-8234-abcdef123456';
const targetId = 'abcdef01-1234-4234-8234-abcdef123456';
const requestId = 'abcdef02-1234-4234-8234-abcdef123456';
const input: ProjectCopyInput = {projectId: sourceId, requestId, projectFile: '/projects/新项目/新项目.mioon', name: '新项目 🎬'};
const response: ProjectCopyResponse = {requestId, sourceProjectId: sourceId,
  project: {projectId: targetId, projectFile: input.projectFile, fileIdentity: {dev: '1', ino: '12345678901234567890'}, name: input.name!, lastOpenedAt: null, summary: null},
  contentSequence: 0, contentToken: 'a'.repeat(32), versions: 0};

test('application copy inputs preserve caller identity and support only explicit normalized new project files', () => {
  assert.deepEqual(projectCopyInputSchema.parse(input), input);
  const {name: _name, ...unnamed} = input;
  assert.deepEqual(projectCopyInputSchema.parse(unnamed), unnamed);
  for (const projectFile of ['/新项目/组合 e\u0301.mioon', 'C:\\Projects\\Copy.mioon', '\\\\server\\share\\Copy.mioon'])
    assert.equal(projectCopyInputSchema.safeParse({...input, projectFile}).success, true, projectFile);
  for (const patch of [{projectId: sourceId.toUpperCase()}, {projectId: 'not-a-project'}, {requestId: requestId.toUpperCase()}, {requestId: 'stable-but-not-a-uuid'},
    {projectFile: 'relative.mioon'}, {projectFile: '/projects/../Copy.mioon'}, {projectFile: '/projects//Copy.mioon'}, {projectFile: '/projects/.Copy.mioon'},
    {projectFile: '/projects/.mioon'}, {projectFile: '/projects/Copy.sqlite'}, {projectFile: '/projects/Copy.MIOON'}, {projectFile: '/projects/Copy.mioon/'},
    {projectFile: '/projects/Copy\0.mioon'}, {projectFile: '/'.repeat(4097) + 'Copy.mioon'},
    {name: ''}, {name: ' Renamed'}, {name: '.hidden'}, {name: 'trailing.'}, {name: 'NUL.txt'}, {name: 'path/name'}, {name: 'a'.repeat(151)},
    {includeHistory: true}, {contentToken: 'b'.repeat(32)}, {approved: true}, {windowId: requestId}])
    assert.equal(projectCopyInputSchema.safeParse({...input, ...patch}).success, false, JSON.stringify(patch));
});

test('copy receipts bind a distinct new project and retain exact safe counts and content token evidence', () => {
  assert.deepEqual(projectCopyResponseSchema.parse(response), response);
  assert.equal(projectCopyResponseSchema.safeParse({...response, contentSequence: Number.MAX_SAFE_INTEGER, versions: Number.MAX_SAFE_INTEGER}).success, true);
  for (const patch of [{requestId: requestId.toUpperCase()}, {sourceProjectId: sourceId.toUpperCase()},
    {project: {...response.project, projectId: sourceId}}, {project: {...response.project, projectId: targetId.toUpperCase()}},
    {project: {...response.project, projectFile: '/projects/not-a-project.db'}}, {project: {...response.project, projectFile: '/projects/.hidden.mioon'}},
    {project: {...response.project, fileIdentity: {dev: '1', ino: 2}}},
    {contentSequence: -1}, {contentSequence: 1.1}, {contentSequence: Number.MAX_SAFE_INTEGER + 1}, {contentSequence: '0'},
    {versions: -1}, {versions: 0.5}, {versions: Number.MAX_SAFE_INTEGER + 1},
    {contentToken: 'A'.repeat(32)}, {contentToken: 'a'.repeat(31)}, {contentToken: 'g'.repeat(32)},
    {history: 'copied'}, {cleanup: 'complete'}, {windowId: requestId}])
    assert.equal(projectCopyResponseSchema.safeParse({...response, ...patch}).success, false, JSON.stringify(patch));
});

test('save-as adds only an opaque trusted window owner to the exact application copy input', () => {
  const value = {...input, windowId: requestId};
  assert.deepEqual(projectEntrySaveAsInputSchema.parse(value), value);
  assert.equal(projectEntrySaveAsInputSchema.safeParse(input).success, false);
  for (const patch of [{windowId: 1}, {windowId: ''}, {windowId: 'not-an-owner'}, {projectId: sourceId.toUpperCase()},
    {projectFile: '/projects/../Copy.mioon'}, {leaseKind: 'window'}, {instanceId: requestId}, {copyRecords: true}])
    assert.equal(projectEntrySaveAsInputSchema.safeParse({...value, ...patch}).success, false, JSON.stringify(patch));
});

test('copy operations are app-only and remain absent from public CLI and model discovery', () => {
  for (const operation of ['project.duplicate', 'project.save-as'] as const) {
    assert.equal(isProjectCopyOperation(operation), true);
    assert.equal(isAppLevelOperation(operation), true);
    assert.equal(rpcPathFor(operation, input), '/api/rpc');
    assert.equal(projectCopySchemas[operation], projectCopyInputSchema);
    assert.equal(Object.hasOwn(schemas, operation), false);
    assert.throws(() => discoverSchema({operation}), {code: 'VALIDATION_ERROR', exitCode: 2});
  }
  for (const operation of ['project.create', 'project.saveAs', 'project.save-as.extra', 'toString', '__proto__', null, {}, 1])
    assert.equal(isProjectCopyOperation(operation), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {schemas} from '../packages/contracts/src/index.ts';
import {discoverSchema} from '../packages/client/src/index.ts';
import {isAppLevelOperation, rpcPathFor} from '../packages/contracts/src/project-addressing.ts';
import {projectEntryAdoptCopyInputSchema} from '../packages/contracts/src/project-entry-native.ts';
import {isProjectCopyOperation, isProjectCopyActionOperation, projectAdoptCopyInputSchema, projectCopyToInputSchema,
  projectTemplateInputSchema, projectCopyActionSchemas} from '../packages/contracts/src/project-copies.ts';

const projectId = '12345678-1234-4234-8234-abcdef123456';
const requestId = 'abcdef02-1234-4234-8234-abcdef123456';
const source = {sourceProjectId: projectId, sourceFile: '/projects/Finder 副本.mioon',
  sourceIdentity: {dev: '1', ino: '12345678901234567890'}, sourceStamp: {contentSequence: 42, contentToken: 'a'.repeat(32)}};
const adopt = {...source, requestId};
const copyTo = {...adopt, projectFile: '/projects/New/New.mioon', name: 'New 🎬'};
const template = {templateId: 'starter-story', templateVersion: 1, parentDir: '/projects', name: 'New 🎬', requestId};

test('adopting a selected copy binds the exact old project, file and content observation', () => {
  assert.deepEqual(projectAdoptCopyInputSchema.parse(adopt), adopt);
  for (const patch of [{sourceProjectId: projectId.toUpperCase()}, {sourceProjectId: 'unknown'}, {requestId: 'unstable'},
    {sourceFile: 'relative.mioon'}, {sourceFile: '/projects/../copy.mioon'}, {sourceFile: '/projects/.hidden.mioon'},
    {sourceFile: '/projects/copy.db'}, {sourceIdentity: {dev: 1, ino: '2'}}, {sourceIdentity: {dev: '1', ino: '-2'}},
    {sourceIdentity: {dev: '1', ino: '2', accepted: true}}, {sourceStamp: {contentSequence: -1, contentToken: 'a'.repeat(32)}},
    {sourceStamp: {contentSequence: 0, contentToken: 'A'.repeat(32)}}, {sourceStamp: {contentSequence: 0.5, contentToken: 'a'.repeat(32)}},
    {sourceStamp: {contentSequence: Number.MAX_SAFE_INTEGER + 1, contentToken: 'a'.repeat(32)}}, {sourceStamp: null},
    {sourceStamp: {contentSequence: 0, contentToken: 'a'.repeat(32), trusted: true}}, {sourceIdentity: null},
    {name: 'rename'}, {projectFile: '/projects/elsewhere.mioon'}, {includeVersions: true}, {windowId: requestId}])
    assert.equal(projectAdoptCopyInputSchema.safeParse({...adopt, ...patch}).success, false, JSON.stringify(patch));
  for (const field of ['sourceProjectId', 'sourceFile', 'sourceIdentity', 'sourceStamp', 'requestId']) {
    const candidate: Record<string, unknown> = {...adopt}; delete candidate[field];
    assert.equal(projectAdoptCopyInputSchema.safeParse(candidate).success, false, field);
  }
});

test('copy-to adds only a distinct new target and optional validated name', () => {
  assert.deepEqual(projectCopyToInputSchema.parse(copyTo), copyTo);
  const {name: _name, ...unnamed} = copyTo;
  assert.deepEqual(projectCopyToInputSchema.parse(unnamed), unnamed);
  for (const projectFile of ['C:\\Projects\\New.mioon', '\\\\server\\share\\New.mioon', '/projects/e\u0301.mioon'])
    assert.equal(projectCopyToInputSchema.safeParse({...copyTo, projectFile}).success, true, projectFile);
  for (const patch of [{projectFile: source.sourceFile}, {projectFile: '/projects/New.sqlite'}, {projectFile: '/projects/New.mioon/'},
    {projectFile: 'relative.mioon'}, {projectFile: '/projects//New.mioon'}, {name: ''}, {name: ' Bad'}, {name: 'NUL.txt'},
    {name: 'name/path'}, {name: 'a'.repeat(151)}, {copyMedia: true}, {skipHistory: true}, {confirmFork: true}, {windowId: requestId}])
    assert.equal(projectCopyToInputSchema.safeParse({...copyTo, ...patch}).success, false, JSON.stringify(patch));
});

test('templates select a catalog ID/version and only a new named folder below the selected parent', () => {
  assert.deepEqual(projectTemplateInputSchema.parse(template), template);
  for (const patch of [{templateId: '../outside'}, {templateId: '/templates/template.mioon'}, {templateId: 'C:\\template.mioon'},
    {templateId: ''}, {templateId: 'UPPER'}, {templateId: 'x'.repeat(101)}, {templateVersion: 0}, {templateVersion: -1},
    {templateVersion: 1.1}, {templateVersion: '1'}, {templateVersion: Number.MAX_SAFE_INTEGER + 1},
    {parentDir: 'relative'}, {parentDir: '/projects/..'}, {parentDir: '/projects//elsewhere'}, {name: '..'}, {name: '.hidden'},
    {name: 'with/path'}, {name: 'a'.repeat(151)}, {projectFile: '/projects/existing.mioon'}, {files: []},
    {sourceFile: '/templates/template.mioon'}, {sourceProjectId: projectId}, {manifest: {}}, {windowId: requestId}])
    assert.equal(projectTemplateInputSchema.safeParse({...template, ...patch}).success, false, JSON.stringify(patch));
  for (const field of ['templateId', 'templateVersion', 'parentDir', 'name', 'requestId']) {
    const candidate: Record<string, unknown> = {...template}; delete candidate[field];
    assert.equal(projectTemplateInputSchema.safeParse(candidate).success, false, field);
  }
});

test('adopt-copy window ownership is available only on the trusted port', () => {
  const input = {...adopt, windowId: requestId};
  assert.deepEqual(projectEntryAdoptCopyInputSchema.parse(input), input);
  assert.equal(projectEntryAdoptCopyInputSchema.safeParse(adopt).success, false);
  for (const patch of [{windowId: 1}, {windowId: ''}, {leaseKind: 'window'}, {instanceId: requestId}, {approved: true}])
    assert.equal(projectEntryAdoptCopyInputSchema.safeParse({...input, ...patch}).success, false, JSON.stringify(patch));
});

test('S5-B application routes stay out of public CLI, MCP and model discovery', () => {
  for (const [operation, input] of [['project.adopt-copy', adopt], ['project.copy-to', copyTo], ['project.template.instantiate', template]] as const) {
    assert.equal(isProjectCopyActionOperation(operation), true);
    assert.equal(isProjectCopyOperation(operation), false, 'S5-A recovery operation domain is unchanged');
    assert.equal(isAppLevelOperation(operation), true);
    assert.equal(rpcPathFor(operation, input), '/api/rpc');
    assert.deepEqual(projectCopyActionSchemas[operation].parse(input), input);
    assert.equal(Object.hasOwn(schemas, operation), false);
    assert.throws(() => discoverSchema({operation}), {code: 'VALIDATION_ERROR', exitCode: 2});
  }
  for (const operation of ['project.duplicate', 'project.adoptCopy', 'project.copy-to.extra', 'project.template', 'toString', '__proto__', null, {}, 1])
    assert.equal(isProjectCopyActionOperation(operation), false);
});

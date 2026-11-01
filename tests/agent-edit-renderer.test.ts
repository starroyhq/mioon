import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), shotId = id(4);
test('App confirmed-apply refresh is same-project and cannot mark an Inspector draft saved or remount it', () => {
  const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const handler = app.match(/onApplied=\{\(projectId: string\) => \{([^}]+)\}\}/)?.[1]; assert.ok(handler); assert.match((handler as string), /currentProject.current === projectId/); assert.match((handler as string), /refresh\(projectId\)/);
  assert.doesNotMatch((handler as string), /setShotDirty|setClipDirty|setSourceDirty|setSubjectDirty|setSubtitleDirty|setInspectorEpoch|saveShot|setSelected|rpc/);
  const calls: unknown[] = [], apply = (Function('currentProject', 'refresh', `return projectId => { ${handler} };`)({ current: projectId }, (id: unknown) => calls.push(id)) as unknown as (projectId: string)=>void);
  apply(id(90)); assert.equal(calls.length, 0); apply(projectId); assert.deepEqual(calls, [projectId]);
  // Prop order is irrelevant; evaluate the actual key to preserve remount fences.
  const inspectorStart = app.indexOf('<Inspector '), inspectorEnd = app.indexOf('/>', inspectorStart);
  assert.ok(inspectorStart >= 0 && inspectorEnd > inspectorStart);
  const inspectorTag = app.slice(inspectorStart, inspectorEnd);
  const keyExpression = inspectorTag.match(/\bkey=\{(`[^`]+`)\}/)?.[1];
  assert.equal(keyExpression, "`${data.project?.id}:${selectedId || 'empty'}:${inspectorEpoch}`");
  const keyFor = Function('data', 'selectedId', 'inspectorEpoch', `return ${keyExpression};`);
  const key = keyFor({project:{id:projectId}, shots:[]}, shotId, 3);
  assert.equal(keyFor({project:{id:projectId}, shots:[{id:shotId, revision:5}], subjects:[{revision:9}]}, shotId, 3), key);
  assert.notEqual(keyFor({project:{id:id(90)}}, shotId, 3), key);
  assert.notEqual(keyFor({project:{id:projectId}}, id(91), 3), key);
  assert.notEqual(keyFor({project:{id:projectId}}, shotId, 4), key);
  const inspector = readFileSync(new URL('../apps/web/src/Inspector.tsx', import.meta.url), 'utf8'); assert.match((inspector as string), /if \(!dirty\) \{ draftRef\.current = latest; setDraft\(latest\)/); assert.match((inspector as string), /else if \(record.revision !== baseRevision\) setConflict\(true\)/);
});

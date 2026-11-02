import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createProjectFile, isProjectStore, openStore} from '../packages/business/src/project-file/index.ts';
import {createMioRecords} from '../packages/business/src/agent/mio-records.ts';
import {createMioAssembly} from '../packages/business/src/agent/mio-assembly.ts';
import {createMioRuntime} from '../packages/business/src/agent/mio-runtime.ts';
import {createMioJournal} from '../packages/business/src/agent/mio-journal.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {DEFAULT_AGENT_TASK_POLICY} from '../packages/contracts/src/agent-tasks-v2.ts';
import {
  collectTaskRequestFingerprints, readTaskRequestFingerprintFixture,
} from './helpers/agent-task-request-fingerprints-v2.ts';
import {createMioTestAppPorts} from './helpers/mio-runtime-app-ports.ts';

const projectId = '00000000-0000-4000-8000-000000000001';
const readPolicy = {
  policy: () => structuredClone(DEFAULT_AGENT_TASK_POLICY),
  lookupPolicy: () => null,
  updatePolicy: (): never => {throw new Error('These scenarios must not modify the application policy');},
};

test('K1 Mio entries retain all 99 raw request fingerprints and rebuild sent bytes after cleanup and reopen', {timeout: 180_000}, async () => {
  let rebuilt = 0, cleaned = 0, diagnostics = 0;
  const actual = await collectTaskRequestFingerprints({
    openStore(root) {
      createProjectFile(path.join(root, 'project.mioon'), {projectId});
      return openStore(root);
    },
    createFixturePorts: createMioTestAppPorts,
    createTools(options) {
      assert.ok(isProjectStore(options.store));
      const journal = createMioJournal(options.store, {...readPolicy, assembly: createMioAssembly(createMioRecords(options.store))});
      return createAgentTaskTools({...options, journal});
    },
    createRuntime(options) {
      assert.ok(isProjectStore(options.store));
      return createMioRuntime({...options, store: options.store, policy: readPolicy});
    },
    stageAttachment(store, input) {
      assert.ok(isProjectStore(store));
      const records = createMioRecords(store);
      store.tx(() => records.addImport({...input, status: 'selected', assetId: null, resourceId: null}));
    },
    afterClose({root, requests, intents, protocol, scenario}) {
      assert.equal(requests.length, intents.length);
      const store = openStore(root), records = createMioRecords(store), assembly = createMioAssembly(records);
      try {
        const before = store.db.prepare('SELECT total_changes() AS count').get()!.count;
        for (let index = 0; index < requests.length; index++) {
          const step = records.step(intents[index]!.stepId);
          assert.ok(step.currentRequestId);
          const request = records.request(step.currentRequestId);
          if (scenario === 'conversation_history_trim' && index > 0) {
            assert.ok(request.inputManifest.entryIds.some(id => records.entry(id).runId !== step.runId), 'Conversation history must reference canonical entries from its earlier runs');
            const view = JSON.stringify(request.inputManifest.parameters);
            for (const repeated of ['a', 'b', 'r']) assert.ok(!view.includes(repeated.repeat(1000)), 'The per-request view must not copy long canonical history into literal nodes');
          }
          const projected = assembly.hydrate(request);
          assert.ok(projected && typeof projected === 'object' && !Array.isArray(projected));
          assert.equal(projected.body, requests[index], `${protocol}/${scenario}/${index + 1} must rebuild the exact dispatched bytes`);
          if (request.state === 'completed') {
            assert.equal(request.originalBody, null, 'A successful model response must clear its original in the completion transaction');
            cleaned++;
          } else {
            assert.equal(request.originalBody, requests[index], 'An unknown or failed result must retain the exact original');
          }
          rebuilt++;
          if (scenario.startsWith('diagnostic_')) diagnostics++;
        }
        assert.equal(store.db.prepare('SELECT total_changes() AS count').get()!.count, before, 'Rebuilding private requests must be read-only');
        const eventColumns = store.db.prepare('PRAGMA main.table_info(mio_events)').all().map(row => row.name);
        assert.deepEqual(eventColumns, ['runId', 'sequence', 'createdAt']);
        assert.equal(store.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name='agent_task_runs_v2'").get(), undefined);
      } finally {store.close();}
    },
  });
  assert.deepEqual(actual, readTaskRequestFingerprintFixture().requests);
  assert.equal(actual.length, 99);
  assert.equal(rebuilt, 99);
  assert.equal(diagnostics, 12);
  assert.ok(cleaned > 90, 'The successful scenarios must exercise raw-request cleanup, not only retained failed requests');
});

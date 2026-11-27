import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const editTool = 'mioon_sequence_timeline_edit';

function result(body, label) {
  assert.equal(body?.ok, true, label + ' failed (' + String(body?.error?.code ?? 'invalid envelope') + ')');
  return body.data;
}

function normalizeTimeline(timeline) {
  // Freeze allocates new clip/group IDs on each route. Compare their graph
  // relationships and their timing, rather than the random IDs themselves.
  const clips = new Map(timeline.clips.map((clip, index) => [clip.id, index]));
  const groups = new Map();
  return {
    durationFrames: timeline.durationFrames,
    clips: timeline.clips.map(({id: _id, anchor, sequenceSource, ...clip}) => {
      let source = sequenceSource;
      if (source?.segmentGroupId) {
        const key = source.segmentGroupId;
        if (!groups.has(key)) groups.set(key, groups.size);
        source = {...source, segmentGroupId: groups.get(key)};
      }
      return {...clip, sequenceSource: source, ...(anchor && {anchor: {...anchor, clipId: clips.get(anchor.clipId)}})};
    }),
  };
}

function scriptedGateway(rounds) {
  return async function* (request) {
    request.beforeSubmit?.();
    const toolCalls = rounds.shift() ?? [];
    const text = toolCalls.length ? '' : 'Synthetic action completed.';
    yield {type: 'done', output: {text, toolCalls, providerOutput: {
      role: 'assistant', content: text || null,
      ...(toolCalls.length ? {tool_calls: toolCalls.map(call => ({id: call.id, type: 'function',
        function: {name: call.name, arguments: JSON.stringify(call.arguments)}}))} : {}),
    }}};
  };
}

async function settleMio(request, runPath) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const snapshot = await request(runPath);
    if (snapshot.run.status !== 'accepted' && snapshot.run.status !== 'running') return snapshot;
    await delay(30);
  }
  assert.fail('Synthetic Mio action did not settle within 30 seconds');
}

async function fourRoutes(ctx) {
  if (!existsSync(path.join(ctx.repo, 'packages/business/src/format6-sequence-speed.ts'))) {
    ctx.blocked('SP-D format-6 speed mutation is missing from the checkout.');
  }
  const [{startServer}, {testEnv}, {createTestAgentSettings}, {putTestAgentConfiguration, testAgentExecution},
    {defaultTestAgentConfiguration}, {projectApiPath, projectRpcPath}, {deriveAgentEndpoint}, {run: runMedia}] = await Promise.all([
    ctx.load('tests/helpers/test-server.ts'),
    ctx.load('tests/helpers/test-env.ts'),
    ctx.load('tests/helpers/secret-codec.ts'),
    ctx.load('tests/helpers/agent-settings-fixture.ts'),
    ctx.load('tests/helpers/agent-preset-configurations.ts'),
    ctx.load('packages/contracts/src/project-file.ts'),
    ctx.load('packages/contracts/src/agent-protocol.ts'),
    ctx.load('packages/business/src/media-runtime.ts'),
  ]);
  const requireFromCheckout = createRequire(path.join(ctx.repo, 'package.json'));
  const {Client} = requireFromCheckout('@modelcontextprotocol/sdk/client/index.js');
  const {StdioClientTransport} = requireFromCheckout('@modelcontextprotocol/sdk/client/stdio.js');
  assert.equal(process.env.MIOON_FORMAT6_DEV, '1', 'The transport fixture requires the development format-6 flag');
  const settings = await createTestAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  const rounds = [];
  let server, mcp;
  try {
    const execution = testAgentExecution(await putTestAgentConfiguration(settings, {
      expectedRevision: 0, configuration: defaultTestAgentConfiguration('chat_completions'),
      secret: {action: 'replace', storage: 'persistent', value: 'synthetic-speed-acceptance'},
    }));
    const dataDir = path.join(ctx.scratch, 'app');
    await mkdir(dataDir, {mode: 0o700});
    server = await startServer({dataDir, port: 0, token: randomUUID(), localDraftChannel: 'development',
      projectFormatForTest: undefined, comfyModule: 'skip', agentSettings: settings, taskGatewayV2: scriptedGateway(rounds)});

    const request = async (route, input) => {
      const response = await fetch(server.url + route, {method: input === undefined ? 'GET' : 'POST',
        headers: {authorization: 'Bearer ' + server.token, 'content-type': 'application/json'},
        signal: AbortSignal.timeout(30_000),
        ...(input === undefined ? {} : {body: JSON.stringify(input)}),
      });
      return result(await response.json(), 'HTTP ' + response.status);
    };
    const {id: projectId} = await request('/api/rpc', {operation: 'project.create', input: {name: 'Synthetic speed parity'}});
    const rpc = (operation, input = {}) => request(projectRpcPath(projectId), {operation, input: {projectId, ...input}});
    const env = {...testEnv(), MIOON_BASE_URL: server.url, MIOON_TOKEN: server.token};
    const cli = async (words, args) => result(JSON.parse((await ctx.runNode(
      ['apps/cli/src/index.ts', ...words, '--input', JSON.stringify({projectId, ...args})],
      {env, timeoutMs: 30_000},
    )).stdout), 'CLI ' + words.join(' '));
    mcp = new Client({name: 'speed-acceptance', version: '1.0.0'});
    await mcp.connect(new StdioClientTransport({command: process.execPath, args: ['apps/mcp/src/index.ts'],
      cwd: ctx.repo, env, stderr: 'ignore'}));
    const tools = (await mcp.listTools()).tools;
    const timelineTool = tools.find(tool => tool.name === 'sequence_timeline_edit');
    assert.ok(timelineTool, 'MCP must advertise the timeline tool');
    const schema = JSON.stringify(timelineTool.inputSchema);
    for (const action of ['clip-speed', 'freeze-frame']) assert.ok(schema.includes('"const":"' + action + '"'));
    const mcpTool = async (name, input) => result((await mcp.callTool({name, arguments: {projectId, ...input}},
      undefined, {timeout: 30_000})).structuredContent, 'MCP ' + name);
    const read = async () => (await rpc('project.get')).timeline;
    const receiptInput = plan => ({envelope: plan.envelope, expectedPlanDigest: plan.planDigest});
    const setup = async (operation, input) => {
      const plan = await rpc(operation, input);
      assert.equal((await rpc('sequence.action.commit', receiptInput(plan))).status, 'applied');
    };
    const source = path.join(ctx.scratch, 'motion.mp4');
    await runMedia('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i',
      'testsrc2=size=64x64:rate=30', '-frames:v', '90', '-an', '-c:v', 'libx264', '-threads', '1',
      '-pix_fmt', 'yuv420p', source], {timeout: 15_000});
    const bytes = await readFile(source);
    const {id: assetId} = await rpc('asset.import', {
      name: 'motion.mp4', mimeType: 'video/mp4', dataBase64: bytes.toString('base64'),
    });
    await setup('sequence.board.edit', {kind: 'board-root-create', name: 'Film', position: {x: 0, y: 0}});
    await setup('sequence.timeline.edit', {kind: 'insert-asset', assetId, trackId: null, startFrame: 0});
    await setup('sequence.board.edit', {kind: 'board-shot-append', name: 'Placeholder'});
    const initial = await read();
    assert.equal(initial.capabilities.speed, true, 'Development HTTP must expose speed on the created project');
    const clipId = initial.clips.find(clip => clip.assetId === assetId)?.id;
    const suffixId = initial.clips.find(clip => clip.sourceState === 'placeholder')?.id;
    assert.ok(clipId && suffixId);
    const baseline = normalizeTimeline(initial);
    const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
    const operations = [
      {action: {kind: 'clip-speed', clipId, setting: {speed: {kind: 'constant', rate: {numerator: 2, denominator: 1}},
        direction: 'forward', pitchShift: false, interpolation: 'off'}}, duration: 45, suffix: 45},
      {action: {kind: 'freeze-frame', clipId, atFrame: 31, durationFrames: 17}, duration: 17, suffix: 107},
    ];
    const transports = [
      {name: 'http', preview: action => rpc('sequence.preview', {requestId: randomUUID(),
        speedIntent: {side: 'timeline', operation: action}}),
      commit: input => rpc('sequence.commit', input), history: () => rpc('sequence.history.get'),
      travel: (action, input) => rpc('sequence.' + action, input)},
      {name: 'cli', preview: action => cli(['sequence', 'timeline', 'edit'], action),
        commit: input => cli(['sequence', 'action', 'commit'], input), history: () => cli(['sequence', 'history', 'get'], {}),
        travel: (action, input) => cli(['sequence', action], input)},
      {name: 'mcp', preview: action => mcpTool('sequence_timeline_edit', action),
        commit: input => mcpTool('sequence_action_commit', input), history: () => mcpTool('sequence_history_get', {}),
        travel: (action, input) => mcpTool('sequence_' + action, input)},
    ];
    const prefix = projectApiPath(projectId, 'agent', 'tasks', 'v2');
    const {authorization} = await request(prefix);
    await request('/api/rpc', {operation: 'agent.authorization.grant', input: {
      requestId: randomUUID(), expectedRevision: authorization.revision, expectedSettingsRevision: execution.revision,
      destination: deriveAgentEndpoint(execution.configuration), model: execution.configuration.model, scope: 'project_agent',
    }});

    const observed = [];
    for (const {action, duration, suffix} of operations) {
      let reference;
      for (const route of transports) {
        const plan = await route.preview(action);
        assert.deepEqual(plan.envelope.speedIntent.operation, action);
        assert.deepEqual(normalizeTimeline(await read()), baseline, route.name + ' preview must be read-only');
        const input = receiptInput(plan);
        const receipt = await route.commit(input);
        assert.equal(receipt.status, 'applied', route.name);
        assert.deepEqual(await route.commit(input), receipt, route.name + ' commit replay');
        const applied = await read();
        const appliedProjection = normalizeTimeline(applied);
        if (reference) assert.deepEqual(appliedProjection, reference, route.name + ' differs from HTTP');
        else reference = appliedProjection;
        for (const direction of ['undo', 'redo', 'undo']) {
          const history = await route.history();
          assert.equal(history[direction]?.actionId, receipt.actionId, route.name + ' history action');
          const travelled = await route.travel(direction, {origin: 'user', requestId: randomUUID(),
            actionId: receipt.actionId, expected: {position: history.position, revision: history.revision}});
          assert.equal(travelled.status, 'applied');
          assert.deepEqual((await read()).clips, direction === 'undo' ? initial.clips : applied.clips,
            route.name + ' ' + direction + ' changes stable clip identities');
        }
      }
      rounds.push(
        [{id: 'load_speed', name: 'mioon_tools_load', arguments: {names: [editTool]}}],
        [{id: 'apply_speed', name: editTool, arguments: action}],
      );
      const sent = await request(prefix, {requestId: randomUUID(), text: 'Apply a synthetic speed edit.',
        expectedSettingsRevision: execution.revision, locale: 'en'});
      const runPath = prefix + '/' + sent.run.id;
      const waiting = await settleMio(request, runPath);
      assert.equal(waiting.run.status, 'awaiting_approval', 'Mio should stop for the speed action approval');
      const step = waiting.steps.find(item => item.toolCall?.id === 'apply_speed');
      assert.equal(step?.tier, 'local_reversible');
      assert.deepEqual(normalizeTimeline(await read()), baseline, 'Mio approval must precede the mutation');
      const approve = {action: 'approve', stepId: step.id, requestId: randomUUID(), expectedRevision: waiting.run.revision};
      await request(runPath + '/actions', approve);
      const completed = await settleMio(request, runPath);
      assert.equal(completed.run.status, 'completed');
      const finished = completed.steps.find(item => item.id === step.id);
      assert.equal(finished?.result?.speed?.durationFrames, duration, 'Mio summary duration');
      assert.equal(completed.changes.length, 1, 'Mio should apply a single change');
      const final = await read();
      assert.deepEqual(normalizeTimeline(final), reference, 'Mio differs from HTTP, CLI or MCP');
      assert.equal(final.clips.find(clip => clip.id === suffixId)?.startFrame, suffix, 'suffix moves by the same amount');
      if (action.kind === 'freeze-frame') {
        assert.deepEqual(final.clips.find(clip => clip.timing?.profile === 'timeline-freeze-v1')?.timing,
          {profile: 'timeline-freeze-v1', sourceFrame: 31, sourceVersionId: null, sourceSha256});
      } else {
        const timed = final.clips.find(clip => clip.id === clipId);
        assert.equal(timed?.durationFrames, duration);
        assert.equal(timed.timing.profile, 'timeline-speed-v1');
        assert.deepEqual(timed.timing.basis.speed, action.setting.speed);
        assert.equal(timed.timing.view.direction, action.setting.direction);
        assert.equal(timed.timing.interpolation, action.setting.interpolation);
      }
      await request(runPath + '/actions', approve);
      assert.deepEqual((await read()).clips, final.clips, 'Mio approval replay');
      const reverted = await request(runPath + '/actions', {action: 'undo_change', changeId: completed.changes[0].id,
        requestId: randomUUID(), expectedRevision: completed.run.revision});
      assert.equal(reverted.changes[0]?.status, 'reverted');
      assert.deepEqual((await read()).clips, initial.clips, 'Mio undo restores the same timeline');
      observed.push({action: action.kind, durationFrames: duration, suffixStartFrame: suffix,
        transports: ['http', 'cli', 'mcp', 'mio'], replay: true, undo: true, redo: ['http', 'cli', 'mcp']});
    }
    return {actions: observed, sourceFrames: 90};
  } finally {
    // Close every acquired port even if an earlier cleanup rejects.
    try {
      if (mcp) await mcp.close();
    } finally {
      try {
        if (server) await server.close();
      } finally {
        await settings.close();
      }
    }
  }
}

export const scenarios = [{id: 'four-entry-parity', run: fourRoutes}];

import {randomUUID} from 'node:crypto';
import type {AgentTaskJournal, AgentTaskStepInput} from '../../packages/business/src/agent/task-journal-v2.ts';
import type {AgentTaskJson, AgentTaskToolCall} from '../../packages/contracts/src/agent-tasks-v2.ts';

export const mioFixtureConfiguration = {protocol: 'chat_completions', model: 'synthetic'};

/** A native journal tool always refers to a completed canonical model output.
 * These fixtures exercise journal/tool behavior without sending a model request;
 * both the frozen request and provider reply still use their real wire shape. */
export function beginFixtureModelStep(journal: AgentTaskJournal, runId: string, calls: AgentTaskToolCall[] = []) {
  const run = journal.run(runId), configuration = run.configuration as {protocol?: string; model?: string};
  const protocol = configuration.protocol ?? 'chat_completions', model = configuration.model ?? 'synthetic';
  const history: AgentTaskJson[] = [{role: 'user', content: run.text}];
  const body = JSON.stringify({model, stream: true, ...(protocol === 'responses' ? {input: history} : {messages: history})});
  const baseline = journal.revisionSnapshot(run.projectId).map(({kind, id, revision}) => ({kind, id, revision}));
  const step = journal.beginModelStep(runId, {request: {body, history}, data: {baseline}}, (run.notes ?? []).filter(note => !note.modelStepId).map(note => note.requestId));
  function complete(text = '') {
    journal.markDispatch(runId, step.id);
    const providerOutput: AgentTaskJson = protocol === 'responses'
      ? [...(text ? [{type: 'message', role: 'assistant', content: [{type: 'output_text', text}]}] : []), ...calls.map(call => ({type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments)}))]
      : protocol === 'anthropic_messages'
        ? {role: 'assistant', content: [...(text ? [{type: 'text', text}] : []), ...calls.map(call => ({type: 'tool_use', id: call.id, name: call.name, input: call.arguments}))]}
        : {role: 'assistant', content: text, ...(calls.length ? {tool_calls: calls.map(call => ({id: call.id, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.arguments)}}))} : {})};
    journal.completeStep(runId, step.id, {result: {text, toolCalls: calls as unknown as AgentTaskJson[], providerOutput}});
  }
  return {step, body, history, complete};
}

export function beginFixtureToolStep(journal: AgentTaskJournal, runId: string, input: Omit<AgentTaskStepInput, 'kind'>) {
  const call = input.toolCall ?? {id: randomUUID(), name: 'mioon_project_inspect', arguments: {}};
  const model = beginFixtureModelStep(journal, runId, [call]);
  model.complete();
  const data = input.data !== null && typeof input.data === 'object' && !Array.isArray(input.data) ? input.data : {};
  return journal.beginStep(runId, {...input, kind: 'tool', toolCall: call, data: {...data, sourceModelStepId: model.step.id}});
}

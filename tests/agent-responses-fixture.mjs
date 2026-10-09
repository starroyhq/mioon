/** Independent synthetic native-Responses wire producer, never a provider call.
 * Used by HTTP/UI acceptance; production adapters do not import this module. */
export function responsesFixture({id = 'resp_synthetic', model = 'qwen3:8b'} = {}) {
  const itemId = `msg_${id}`, createdAt = 1;
  let sequence = 0, text = '';
  const part = () => ({type: 'output_text', text, annotations: [], logprobs: []});
  const item = status => ({id: itemId, type: 'message', status, role: 'assistant', content: status === 'in_progress' ? [] : [part()]});
  const response = (status, extra = {}) => ({id, object: 'response', created_at: createdAt, model, status,
    error: null, incomplete_details: null, output: status === 'in_progress' ? [] : [item('completed')],
    store: false, reasoning: {effort: null, summary: null}, ...extra});
  const event = (type, values) => ({type, sequence_number: sequence++, ...values});
  const seal = () => [event('response.output_text.done', {item_id: itemId, output_index: 0, content_index: 0, text, logprobs: []}),
    event('response.content_part.done', {item_id: itemId, output_index: 0, content_index: 0, part: part()}),
    event('response.output_item.done', {output_index: 0, item: item('completed')})];
  return {
    start: () => [event('response.created', {response: response('in_progress')}),
      event('response.in_progress', {response: response('in_progress')}),
      event('response.output_item.added', {output_index: 0, item: item('in_progress')}),
      event('response.content_part.added', {item_id: itemId, output_index: 0, content_index: 0, part: part()})],
    delta: delta => { text += delta; return event('response.output_text.delta', {item_id: itemId, output_index: 0, content_index: 0, delta, logprobs: []}); },
    seal,
    complete: () => [...seal(),
      event('response.completed', {response: response('completed', {usage: {input_tokens: 10, output_tokens: 20, total_tokens: 30}})})],
    incomplete: () => event('response.incomplete', {response: response('incomplete', {incomplete_details: {reason: 'max_output_tokens'}})}),
    failure: () => event('response.failed', {response: response('failed', {error: {code: 'server_error', message: 'Synthetic provider error; never display raw payload'}})}),
    tool: () => event('response.output_item.added', {output_index: 1, item: {id: `fc_${id}`, type: 'function_call', status: 'in_progress', call_id: `call_${id}`, name: 'read_project', arguments: ''}}),
    reasoning: () => event('response.output_item.added', {output_index: 1, item: {id: `rs_${id}`, type: 'reasoning', summary: []}}),
    unknown: () => event('response.unknown_semantic_output', {payload: 'Synthetic unsupported event'}),
  };
}
export const frameResponsesEvent = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;

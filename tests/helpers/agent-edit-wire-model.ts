/** Owned loopback-only provider fixture. Production code never imports this file.
 * Emits fragmented native SSE for both supported protocols and keeps complete
 * synthetic request bodies so acceptance can assert exact tool linkage. */
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {ownedModelCloser} from './agent-edit-wire-lifecycle.ts';
import {responsesFixture, frameResponsesEvent} from '../agent-responses-fixture.mjs';

const frame = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
export const PROPOSED_TITLE = 'Reviewed synthetic title 🎬';
export const PROPOSED_PROMPT = 'Reviewed synthetic prompt. Saved only after explicit approval.';
export const PROPOSAL_FUNCTION = 'mioon_propose_shot_update';

export async function startEditWireModel({port = 0} = {}) {
  const captures = [], errors = [], queued = [], calls = new Map(), held = new Map(), sockets = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || !['/v1/chat/completions', '/v1/responses'].includes(req.url)) return res.writeHead(404).end();
      const buffers = []; let size = 0;
      for await (const buffer of req) { size += buffer.length; if (size > 256 * 1024) return res.writeHead(413).end(); buffers.push(buffer); }
      const body = JSON.parse(Buffer.concat(buffers).toString()), protocol = req.url.endsWith('/responses') ? 'responses' : 'chat_completions';
      const items = protocol === 'responses' ? body.input : body.messages;
      if (!Array.isArray(items)) throw Error('Missing native input history');
      const output = protocol === 'responses' ? items.findLast(item => item.type === 'function_call_output') : items.findLast(item => item.role === 'tool');
      const phase = output ? 'answer' : 'request', previous = output && calls.get(protocol === 'responses' ? output.call_id : output.tool_call_id);
      const plan = previous?.plan || queued.shift() || {};
      if (output && !previous) throw Error('Answer does not match an emitted tool call');
      const id = captures.length + 1, callId = previous?.callId || `call_${randomUUID()}`, itemId = `fc_${randomUUID()}`;
      const capture = {id, protocol, phase, callId, method: req.method, path: req.url, body, headers: req.headers, closed: false, completed: false};
      captures.push(capture); sockets.add(res);
      res.once('close', () => { capture.closed = true; sockets.delete(res); held.delete(`${phase}:${id}`); });
      res.on('error', () => {});
      const send = source => {
        const encoded = Buffer.from(source);
        // Seven-byte chunks split JSON syntax, function arguments and UTF-8.
        for (let offset = 0; offset < encoded.length && !res.destroyed; offset += 7) res.write(encoded.subarray(offset, offset + 7));
      };
      const end = source => { if (!res.destroyed) { capture.completed = true; res.end(source); } };
      const hold = async () => new Promise(resolve => {
        const key = `${phase}:${id}`, finish = () => { held.delete(key); res.off('close', finish); resolve(); };
        held.set(key, finish); res.once('close', finish);
      });
      const cc = (delta = {}, finish_reason = null) => ({id: `synthetic_${id}`, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{index: 0, delta, finish_reason}]});
      res.writeHead(200, {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store'});
      send(': synthetic reviewed-edit wire fixture\n\n');
      if (plan.error === phase) return end(protocol === 'responses' ? frameResponsesEvent({type: 'error', sequence_number: 0, message: 'Synthetic provider failure'}) : frame({error: {message: 'Synthetic provider failure'}}));
      if (phase === 'request' && plan.noCall !== true || phase === 'answer' && plan.secondTool === true) {
        const name = plan.name || PROPOSAL_FUNCTION;
        const argumentsJson = typeof plan.rawArguments === 'string' ? plan.rawArguments : JSON.stringify(plan.arguments || {title: PROPOSED_TITLE, prompt: PROPOSED_PROMPT});
        calls.set(callId, {callId, protocol, plan, argumentsJson, name});
        if (protocol === 'responses') {
          let sequence = 0;
          const event = (type, values) => ({type, sequence_number: sequence++, ...values});
          const envelope = (status, output = []) => ({id: `resp_synthetic_${id}`, object: 'response', status, output, error: null, incomplete_details: null});
          const item = status => ({id: itemId, type: 'function_call', call_id: callId, name, status, arguments: status === 'in_progress' ? '' : argumentsJson});
          send(frameResponsesEvent(event('response.created', {response: envelope('in_progress')})));
          send(frameResponsesEvent(event('response.in_progress', {response: envelope('in_progress')})));
          send(frameResponsesEvent(event('response.output_item.added', {output_index: 0, item: item('in_progress')})));
          send(frameResponsesEvent(event('response.function_call_arguments.delta', {output_index: 0, item_id: itemId, delta: argumentsJson.slice(0, 1)})));
          if (plan.hold === phase) await hold();
          if (res.destroyed) return;
          if (plan.truncate === phase) return end('');
          send(frameResponsesEvent(event('response.function_call_arguments.delta', {output_index: 0, item_id: itemId, delta: argumentsJson.slice(1)})));
          send(frameResponsesEvent(event('response.function_call_arguments.done', {output_index: 0, item_id: itemId, arguments: argumentsJson})));
          send(frameResponsesEvent(event('response.output_item.done', {output_index: 0, item: item('completed')})));
          end(frameResponsesEvent(event('response.completed', {response: envelope('completed', [item('completed')])})));
        } else {
          send(frame(cc({role: 'assistant'})));
          send(frame(cc({tool_calls: [{index: 0, id: callId, type: 'function', function: {name, arguments: argumentsJson.slice(0, 1)}}]})));
          if (plan.hold === phase) await hold();
          if (res.destroyed) return;
          if (plan.truncate === phase) return end('');
          send(frame(cc({tool_calls: [{index: 0, function: {arguments: argumentsJson.slice(1)}}]})));
          send(frame(cc({}, 'tool_calls'))); end(frame('[DONE]'));
        }
        return;
      }
      const native = protocol === 'responses' ? responsesFixture({id: `resp_answer_${id}`}) : null;
      if (native) for (const event of native.start()) send(frameResponsesEvent(event));
      else send(frame(cc({role: 'assistant'})));
      const text = phase === 'answer' ? 'Synthetic proposal prepared. Waiting for your separate approval.' : 'Synthetic text only; no edit proposed.';
      send(native ? frameResponsesEvent(native.delta(text)) : frame(cc({content: text})));
      if (plan.hold === phase) await hold();
      if (res.destroyed) return;
      if (plan.truncate === phase) return end('');
      end(native ? native.complete().map(frameResponsesEvent).join('') : frame(cc({}, 'stop')) + frame('[DONE]'));
    } catch (error) { errors.push(error.message); res.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {baseUrl: `http://127.0.0.1:${server.address().port}/v1`, captures, errors,
    snapshot: () => ({captures: structuredClone(captures), errors: [...errors], active: sockets.size, calls: captures.length, held: [...held.keys()]}),
    plan: value => queued.push(structuredClone(value)),
    held: () => [...held.keys()],
    release(phase) { for (const [key, resolve] of [...held]) if (key.startsWith(`${phase}:`)) resolve(); },
    close: ownedModelCloser(server, sockets),
  };
}

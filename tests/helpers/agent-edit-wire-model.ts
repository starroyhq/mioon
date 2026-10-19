/** Owned loopback-only provider fixture. Production code never imports this file.
 * Emits fragmented native SSE for both supported protocols and keeps complete
 * synthetic request bodies so acceptance can assert exact tool linkage. */
import http from 'node:http';
import type {ServerResponse} from 'node:http';
import {randomUUID} from 'node:crypto';
import {ownedModelCloser} from './agent-edit-wire-lifecycle.ts';
import {responsesFixture, frameResponsesEvent} from '../agent-responses-fixture.mjs';

const frame = (value: unknown): string => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
export const PROPOSED_TITLE = 'Reviewed synthetic title 🎬';
export const PROPOSED_PROMPT = 'Reviewed synthetic prompt. Saved only after explicit approval.';
export const PROPOSAL_FUNCTION = 'mioon_propose_shot_update';

interface WireCapture {readonly id: number; readonly protocol: string; readonly phase: string; readonly callId: string; readonly method: string|undefined; readonly path: string|undefined; readonly body: Record<string, unknown>; readonly headers: unknown; closed: boolean; completed: boolean}
interface WireCall {readonly callId: string; readonly protocol: string; readonly plan: Record<string, unknown>; readonly argumentsJson: string; readonly name: string}
export async function startEditWireModel({port = 0}: {readonly port?: number} = {}) {
  const captures: WireCapture[] = [], errors: string[] = [], queued: Record<string, unknown>[] = [], calls = new Map<string,WireCall>(), held = new Map<string,()=>void>(), sockets = new Set<ServerResponse>();
  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = req.url ?? '';
      if (req.method !== 'POST' || !['/v1/chat/completions', '/v1/responses'].includes(requestUrl)) return res.writeHead(404).end();
      const buffers = []; let size = 0;
      for await (const buffer of req) { size += buffer.length; if (size > 256 * 1024) return res.writeHead(413).end(); buffers.push(buffer); }
      const body = JSON.parse(Buffer.concat(buffers).toString()) as Record<string, unknown>, protocol = requestUrl.endsWith('/responses') ? 'responses' : 'chat_completions';
      const items = (protocol === 'responses' ? body.input : body.messages) as unknown[] | undefined;
      if (!Array.isArray(items)) throw Error('Missing native input history');
      const last = (predicate: (item: Record<string, unknown>)=>boolean): Record<string, unknown>|undefined => [...items].reverse().find(item => predicate(item as Record<string, unknown>)) as Record<string, unknown>|undefined;
      const output = protocol === 'responses' ? last(item => item.type === 'function_call_output') : last(item => item.role === 'tool');
      const phase = output ? 'answer' : 'request', previous = output && calls.get(String(protocol === 'responses' ? output.call_id : output.tool_call_id));
      const plan: Record<string, unknown> = previous?.plan || queued.shift() || {};
      if (output && !previous) throw Error('Answer does not match an emitted tool call');
      const id = captures.length + 1, callId = previous?.callId || `call_${randomUUID()}`, itemId = `fc_${randomUUID()}`;
      const capture: WireCapture = {id, protocol, phase, callId, method: req.method, path: requestUrl, body, headers: req.headers, closed: false, completed: false};
      captures.push(capture); sockets.add(res);
      res.once('close', () => { capture.closed = true; sockets.delete(res); held.delete(`${phase}:${id}`); });
      res.on('error', () => {});
      const send = (source: string|Buffer): void => {
        const encoded = Buffer.from(source);
        // Seven-byte chunks split JSON syntax, function arguments and UTF-8.
        for (let offset = 0; offset < encoded.length && !res.destroyed; offset += 7) res.write(encoded.subarray(offset, offset + 7));
      };
      const end = (source: string): void => { if (!res.destroyed) { capture.completed = true; res.end(source); } };
      const hold = async () => new Promise<void>(resolve => {
        const key = `${phase}:${id}`, finish = () => { held.delete(key); res.off('close', finish); resolve(); };
        held.set(key, finish); res.once('close', finish);
      });
      const cc = (delta: Record<string, unknown> = {}, finish_reason: string|null = null) => ({id: `synthetic_${id}`, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{index: 0, delta, finish_reason}]});
      res.writeHead(200, {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store'});
      send(': synthetic reviewed-edit wire fixture\n\n');
      if (plan.error === phase) return end(protocol === 'responses' ? frameResponsesEvent({type: 'error', sequence_number: 0, message: 'Synthetic provider failure'}) : frame({error: {message: 'Synthetic provider failure'}}));
      if (phase === 'request' && plan.noCall !== true || phase === 'answer' && plan.secondTool === true) {
        const name = typeof plan.name === 'string' && plan.name ? plan.name : PROPOSAL_FUNCTION;
        const argumentsJson = typeof plan.rawArguments === 'string' ? plan.rawArguments : JSON.stringify(plan.arguments || {title: PROPOSED_TITLE, prompt: PROPOSED_PROMPT});
        calls.set(callId, {callId, protocol, plan, argumentsJson, name});
        if (protocol === 'responses') {
          let sequence = 0;
          const event = (type: string, values: Record<string, unknown>) => ({type, sequence_number: sequence++, ...values});
          const envelope = (status: string, output: unknown[] = []) => ({id: `resp_synthetic_${id}`, object: 'response', status, output, error: null, incomplete_details: null});
          const item = (status: string) => ({id: itemId, type: 'function_call', call_id: callId, name, status, arguments: status === 'in_progress' ? '' : argumentsJson});
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
      if (native) for (const event of native.start()) send(frameResponsesEvent(event as never));
      else send(frame(cc({role: 'assistant'})));
      const text = phase === 'answer' ? 'Synthetic proposal prepared. Waiting for your separate approval.' : 'Synthetic text only; no edit proposed.';
      send(native ? frameResponsesEvent(native.delta(text)) : frame(cc({content: text})));
      if (plan.hold === phase) await hold();
      if (res.destroyed) return;
      if (plan.truncate === phase) return end('');
      end(native ? native.complete().map((event: unknown)=>frameResponsesEvent(event as never)).join('') : frame(cc({}, 'stop')) + frame('[DONE]'));
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); res.destroy(); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address(); return {baseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`, captures, errors,
    snapshot: () => ({captures: structuredClone(captures), errors: [...errors], active: sockets.size, calls: captures.length, held: [...held.keys()]}),
    plan: (value: Record<string, unknown>) => queued.push(structuredClone(value)),
    held: () => [...held.keys()],
    release(phase: string) { for (const [key, resolve] of [...held]) if (key.startsWith(`${phase}:`)) resolve(); },
    close: ownedModelCloser(server, sockets),
  };
}

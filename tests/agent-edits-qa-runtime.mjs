/** Actual browser backend and owned synthetic HTTP model. No renderer hooks. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {appendFileSync, writeFileSync} from 'node:fs';
import {startServer} from '../apps/server/src/index.mjs';
import {EDIT_QA_REPO, EDIT_QA_TOKEN, prepareEditQaFixture, seedEditQaSettings, clearEditQaEnvironment,
  startEditQaModel, startEditQaMailbox, jsonFile} from './helpers/agent-edits-qa-support.mjs';

export async function startEditsQaRuntime({protocol = 'responses'} = {}) {
  clearEditQaEnvironment(process.env);
  const fixture = await prepareEditQaFixture('browser'), model = await startEditQaModel(fixture);
  let backend, mailbox, closing, armed = false;
  const startedAt = new Date().toISOString();
  const agentEditFault = boundary => {
    const fired = armed && boundary === 'beforeAcknowledgement';
    appendFileSync(path.join(fixture.runtime, 'fault-events.jsonl'), JSON.stringify({at: new Date().toISOString(), boundary, fired}) + '\n');
    if (fired) {
      armed = false;
      writeFileSync(path.join(fixture.runtime, 'fault-observed.json'), JSON.stringify({at: new Date().toISOString(), boundary, injected: true}));
      throw Error('Synthetic lost approval acknowledgement after persisted outcome');
    }
  };
  const launch = () => startServer({dataDir: fixture.workspace, port: 4896, token: EDIT_QA_TOKEN,
    distDir: path.join(EDIT_QA_REPO, 'apps/web/dist'), agentEditFault});
  const descriptor = () => jsonFile(path.join(fixture.runtime, 'server.json'), {url: backend.url, startedAt, pid: process.pid,
    workspace: fixture.workspace, mockBaseUrl: model.baseUrl, protocol, synthetic: true, ordinaryBackend: true});
  const close = () => closing ??= (async () => {
    await mailbox?.close();
    try { await backend?.close(); } finally { await model.close(); }
    await jsonFile(path.join(fixture.runtime, 'exit.json'), {startedAt, endedAt: new Date().toISOString(), closed: true, synthetic: true});
  })();
  try {
    await seedEditQaSettings(fixture.workspace, model.baseUrl, protocol);
    backend = await launch(); await descriptor();
    mailbox = await startEditQaMailbox(fixture, model, {
      async restart() { await backend.close(); backend = await launch(); await descriptor(); return {restarted: true, url: backend.url}; },
      async fault(item) {
        if (item.boundary !== 'beforeAcknowledgement' || armed) throw Error('Only one pending beforeAcknowledgement fault is allowed');
        armed = true; return {armed: item.boundary, once: true};
      },
    });
    return {fixture, model, close, url: backend.url};
  } catch (error) { await close().catch(() => {}); throw error; }
}
const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct && process.argv.includes('--prepare')) console.log(JSON.stringify(await prepareEditQaFixture('browser'), null, 2));
if (direct && process.argv.includes('--serve')) {
  const runtime = await startEditsQaRuntime({protocol: process.argv.includes('--chat-completions') ? 'chat_completions' : 'responses'});
  console.log(`AGENT_EDITS_SYNTHETIC_QA_READY ${runtime.url}`);
  const close = () => runtime.close().catch(error => { console.error(error); process.exitCode = 1; });
  process.once('SIGTERM', close); process.once('SIGINT', close);
}

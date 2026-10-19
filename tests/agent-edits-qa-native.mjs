/** Ordinary sandboxed Electron build with a preserved synthetic workspace and
 * loopback model port. No CDP, smoke hooks, security flags or renderer control. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir, appendFile, readFile} from 'node:fs/promises';
import {EDIT_QA_REPO, prepareEditQaFixture, clearEditQaEnvironment, seedEditQaSettings, startEditQaModel,
  startEditQaMailbox, assertNativeFixtureClosed, jsonFile, editQaAudit} from './helpers/agent-edits-qa-support.ts';

export async function startEditsQaNative({protocol = 'responses'} = {}) {
  await assertNativeFixtureClosed();
  const fixture = await prepareEditQaFixture('native'), model = await startEditQaModel(fixture, {label: 'native'});
  let child, mailbox, closing, exited, logTail = Promise.resolve(), ended = false;
  const startedAt = new Date().toISOString(), launchId = model.sessionId, launches = path.join(fixture.runtime, 'launches');
  await mkdir(launches, {recursive: true});
  const close = (result = {}) => closing ??= (async () => {
    await mailbox?.close(); await model.close(); await logTail;
    const audit = await editQaAudit(fixture, model, `exit-${launchId}`);
    const record = {startedAt, endedAt: new Date().toISOString(), launchId, closed: !child?.pid || ended, synthetic: true, ...result, databaseHash: audit.hash, model: audit.model};
    await jsonFile(path.join(launches, `${launchId}.exit.json`), record);
    await jsonFile(path.join(fixture.runtime, 'exit.json'), record);
  })();
  try {
    // Native main reads this same nonsecret envelope through its ordinary store.
    await seedEditQaSettings(fixture.userData, model.baseUrl, protocol);
    const require = createRequire(import.meta.url), binary = require('electron');
    const env = clearEditQaEnvironment({...process.env, MIOON_DESKTOP_USER_DATA: fixture.userData,
      MIOON_FFMPEG_PATH: '/usr/bin/ffmpeg', MIOON_FFPROBE_PATH: '/usr/bin/ffprobe'});
    child = spawn(binary, [path.join(EDIT_QA_REPO, 'apps/desktop/build')], {cwd: EDIT_QA_REPO, env, stdio: ['ignore', 'pipe', 'pipe']});
    exited = new Promise((resolve, reject) => {
      child.once('error', error => { ended = true; close({error: error.message}).then(() => reject(error), reject); });
      child.once('exit', (code, signal) => { ended = true; close({code, signal}).then(() => resolve({code, signal}), reject); });
    });
    exited.catch(() => {}); // Startup may still be waiting for the ordinary connection file.
    const launch = {startedAt, launchId, pid: child.pid, fixturePid: process.pid, binary, workspace: fixture.workspace,
      userData: fixture.userData, mockBaseUrl: model.baseUrl, protocol, synthetic: true, simulated: true,
      sandboxUnchanged: true, remoteDebugging: false, smokeHooks: false};
    await jsonFile(path.join(launches, `${launchId}.json`), launch);
    await jsonFile(path.join(fixture.runtime, 'launch.json'), launch);
    for (const [kind, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) stream.on('data', bytes => {
      logTail = logTail.then(async () => {
        await appendFile(path.join(launches, `${launchId}.${kind}.log`), bytes);
        await appendFile(path.join(fixture.runtime, 'electron.log'), bytes);
      });
    });
    mailbox = await startEditQaMailbox(fixture, model);
    // Read the ordinary connection descriptor only for readiness. Its random
    // app auth token is never copied, overridden, logged or used by this fixture.
    const deadline = Date.now() + 30000; let ready;
    while (!ready && Date.now() < deadline && !ended) {
      try {
        const connection = JSON.parse(await readFile(path.join(fixture.userData, 'mcp-connection.json'), 'utf8'));
        const url = new URL(connection.url);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !Number.isSafeInteger(connection.pid) || connection.pid <= 1) throw Error('Invalid ordinary native backend connection');
        if (process.platform === 'linux') {
          const status = await readFile(`/proc/${connection.pid}/status`, 'utf8');
          if (Number(/^PPid:\s+(\d+)$/mu.exec(status)?.[1]) !== child.pid) throw Error('Native backend does not belong to this launch');
        }
        ready = {url: connection.url, pid: connection.pid};
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 80));
    }
    if (!ready) throw Error(ended ? 'Ordinary Electron exited before backend readiness' : 'Ordinary Electron backend readiness timed out');
    await jsonFile(path.join(fixture.runtime, 'server.json'), {...ready, launchId, mainPid: child.pid, fixturePid: process.pid, synthetic: true});
    return {fixture, model, child, exited, launch};
  } catch (error) {
    if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (exited && !ended) {
      let timer;
      await Promise.race([exited.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 10000); })]).finally(() => clearTimeout(timer));
    }
    await close({error: error.message}).catch(() => {}); throw error;
  }
}
const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  if (process.argv.includes('--prepare')) {
    await assertNativeFixtureClosed(); console.log(JSON.stringify(await prepareEditQaFixture('native'), null, 2));
  } else {
    const runtime = await startEditsQaNative({protocol: process.argv.includes('--chat-completions') ? 'chat_completions' : 'responses'});
    console.log(`AGENT_EDITS_NATIVE_QA_READY ${runtime.launch.pid}`);
    const stop = () => { if (runtime.child.exitCode === null && runtime.child.signalCode === null) runtime.child.kill('SIGTERM'); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const result = await runtime.exited; process.exitCode = result.code || (result.signal ? 1 : 0);
  }
}

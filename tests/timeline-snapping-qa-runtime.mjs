/** Local-only browser failure fixture; not part of production startup.
 * Uses the real authenticated HTTP/SQLite/worker stack behind a strict loopback
 * proxy. fault.json can consume ONE exact operation response after backend
 * acceptance (drop or hold until fault-release exists). No domain responses
 * are fabricated. UI interactions still use the supported CUA browser APIs.
 */
import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile, access, unlink } from 'node:fs/promises';
import {writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {readPrivateFile} from '@mioon/contracts/private-storage';
import {parseProjectApiPath} from '../packages/contracts/src/project-file.ts';
import { startServer } from './helpers/test-server.ts';
const runtime = path.resolve(process.env.MIOON_QA_RUNTIME || 'evidence/timeline-snapping/runtime');
if (!runtime.endsWith('/evidence/timeline-snapping/runtime')) throw Error('Disposable timeline-snapping runtime required');
await import('./timeline-snapping-qa-seed.mjs');
const fixture=JSON.parse(await readFile(path.join(runtime,'fixture.json'),'utf8')),projectIds=[fixture.project.id,fixture.second.id];
if(fixture.assetReferenceFixture!==1)throw Error('Historical pre-reference snapping fixture must be preserved');
let inspectProject;
const backend = await startServer({inspectProject:received=>{inspectProject=received;}, dataDir: path.join(runtime, 'data'), port: 0, token: 'timeline-snapping-local-synthetic-token', distDir: path.resolve('apps/web/dist') });
const port=Number(process.env.MIOON_QA_PORT||4878);if(!Number.isSafeInteger(port)||port<0||port>65535)throw Error('Invalid QA port');
let host,origin,observationSequence=0;
const observationFile=path.join(runtime,'project-observation.json');
function observeProjects(){
 const existing=readPrivateFile(observationFile,{root:runtime,private:true,allowMissing:true,maxBytes:4*1024*1024});
 if(existing&&JSON.parse(existing.toString('utf8')).fixtureId!==fixture.fixtureId)throw Error('Foreign snapshot must be preserved');
 const projects=Object.fromEntries(projectIds.map(projectId=>[projectId,inspectProject(projectId,db=>{
  const row=db.prepare(`SELECT CASE WHEN length(CAST(t.data AS BLOB))<=4194304 THEN t.data END AS data,coalesce(c.position,0) AS position FROM timelines t LEFT JOIN timeline_history_cursors c ON c.projectId=t.projectId WHERE t.projectId=? LIMIT 1`).get(projectId);
  if(!row||typeof row.data!=='string'||!Number.isSafeInteger(row.position)||row.position<0)throw Error('Invalid actual snapping observation');
  const timeline=JSON.parse(row.data);if(timeline.projectId!==projectId)throw Error('Snapping observation owner differs');
  return {timeline,cursor:row.position};
 })]));
 const temporary=observationFile+'.'+randomUUID()+'.tmp';
 try{writeFileSync(temporary,JSON.stringify({version:1,fixtureId:fixture.fixtureId,dataDir:fixture.dataDir,sequence:++observationSequence,projects}),{mode:0o600,flag:'wx'});renameSync(temporary,observationFile);}catch(error){try{unlinkSync(temporary);}catch(cleanup){if(cleanup.code!=='ENOENT')throw new AggregateError([error,cleanup],'Snapshot publication failed');}throw error;}
}
observeProjects();
const faultPath = path.join(runtime, 'fault.json'), releasePath = path.join(runtime, 'fault-release');
let seq = 0;
const server = http.createServer(async (req, res) => {
  if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin)) return res.writeHead(403).end('QA origin rejected');
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  let operation = null, input = null;
  try { ({operation,input} = JSON.parse(body)); } catch {}
  let fault;
  try { const candidate = JSON.parse(await readFile(faultPath, 'utf8')); if (candidate.operation === operation) { fault = candidate; await unlink(faultPath); } } catch {}
  const headers = { ...req.headers, host: new URL(backend.url).host };
  if (headers.origin) headers.origin = backend.url;
  const route=parseProjectApiPath(new URL(req.url,origin).pathname),rpc=req.method==='POST'&&typeof operation==='string'&&(route?.kind==='rpc'||req.url==='/api/rpc');
  const upstream = http.request(backend.url + req.url, { method: req.method, headers }, async response => {
    if (rpc || fault) {
     try{
      const parts = []; for await (const chunk of response) parts.push(chunk);
      const bytes = Buffer.concat(parts);
      if(rpc)observeProjects(); // Actual COMMIT is complete; publish before any ACK/drop/hold.
      if(!fault){res.writeHead(response.statusCode,response.headers);res.end(bytes);return;}
      const id=++seq;
      await writeFile(path.join(runtime, `fault-observed-${id}.json`), JSON.stringify({ operation, input, fault: fault.kind, status: response.statusCode, body: JSON.parse(bytes), acceptedAt: new Date().toISOString() }, null, 2));
      if (fault.kind === 'drop') { res.writeHead(200, { 'content-type': 'application/json', 'content-length': 1 }); res.end(bytes.subarray(0, 1)); return; }
      if (fault.kind === 'hold') {
        // Test orchestration releases this real accepted response explicitly.
        for (;;) { try { await access(releasePath); await unlink(releasePath); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); } }
      }
      res.writeHead(response.statusCode, response.headers); res.end(bytes); return;
     }catch(error){if(!res.headersSent)res.writeHead(502);res.end();console.error('Snapping QA observation failed',error);return;}
    }
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  upstream.end(body);
});
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
const address=server.address();host=`127.0.0.1:${address.port}`;origin=`http://${host}`;
await writeFile(path.join(runtime, 'server.json'), JSON.stringify({ url: origin, backend: backend.url, dataDir: backend.dataDir }, null, 2));
console.log(`Synthetic timeline-snapping browser fixture listening at ${origin}`);
let closing;
async function close() { if (closing) return; closing = true; await writeFile(releasePath, 'release'); await new Promise(resolve => server.close(resolve)); await backend.close(); }
process.on('SIGINT', close); process.on('SIGTERM', close);

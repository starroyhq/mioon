/** Local-only browser failure fixture; not part of production startup.
 * Uses the real authenticated HTTP/SQLite/worker stack behind a strict loopback
 * proxy. fault.json can consume ONE exact operation response after backend
 * acceptance (drop or hold until fault-release exists). No domain responses
 * are fabricated. UI interactions still use the supported CUA browser APIs.
 */
import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile, access, unlink } from 'node:fs/promises';
import { startServer } from '../apps/server/src/index.mjs';
const runtime = path.resolve(process.env.MIOON_QA_RUNTIME || 'evidence/dual-workspace/runtime');
if (!runtime.endsWith('/evidence/dual-workspace/runtime')) throw Error('Disposable dual-workspace runtime required');
process.env.MIOON_ENABLE_LIVE_PROVIDER = '0';
for (const key of Object.keys(process.env)) if (/^(RUNWAY|RUNWAYML|ARK_|VEO_|GEMINI_|MINIMAX_|HAILUO_|VIDU_)/.test(key)) delete process.env[key];
const backend = await startServer({ dataDir: path.join(runtime, 'workspace'), port: 0, token: 'dualmode-local-synthetic-browser-token', distDir: path.resolve('apps/web/dist') });
const port = Number(process.env.MIOON_QA_PORT || 4875), host = `127.0.0.1:${port}`, origin = `http://${host}`;
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
  const upstream = http.request(backend.url + req.url, { method: req.method, headers }, async response => {
    if (fault) {
      const parts = []; for await (const chunk of response) parts.push(chunk);
      const bytes = Buffer.concat(parts), id = ++seq;
      await writeFile(path.join(runtime, `fault-observed-${id}.json`), JSON.stringify({ operation, input, fault: fault.kind, status: response.statusCode, body: JSON.parse(bytes), acceptedAt: new Date().toISOString() }, null, 2));
      if (fault.kind === 'drop') { res.writeHead(200, { 'content-type': 'application/json', 'content-length': 1 }); res.end(bytes.subarray(0, 1)); return; }
      if (fault.kind === 'hold') {
        // Test orchestration releases this real accepted response explicitly.
        for (;;) { try { await access(releasePath); await unlink(releasePath); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); } }
      }
      res.writeHead(response.statusCode, response.headers); res.end(bytes); return;
    }
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  upstream.end(body);
});
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
await writeFile(path.join(runtime, 'server.json'), JSON.stringify({ url: origin, backend: backend.url, dataDir: backend.dataDir }, null, 2));
console.log(`Synthetic dual-workspace browser fixture listening at ${origin}`);
let closing;
async function close() { if (closing) return; closing = true; await writeFile(releasePath, 'release'); await new Promise(resolve => server.close(resolve)); await backend.close(); }
process.on('SIGINT', close); process.on('SIGTERM', close);

// Bounded external-agent controls for the browser regression. The only allowed
// writes are synthetic shot metadata/version selection and timeline track names.
// They execute the actual repository CLI or official SDK MCP client against this
// same backend, then persist the result for test orchestration to inspect.
const allowedExternal=new Set(['project.get','shot.update','version.select','timeline.track.update']);
const {spawn}=await import('node:child_process');
const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
const tokenFile=path.join(runtime,'synthetic-token');await writeFile(tokenFile,'dualmode-local-synthetic-browser-token',{mode:0o600});
let externalBusy=false;
const externalTimer=setInterval(async()=>{
 if(externalBusy||closing)return;
 let task;try{task=JSON.parse(await readFile(path.join(runtime,'external-task.json'),'utf8'));await unlink(path.join(runtime,'external-task.json'));}catch{return;}
 externalBusy=true;let client;
 try{
  if(!allowedExternal.has(task.operation)||!['cli','mcp'].includes(task.transport))throw Error('External QA operation is not allowed');
  const env={...process.env,MIOON_BASE_URL:origin,MIOON_TOKEN_FILE:tokenFile,MIOON_ENABLE_LIVE_PROVIDER:'0'};
  let result;
  if(task.transport==='cli'){
   const child=spawn(process.execPath,[path.resolve('apps/cli/src/index.mjs'),...task.operation.split('.'),'--input','-'],{cwd:path.resolve('.'),env,stdio:['pipe','pipe','pipe']});
   let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.stdin.end(JSON.stringify(task.input));
   const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
   result=JSON.parse(stdout);if(code||!result.ok)throw Error(JSON.stringify({code,result,stderr}));result=result.data;
  }else{
   client=new Client({name:'dual-workspace-qa',version:'1.0.0'},{capabilities:{}});
   const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('apps/mcp/src/index.mjs')],cwd:path.resolve('.'),env,stderr:'pipe'});transport.stderr?.resume();await client.connect(transport);
   const response=await client.callTool({name:task.operation.replaceAll('.','_'),arguments:task.input});if(response.isError)throw Error(JSON.stringify(response));result=response.structuredContent||JSON.parse(response.content.find(c=>c.type==='text').text);
  }
  await writeFile(path.join(runtime,'external-result.json'),JSON.stringify({id:task.id,transport:task.transport,operation:task.operation,ok:true,result},null,2));
 }catch(error){await writeFile(path.join(runtime,'external-result.json'),JSON.stringify({id:task.id,ok:false,error:String(error.stack||error)},null,2));}
 finally{await client?.close();externalBusy=false;}
},150);externalTimer.unref();

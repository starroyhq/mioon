import type {IncomingMessage,ServerResponse} from 'node:http';
import {agentTaskEditingSchema} from '@mioon/contracts/agent-tasks-v2';
import {agentTaskFailure} from '@mioon/business/agent/task-runtime-v2';
import type {AgentTaskRuntime} from '@mioon/business/agent/task-runtime-v2';
import type {AgentTaskTools} from '@mioon/business/agent/task-tools-v2';
import {createChatSse} from './chat-sse.ts';
import type {ChatSseStream} from './chat-sse.ts';
const prefix='/api/agent/tasks/v2';
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const json=(res:ServerResponse,status:number,data:unknown):void=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({ok:status<400,...(status<400?{data}:{error:data})}));};
async function body(req:IncomingMessage,maxBytes=128*1024):Promise<unknown>{
  if(!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type']??''))throw agentTaskFailure('AGENT_TASK_INVALID');
  let size=0;const chunks:Buffer[]=[];for await(const value of req){const part=Buffer.isBuffer(value)?value:Buffer.from(value as Uint8Array);size+=part.byteLength;if(size>maxBytes)throw agentTaskFailure('AGENT_TASK_INVALID');chunks.push(part);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw agentTaskFailure('AGENT_TASK_INVALID');}
}
function query(url:URL,allowed:readonly string[]):void{const keys=[...url.searchParams.keys()];if(new Set(keys).size!==keys.length||keys.some(key=>!allowed.includes(key)))throw agentTaskFailure('AGENT_TASK_INVALID');}
/** Host/origin/authentication are enforced by the enclosing server before this
 * route family, including streams, policy changes and editor claims. */
export function createAgentTaskHttp({runtime,tools,assertMutationAllowed}:{runtime:AgentTaskRuntime;tools?:AgentTaskTools;assertMutationAllowed?:()=>void}){
  const clients=new Set<ChatSseStream>();
  const mutationBody=async(req:IncomingMessage,maxBytes?:number):Promise<unknown>=>{const input=await body(req,maxBytes);assertMutationAllowed?.();return input;};
  return {
    async handle(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>{
      if(url.pathname!==prefix&&!url.pathname.startsWith(prefix+'/'))return false;
      try{
        if(url.pathname===prefix+'/policy'){
          query(url,[]);if(req.method==='GET')json(res,200,{policy:runtime.policy(),readOnly:runtime.readOnly});
          else if(req.method==='PUT')json(res,200,{policy:runtime.updatePolicy(await mutationBody(req)),readOnly:runtime.readOnly});
          else {res.setHeader('Allow','GET, PUT');json(res,405,{code:'METHOD_NOT_ALLOWED',message:'请使用 GET 或 PUT。'});}return true;
        }
        if(url.pathname.startsWith(prefix+'/policy/requests/')&&req.method==='GET'){
          query(url,[]);json(res,200,{...runtime.lookupPolicy(decodeURIComponent(url.pathname.slice((prefix+'/policy/requests/').length))),readOnly:runtime.readOnly});return true;
        }
        if(url.pathname===prefix+'/diagnostics/latest'){
          query(url,[]);if(req.method==='GET')json(res,200,runtime.latestConnectionTest());
          else {res.setHeader('Allow','GET');json(res,405,{code:'METHOD_NOT_ALLOWED',message:'请使用 GET。'});}return true;
        }
        if(url.pathname===prefix+'/editing'){
          if(runtime.readOnly)throw agentTaskFailure('AGENT_TASK_READ_ONLY');
          if(req.method==='GET'){
            query(url,['projectId','ownerId','requestId']);const projectId=url.searchParams.get('projectId'),ownerId=url.searchParams.get('ownerId')??undefined;
            if(!projectId||!/^[-a-f0-9]{36}$/u.test(projectId))throw agentTaskFailure('AGENT_TASK_INVALID');
            const requestId=url.searchParams.get('requestId');json(res,200,{claims:runtime.journal.claims(projectId,ownerId),targets:runtime.journal.revisionSnapshot(projectId),timelineRevision:runtime.timelineRevision(projectId),...(requestId?{receipt:runtime.journal.lookupEdit(requestId)}:{})});
          }else if(req.method==='POST'){
            query(url,[]);const parsed=agentTaskEditingSchema.safeParse(await mutationBody(req));if(!parsed.success)throw agentTaskFailure('AGENT_TASK_INVALID');
            json(res,200,runtime.journal.edit(parsed.data));
          }else {res.setHeader('Allow','GET, POST');json(res,405,{code:'METHOD_NOT_ALLOWED',message:'请使用 GET 或 POST。'});}return true;
        }
        const tail=url.pathname.slice(prefix.length+1).split('/').map(value=>decodeURIComponent(value)),projectId=tail[0];
        if(!/^[-a-f0-9]{36}$/u.test(projectId)||tail.length>4)throw agentTaskFailure('AGENT_TASK_NOT_FOUND');
        if(tail.length===1){query(url,[]);if(req.method==='GET')json(res,200,await runtime.snapshot(projectId));else if(req.method==='POST')json(res,200,await runtime.send(projectId,await mutationBody(req)));else {res.setHeader('Allow','GET, POST');json(res,405,{code:'METHOD_NOT_ALLOWED',message:'请使用 GET 或 POST。'});}return true;}
        if(tail[1]==='requests'&&tail.length===3&&req.method==='GET'){query(url,[]);json(res,200,runtime.lookup(projectId,tail[2]));return true;}
        if(tail[1]==='history'&&tail.length===2&&req.method==='GET'){query(url,['cursor']);json(res,200,runtime.history(projectId,url.searchParams.get('cursor')??undefined));return true;}
        if(tail[1]==='conversations'&&tail.length===3&&req.method==='GET'){query(url,['cursor']);json(res,200,runtime.conversation(projectId,tail[2]!,url.searchParams.get('cursor')??undefined));return true;}
        if(tail[1]==='uploads'&&tail.length===2&&req.method==='POST'){
          if(runtime.readOnly||!tools)throw agentTaskFailure('AGENT_TASK_READ_ONLY');
          query(url,[]);const input=await mutationBody(req,41*1024*1024);
          if(!object(input)||Object.keys(input).some(key=>!['requestId','name','mimeType','dataBase64'].includes(key))||['requestId','name','mimeType','dataBase64'].some(key=>typeof input[key]!=='string'))throw agentTaskFailure('AGENT_TASK_INVALID');
          json(res,200,await tools.stageImport({projectId,requestId:input.requestId as string,name:input.name as string,mimeType:input.mimeType as string,dataBase64:input.dataBase64 as string}));return true;
        }
        if(tail[1]==='uploads'&&tail[2]==='requests'&&tail.length===4&&req.method==='GET'){
          query(url,[]);if(runtime.readOnly)throw agentTaskFailure('AGENT_TASK_READ_ONLY');
          const row=runtime.lookupImport(projectId,tail[3]);json(res,200,{found:!!row,...(row?{upload:row}:{})});return true;
        }
        const runId=tail[1];if(!/^[-a-f0-9]{36}$/u.test(runId))throw agentTaskFailure('AGENT_TASK_NOT_FOUND');
        if(tail.length===2&&req.method==='GET'){query(url,[]);json(res,200,runtime.get(projectId,runId));return true;}
        if(tail[2]==='checks'&&tail.length===3){
          query(url,['preflight']);const requested=url.searchParams.get('preflight');if(requested!==null&&requested!=='1')throw agentTaskFailure('AGENT_TASK_INVALID');
          if(req.method==='GET'){
            // This advisory read owns no background work. Losing its observer
            // cancels only the local preflight, as for the existing read RPC.
            const observer=new AbortController(),aborted=()=>observer.abort(),disconnected=()=>{if(!res.writableFinished)observer.abort();};
            req.once('aborted',aborted);res.once('close',disconnected);
            try{
              if(req.aborted||res.destroyed)observer.abort();
              const value=await runtime.checks(projectId,runId,{signal:observer.signal,preflight:requested==='1'});
              if(!observer.signal.aborted&&!res.destroyed&&!res.writableEnded)json(res,200,value);
            }catch(error){if(!observer.signal.aborted&&!res.destroyed&&!res.writableEnded)throw error;}
            finally{req.removeListener('aborted',aborted);res.removeListener('close',disconnected);}
          }
          else {res.setHeader('Allow','GET');json(res,405,{code:'METHOD_NOT_ALLOWED',message:'请使用 GET。'});}return true;
        }
        if(tail[2]==='actions'&&tail.length===3&&req.method==='POST'){query(url,[]);json(res,200,await runtime.action(projectId,runId,await mutationBody(req)));return true;}
        if(tail[2]==='actions'&&tail.length===4&&req.method==='GET'){query(url,[]);json(res,200,runtime.lookupAction(projectId,runId,tail[3]));return true;}
        if(tail[2]==='events'&&tail.length===3&&req.method==='GET'){
          query(url,['after']);const text=url.searchParams.get('after')??'0';if(!/^(0|[1-9][0-9]*)$/u.test(text)||!Number.isSafeInteger(Number(text)))throw agentTaskFailure('AGENT_TASK_INVALID');
          if(clients.size>=32)throw agentTaskFailure('AGENT_TASK_BUSY');let after=Number(text),initial=true;
          runtime.get(projectId,runId);let timer:ReturnType<typeof setInterval>|undefined;
          const stream=createChatSse({res,onSettled:()=>{if(timer)clearInterval(timer);clients.delete(stream);}});clients.add(stream);
          const emit=()=>{try{const next=runtime.events(projectId,runId,after);if(initial||next.sequence>after){initial=false;after=next.sequence;stream.event({id:after,type:'changed',...{runId,sequence:after,data:{revision:next.snapshot.run.revision},createdAt:new Date().toISOString()}});}}catch{stream.close();}};
          stream.attach(()=>{if(timer)clearInterval(timer);});timer=setInterval(emit,200);timer.unref();emit();stream.start();return true;
        }
        throw agentTaskFailure('AGENT_TASK_NOT_FOUND');
      }catch(error){if(res.headersSent){res.destroy();return true;}const safe=agentTaskFailure(object(error)&&typeof error.code==='string'?error.code:'AGENT_TASK_FAILED');json(res,safe.status,{code:safe.code,message:safe.message,details:{},retryable:false});}
      return true;
    },
    close(){for(const stream of [...clients])stream.close();},
  };
}

/** Explicit restored-format fixture, never a production server or route.
 * Only the existing Agent handler runs on the fixture's own legacy connection. */
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {openLegacyWorkspaceStore,getWorkspaceRestoreContext} from '../../packages/business/src/db.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {createAgentSettings} from '../../packages/business/src/agent/settings.ts';
import {createAgentTaskRuntime} from '../../packages/business/src/agent/task-runtime-v2.ts';
import {createAgentTaskHttp} from '../../apps/server/src/agent-task-http-v2.ts';
import {projectHandlerTarget} from '../../apps/server/src/project-host/request.ts';
import {parseProjectApiPath} from '../../packages/contracts/src/project-file.ts';
import type {InspectProject} from '../../apps/server/src/project-host/host.ts';
import type {TaskGateway} from '../../packages/business/src/agent/task-gateway-v2.ts';

export async function startLegacyAgentTaskHttp({dataDir,taskGatewayV2}: {dataDir:string;taskGatewayV2?:TaskGateway}) {
  const store=openLegacyWorkspaceStore(dataDir), restored=getWorkspaceRestoreContext(store);
  if(!restored){store.close();throw new Error('An actual restored legacy fixture is required');}
  const services=createServices(store,new Map()),settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{throw Error('Read-only settings');}}});
  const runtime=createAgentTaskRuntime({store,agentSettings:settings,readOnly:true,
    authorizations:{assertAuthorized(){throw Error('Restored fixtures cannot grant authority');},snapshot(){return {revision:0,scopes:[]};}},
    selfPort:()=>0,...(taskGatewayV2?{gateway:taskGatewayV2}:{}),checksPreflight:(input,{signal}={})=>services.call('timeline.export.preflight',input,{signal,expectedWorkspaceOrigin:restored.workspaceOrigin})});
  const handler=createAgentTaskHttp({runtime}),token=randomUUID();
  const server=createServer(async(req,res)=>{
    if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401);res.end();return;}
    const url=new URL(req.url??'/','http://127.0.0.1'),route=parseProjectApiPath(url.pathname),target=route?projectHandlerTarget(route):null;
    if(target)url.pathname=target.pathname;
    try{if(!await handler.handle(req,res,url,route?{projectId:route.projectId}:undefined)){res.writeHead(404);res.end();}}
    catch(error){const failure=error as {status?:number;code?:string};if(!res.headersSent&&!res.destroyed){res.writeHead(failure.status??500,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:{code:failure.code??'INTERNAL_ERROR'}}));}}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw Error('No fixture listener');
  const inspectProject:InspectProject=(projectId,read)=>{if(!store.get('projects',projectId))throw Error('Unknown fixture project');return read(store.db);};
  let closing:Promise<void>|undefined;
  return {url:`http://127.0.0.1:${address.port}`,token,inspectProject,close:()=>closing??=(async()=>{runtime.close();handler.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await runtime.drain();await services.drain();await settings.close();store.close();})()};
}

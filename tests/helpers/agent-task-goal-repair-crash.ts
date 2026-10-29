// A synthetic gateway and local SQLite only. Kill after the durable boundary,
// bypassing graceful runtime cleanup just as a process crash would.
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {GOAL_PROTOCOLS,openGoalRepairFixture,setCountGoal} from './agent-task-goal-repair-fixture.ts';
const root=process.env.FIXTURE_ROOT!,protocol=GOAL_PROTOCOLS.find(value=>value===process.env.FIXTURE_PROTOCOL)!;
const boundary=process.env.FIXTURE_BOUNDARY!,f=await openGoalRepairFixture(root,protocol);
f.plan(index=>index===1?[setCountGoal(2)]:[]);
const tx=f.store.tx;f.store.tx=fn=>{const value=tx(fn);
 const marked=f.store.db.prepare("SELECT 1 FROM agent_task_steps_v2 WHERE json_type(data,'$.data.goalRepair')='object'").get();
 const intent=f.store.db.prepare("SELECT data FROM agent_task_steps_v2 WHERE status='intent' AND json_type(data,'$.data.goalRepairSourceModelStepId')='text'").get();
 if(marked&&(boundary==='marker'||intent))process.kill(process.pid,'SIGKILL');
 return value;
};
const requestId=randomUUID();writeFileSync(join(root,'fixture.json'),JSON.stringify({projectId:f.projectId,requestId}));
await f.runtime.send(f.projectId,{requestId,text:'Make the requested shots',expectedSettingsRevision:(await f.settings.get()).revision});
setTimeout(()=>{throw Error('Goal repair crash boundary not reached');},15000);

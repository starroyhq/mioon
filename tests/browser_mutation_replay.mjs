/** Supported-CUA UI acceptance; imported only after the fresh app is running. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {mutationQaClient} from './mutation-qa-client.mjs';
const operations=new Set(['shot.create','shot.update','shot.reorder','node.create','node.update','version.select']);
const records=(audit,table)=>audit.data[table].map(row=>JSON.parse(row.data));
const business=audit=>Object.fromEntries(Object.entries(audit.data).filter(([name])=>name!=='workspace_preferences'));
export async function mutationBrowserHarness(tab) {
 const q=await mutationQaClient(),out=path.join(q.root,'browser');await mkdir(out,{recursive:true});
 const report={startedAt:new Date().toISOString(),baseline:'dbf3b93',synthetic:true,liveProviderCalls:0,checks:[],screenshots:[]};
 const save=()=>writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
 const log=async(name,detail={})=>{report.checks.push({name,passed:true,...detail});await save();};
 const capture=async name=>{await writeFile(path.join(out,name),await tab.getScreenshot({emit:false}));report.screenshots.push(name);await save();};
 const mutations=async()=>(await q.requests()).filter(entry=>operations.has(entry.operation));
 const closeJobs=async()=>{const button=tab.playwright.getByRole('button',{name:'关闭生成任务',exact:true});if(await button.isVisible())await button.click();};
 const showJobs=async()=>{if(!await tab.playwright.getByTestId('pending-submission').isVisible())await tab.playwright.getByTestId('jobs-button').click();};
 const replay=async()=>{await showJobs();await tab.playwright.getByTestId('resume-pending').click();await tab.playwright.getByTestId('pending-submission').waitFor({state:'hidden',timeoutMs:15000});};
 const inspectShot=async(id)=>{await closeJobs();if(!await tab.playwright.getByTestId('storyboard').isVisible())await tab.playwright.getByRole('button',{name:'展开分镜',exact:true}).click();await tab.playwright.getByTestId(`storyboard-shot-${id}`).getByRole('button',{name:/选择分镜/}).click();await tab.playwright.getByTestId('shot-inspector').waitFor({state:'visible',timeoutMs:10000});};
 return {...q,tab,report,save,log,capture,mutations,closeJobs,showJobs,replay,inspectShot,initial:await q.audit()};
}
export async function runMutationCreateRecovery(h) {
 const before=await h.audit(),calls=(await h.mutations()).length;
 await h.fault('shot.create');await h.tab.playwright.getByTestId('add-shot').click();const lost=await h.waitFault();assert.equal(lost.status,200);assert.equal(lost.result.ok,true);
 await h.tab.playwright.getByTestId('pending-submission').waitFor({state:'visible',timeoutMs:10000});
 assert.equal((await h.mutations()).length,calls+1);const committed=await h.audit();assert.equal(committed.data.shots.length,before.data.shots.length+1);
 assert.match(await h.tab.playwright.getByTestId('mutation-recovery-storage').innerText(),/当前浏览器会话/);
 await h.capture('01-created-shot-lost-ack-retains-exact-request.jpg');
 await h.closeJobs();await h.tab.playwright.getByTestId('add-shot').click();await h.tab.playwright.getByTestId('pending-submission').waitFor({state:'visible',timeoutMs:10000});assert.equal((await h.mutations()).length,calls+1);
 await h.restart();await h.tab.reload();await h.tab.playwright.getByTestId('jobs-button').waitFor({state:'visible',timeoutMs:15000});assert.equal((await h.mutations()).length,calls+1);
 await h.showJobs();await h.capture('02-backend-restart-retains-session-receipt-no-auto-post.jpg');await h.replay();
 const requests=await h.mutations();assert.equal(requests.length,calls+2);assert.deepEqual(requests[calls].input,requests[calls+1].input);assert.deepEqual(business(await h.audit()),business(committed));
 h.createdShot=lost.result.data;await h.closeJobs();await h.inspectShot(h.createdShot.id);await h.capture('03-explicit-replay-one-shot-original-id.jpg');
 await h.log('Dropped committed shot.create acknowledgement retains one exact session request; another new create is blocked; backend restart and renderer reload never POST; explicit replay uses identical input with zero business writes',{shotId:h.createdShot.id,requestId:lost.input.requestId});
}
export async function runMutationDraftRecovery(h) {
 await h.inspectShot(h.createdShot.id);await h.tab.playwright.getByTestId('shot-prompt').fill('Synthetic save admitted before lost response');const calls=(await h.mutations()).length;
 await h.fault('shot.update','malformed');await h.tab.playwright.getByTestId('save-shot').click();const lost=await h.waitFault();assert.equal(lost.status,200);await h.tab.playwright.getByTestId('pending-submission').waitFor({state:'visible',timeoutMs:10000});const committed=await h.audit();
 await h.closeJobs();await h.tab.playwright.getByTestId('shot-prompt').fill('New unsent draft must survive exact old replay');
 await h.showJobs();await h.capture('04-malformed-success-keeps-recovery-and-new-draft.jpg');await h.replay();await h.closeJobs();
 assert.equal(await h.tab.playwright.getByTestId('shot-prompt').evaluate(element=>element.value),'New unsent draft must survive exact old replay');
 const requests=await h.mutations();assert.equal(requests.length,calls+2);assert.deepEqual(requests[calls].input,requests[calls+1].input);assert.deepEqual(business(await h.audit()),business(committed));
 await h.capture('05-replay-does-not-acknowledge-or-discard-new-inspector-draft.jpg');
 await h.tab.playwright.getByRole('button',{name:'载入最新内容',exact:true}).click();
 assert.equal(await h.tab.playwright.getByTestId('shot-prompt').evaluate(element=>element.value),'Synthetic save admitted before lost response');
 await h.log('Malformed success is ambiguous; exact old save replay advances no revisions and cannot acknowledge or overwrite the current unsent Inspector draft');
}
export async function runMutationOtherOperations(h) {
 await h.closeJobs();let count=(await h.mutations()).length;
 await h.tab.playwright.getByTestId('add-text-node').click();await h.tab.playwright.getByTestId('node-inspector').waitFor({state:'visible',timeoutMs:10000});await h.waitFor(async()=>(await h.mutations()).length===count+1,'one keyed node create');
 await h.tab.playwright.getByLabel('文字内容',{exact:true}).fill('Synthetic node edit with a retained replay ID');await h.fault('node.update');await h.tab.playwright.getByRole('button',{name:'保存节点',exact:true}).click();await h.waitFault();await h.tab.playwright.getByTestId('pending-submission').waitFor({state:'visible',timeoutMs:10000});const committed=await h.audit();await h.replay();assert.deepEqual(business(await h.audit()),business(committed));await h.closeJobs();
 const latestButton=h.tab.playwright.getByRole('button',{name:'载入最新内容',exact:true});if(await latestButton.isVisible())await latestButton.click();
 await h.inspectShot(h.fixture.shot.id);await h.tab.playwright.getByRole('tab',{name:/版本/}).click();
 await h.tab.playwright.getByTestId(`version-card-${h.fixture.versionId}`).getByRole('button',{name:'选用此版本',exact:true}).click();
 await h.waitFor(async()=>records(await h.audit(),'shots').find(shot=>shot.id===h.fixture.shot.id).selectedVersionId===h.fixture.versionId,'version selected once');
 await h.tab.playwright.getByRole('button',{name:`将 ${h.fixture.shot.title} 后移`,exact:true}).click();
 await h.waitFor(async()=>records(await h.audit(),'shots').find(shot=>shot.id===h.fixture.shot.id).orderIndex===1,'shot order moved once');
 const requests=(await h.mutations()).slice(count);assert.deepEqual(requests.map(row=>row.operation),['node.create','node.update','node.update','version.select','shot.reorder']);assert.ok(requests.every(row=>typeof row.input.requestId==='string'));assert.deepEqual(requests[1].input,requests[2].input);
 await h.capture('06-version-selection-and-reorder-use-shared-replay-keys.jpg');await h.log('Existing native-shaped UI uses stable keys for node create/update, version selection and shot reorder; lost node update replay adds no write, and no generation is submitted');
}
export async function runMutationPartialStructure(h) {
 await h.closeJobs();await h.tab.playwright.getByTestId('project-switcher').click();await h.tab.playwright.getByRole('menuitem',{name:h.fixture.secondProject.name,exact:false}).click();await h.tab.playwright.getByTestId('create-three-shots').waitFor({state:'visible',timeoutMs:10000});const count=(await h.mutations()).length;
 await h.fault('shot.create');await h.tab.playwright.getByTestId('create-three-shots').click();await h.waitFault();await h.tab.playwright.getByTestId('pending-submission').waitFor({state:'visible',timeoutMs:10000});assert.equal((await h.mutations()).length,count+1);
 const committed=await h.audit();assert.equal(records(committed,'shots').filter(shot=>shot.projectId===h.fixture.secondProject.id).length,1);await h.capture('07-partial-three-shot-shortcut-stops-at-unknown-result.jpg');await h.replay();assert.deepEqual(business(await h.audit()),business(committed));await h.closeJobs();assert.equal((await h.mutations()).length,count+2);
 await h.log('Three-shot shortcut stops after the first uncertain step; explicit replay confirms only that original shot, never reconstructs or automatically sends remaining steps');
}
export async function finishMutationBrowser(h) {
 const final=await h.audit(),events=await h.requests();
 for(const name of ['assets','jobs','versions','exports','timelines','timeline_history','timeline_history_cursors','timeline_requests','reference_requests','idempotency','job_events'])assert.deepEqual(final.data[name],h.initial.data[name],`${name} must not change`);
 assert.ok(!events.some(event=>event.operation?.startsWith('generation.')||(event.method!=='GET'&&event.path.startsWith('/api/agent/'))));
 h.report.finishedAt=new Date().toISOString();h.report.mutationPosts=(await h.mutations()).length;h.report.receipts=final.data.mutation_requests.length;h.report.finalAuditHash=final.hash;h.report.scope='existing six-operation shared replay only; built-in Agent remains read-only';await h.log('Unrelated media/jobs/versions/exports/timeline/reference/generation records remain unchanged; no model or generation requests');await h.save();return h.report;
}

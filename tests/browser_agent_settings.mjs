/** Real own-cloud browser acceptance. All UI actions use the supported CUA tab;
 * independent API checks target only the disposable local settings fixture. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {agentSettingsQaClient} from './agent-settings-qa-client.mjs';
export async function agentSettingsBrowserHarness(tab){
 const q=await agentSettingsQaClient(),outDir=path.join(q.root,'browser');await mkdir(outDir,{recursive:true});
 const report={startedAt:new Date().toISOString(),baseline:'ed23ef7',scope:'settings_only',providerCalls:0,checks:[],screenshots:[],browser:'Own-cloud Chromium via supported CUA; unchanged production security'};
 const saveReport=()=>writeFile(path.join(outDir,'report.json'),JSON.stringify(report,null,2));
 const log=async(name,details={})=>{report.checks.push({name,passed:true,...details});await saveReport();};
 const capture=async name=>{assert.ok(name.endsWith('.jpg'));const bytes=await tab.getScreenshot({emit:false});assert.equal(bytes[0],255);assert.equal(bytes[1],216);await writeFile(path.join(outDir,name),bytes);report.screenshots.push(name);await saveReport();};
 const tid=id=>tab.playwright.getByTestId('agent-settings-'+id),observe=()=>tab.getAXState({emit:false});
 const open=async()=>{await tid('open').click();await tid('base-url').waitFor({state:'visible',timeoutMs:15000});await observe();};
 const value=id=>tid(id).evaluate(element=>element.value);
 const phase=()=>tid('dialog').getAttribute('data-phase');
 const choose=async(id,label)=>{await q.waitFor(async()=>await tid(id).getAttribute('aria-expanded')==='false','collapsed '+id+' control');await tid(id).click();const option=tab.playwright.getByRole('option',{name:label,exact:true});await option.waitFor({state:'visible',timeoutMs:10000});await option.click();await q.waitFor(async()=>(await tid(id).evaluate(element=>element.querySelector('[data-slot="select-value"]')?.textContent)).trim()===label&&await tid(id).getAttribute('aria-expanded')==='false','selected '+id+': '+label);await observe();};
 const choosePreset=async id=>{const state=await q.snapshot(),preset=state.presets.find(item=>item.id===id);assert.ok(preset,'Known preset '+id);await choose('preset',preset.label);return preset;};
 const saved=async()=>{await q.waitFor(async()=>await phase()==='saved','settings save acknowledgement');return q.snapshot();};
 const puts=async()=>{const records=await q.writes();return records.filter(record=>record.method==='PUT');};
 const initial=await q.audit();
 return{...q,tab,outDir,report,saveReport,log,capture,tid,observe,open,value,phase,choose,choosePreset,saved,puts,initial};
}

export async function runAgentSettingsPresets(h){
 await h.open();const initial=await h.snapshot(),before=await h.puts();
 assert.equal(initial.scope,'settings_only');assert.equal(initial.verification,'not_tested');
 assert.equal(initial.storage.persistentAvailable,false);assert.equal(initial.secret.configured,false);
 assert.equal(initial.presets.length,9);assert.equal(await h.tid('key').getAttribute('type'),'password');assert.equal(await h.value('key'),'');
 await h.capture('01-settings-openai-unverified.jpg');
 for(const preset of initial.presets){
  await h.choose('preset',preset.label);
  const first=preset.platforms[0];assert.equal(await h.value('base-url'),first.baseUrl);assert.equal(await h.value('model'),first.model);
  for(const platform of preset.platforms.slice(1)){await h.choose('platform',platform.label);assert.equal(await h.value('base-url'),platform.baseUrl);assert.equal(await h.value('model'),platform.model);}
 }
 assert.equal((await h.puts()).length,before.length,'Choosing presets must not save or call a provider');
 await h.choosePreset('qwen');await h.capture('02-regional-preset-editable.jpg');
 await h.choosePreset('openai');
 await h.log('All nine documentation-backed presets and every available platform populate editable endpoint/model fields without saving; web mode offers only session key storage',{presets:initial.presets.map(item=>({id:item.id,platforms:item.platforms.map(platform=>platform.id)}))});
 return h.report;
}

export async function runAgentSettingsSave(h){
 const before=await h.snapshot();
 await h.tid('key').fill('mioon-qa-dummy-agent-key-first');await h.tid('save').click();
 assert.equal(await h.value('key'),'','Transient key must clear as the save starts');
 const first=await h.saved();assert.equal(first.revision,before.revision+1);assert.equal(first.secret.configured,true);assert.equal(first.secret.storage,'session');
 assert.ok(!JSON.stringify(first).includes('mioon-qa-dummy-agent-key-'));assert.equal((await h.audit()).plaintextDummyKeyPresent,false);
 await h.capture('03-session-key-saved-unverified.jpg');
 await h.tid('model').fill('qa-edited-model');await h.tid('save').click();const updated=await h.saved();assert.equal(updated.secret.configured,true);assert.equal(updated.configuration.model,'qa-edited-model');assert.equal(await h.value('key'),'');
 await h.log('Write-only dummy key clears immediately, session configuration saves once, nonsecret model edits preserve same-binding key, safe API/disk contain no plaintext dummy key');
 await h.tid('base-url').fill('https://127.0.0.1/v1');await h.tid('save').click();await h.waitFor(async()=>await h.phase()==='error','private endpoint validation');assert.equal((await h.snapshot()).revision,updated.revision);
 await h.capture('04-private-endpoint-rejected.jpg');
 await h.tid('base-url').fill('https://example.com/compatible/v1');await h.tid('save').click();const moved=await h.saved();assert.equal(moved.secret.configured,false);assert.equal(moved.secret.storage,'none');
 await h.log('Backend rejects remote private-IP endpoint without changing settings; a new endpoint clears the old origin-bound key');
 await h.tid('key').fill('mioon-qa-dummy-agent-key-replacement');await h.tid('save').click();assert.equal((await h.saved()).secret.configured,true);
 await h.tid('remove-key').click();await h.tid('save').click();const removed=await h.saved();assert.equal(removed.secret.configured,false);assert.equal(await h.value('key'),'');
 await h.log('Key replacement and explicit saved removal work without ever refilling the password field');
 return h.report;
}

export async function runAgentSettingsConflict(h){
 const opened=await h.snapshot();await h.tid('model').fill('qa-local-unsaved-draft');
 const external=await h.put({expectedRevision:opened.revision,configuration:{...opened.configuration,model:'qa-other-window-model'},secret:{action:'keep'}});assert.equal(external.status,200);
 const before=(await h.puts()).length;await h.tid('save').click();await h.waitFor(async()=>await h.phase()==='review','conflict recovery');
 assert.equal(await h.value('model'),'qa-local-unsaved-draft');assert.equal((await h.snapshot()).configuration.model,'qa-other-window-model');assert.equal((await h.puts()).length,before+1,'No automatic write retry');assert.equal(await h.value('key'),'');
 await h.capture('05-cas-conflict-preserved-draft.jpg');await h.tid('use-latest').click();await h.observe();assert.equal(await h.value('model'),'qa-other-window-model');
 await h.log('A real second-window CAS conflict preserves the unsaved nonsecret draft, re-reads current state and performs no blind write retry; Use latest is explicit');return h.report;
}

export async function runAgentSettingsLostResponse(h){
 const before=await h.snapshot(),count=(await h.puts()).length;await h.fault({kind:'drop'});
 await h.tid('model').fill('qa-accepted-lost-response');await h.tid('key').fill('mioon-qa-dummy-agent-key-lost');await h.tid('save').click();assert.equal(await h.value('key'),'');
 const accepted=await h.waitFault();assert.equal(accepted.status,200);await h.waitFor(async()=>await h.phase()==='review','uncertain save reread');
 const after=await h.snapshot();assert.equal(after.revision,before.revision+1);assert.equal(after.configuration.model,'qa-accepted-lost-response');assert.equal(after.secret.configured,true);assert.equal((await h.puts()).length,count+1);assert.equal(await h.value('key'),'');
 await h.capture('06-lost-response-reread-no-retry.jpg');await h.tid('use-latest').click();await h.observe();
 await h.log('Dropped real accepted PUT response is shown as uncertain, re-read safely, and never resubmitted; key input stays empty',{revision:after.revision});return h.report;
}

export async function runAgentSettingsLifecycle(h){
 const original=await h.snapshot();await h.tid('key').fill('mioon-qa-dummy-agent-key-unsaved');await h.tid('close').click();
 await h.tid('dialog').waitFor({state:'hidden',timeoutMs:10000});await h.open();assert.equal(await h.value('key'),'');assert.equal((await h.snapshot()).revision,original.revision);
 await h.log('Dismissing an unsaved password clears the input without changing the stored configuration/key');
 const count=(await h.puts()).length;await h.fault({kind:'hold'});await h.tid('model').fill('qa-held-accepted-save');await h.tid('key').fill('mioon-qa-dummy-agent-key-held');await h.tid('save').click();
 const accepted=await h.waitFault();assert.equal(accepted.status,200);assert.equal(await h.value('key'),'');
 await h.tid('close').click();await h.tid('dialog').waitFor({state:'hidden',timeoutMs:10000});await h.open();assert.equal(await h.value('model'),'qa-held-accepted-save');assert.equal(await h.value('key'),'');
 await h.tid('model').fill('qa-newer-reopened-draft');await h.release();await h.observe();assert.equal(await h.value('model'),'qa-newer-reopened-draft');assert.equal((await h.puts()).length,count+1);
 await h.capture('07-held-save-dismiss-new-draft-preserved.jpg');await h.log('A held accepted save can be dismissed; reopening reads real saved state, and the old completion cannot overwrite a newer dialog draft or resubmit');
 await h.tid('close').click();await h.tab.reload();await h.tab.playwright.getByTestId('workbench').waitFor({state:'visible',timeoutMs:15000});await h.open();
 assert.equal(await h.value('model'),'qa-held-accepted-save');assert.equal(await h.value('key'),'');assert.equal((await h.snapshot()).secret.configured,true);
 await h.capture('08-reload-session-state-no-key-refill.jpg');await h.log('Browser reload preserves acknowledged settings and backend-session key availability, with an empty password field');
 return h.report;
}

export async function finishAgentSettingsBrowser(h){
 const final=await h.audit();assert.equal(final.domainHash,h.initial.domainHash,'Settings must not mutate business data/history');assert.equal(final.plaintextDummyKeyPresent,false);
 await h.log('Settings workflows leave all project/media/job/timeline/history records unchanged and persist no plaintext dummy key',{domainHash:final.domainHash});
 h.report.finishedAt=new Date().toISOString();h.report.finalAudit=final;await h.saveReport();return h.report;
}

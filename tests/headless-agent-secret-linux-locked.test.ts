import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {promisify} from 'node:util';

// This opt-in test owns its entire HOME and DBus session. Locking a real user's
// collection or changing its password is never part of application validation.
test('Linux locked synthetic Secret Service rejects access and preserves the existing ciphertext',{
  skip:process.platform!=='linux'||process.env.MIOON_HEADLESS_VAULT_LINUX_LOCK_TEST!=='1',timeout:30000,
},async t=>{
  const home=await mkdtemp(path.join(tmpdir(),'mioon-headless-linux-qa-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  for(const name of ['run','config','data','cache','agent-settings'])await mkdir(path.join(home,name),{mode:0o700});
  const file=path.join(home,'locked.mjs');
  await writeFile(file,`import assert from 'node:assert/strict';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {createHeadlessAgentSecretCodec} from ${JSON.stringify(new URL('../apps/server/src/headless-agent-secret-codec.ts',import.meta.url).href)};
import {createAgentSettings} from ${JSON.stringify(new URL('../packages/business/src/agent/settings.ts',import.meta.url).href)};
import {createAgentSettingsFile} from ${JSON.stringify(new URL('../packages/business/src/agent/settings-file.ts',import.meta.url).href)};
import {DEFAULT_AGENT_CONFIGURATION} from ${JSON.stringify(new URL('../packages/business/src/agent/presets.ts',import.meta.url).href)};
let settings,codec,reopened;
try{
 const directory=path.join(process.env.HOME,'agent-settings');
 codec=await createHeadlessAgentSecretCodec({directory,channel:'development'});
 assert.equal(codec.storage().persistentAvailable,true);
 settings=await createAgentSettings({persistence:createAgentSettingsFile({directory}),secretCodec:codec.secretCodec,storage:codec.storage});
 await settings.put({expectedRevision:0,configuration:DEFAULT_AGENT_CONFIGURATION,secret:{action:'replace',storage:'persistent',value:'SYNTHETIC_LOCKED_HEADLESS_NO_PROVIDER'}});
 const before=await readFile(path.join(directory,'settings.json'));
 const run=promisify(execFile),args=['--session','--type=method_call','--print-reply','--dest=org.freedesktop.secrets','/org/freedesktop/secrets'];
 const reply=await run('dbus-send',[...args,'org.freedesktop.Secret.Service.ReadAlias','string:default'],{timeout:3000,maxBuffer:8192});
 const collection=/object path "(\\/org\\/freedesktop\\/secrets\\/collection\\/[A-Za-z0-9_]+)"/u.exec(reply.stdout)?.[1];
 assert.ok(collection);
 await run('dbus-send',[...args,'org.freedesktop.Secret.Service.Lock','array:objpath:'+collection],{timeout:3000,maxBuffer:8192});
 assert.equal((await codec.secretCodec.refreshStorage()).persistentAvailable,false);
 reopened=await createHeadlessAgentSecretCodec({directory,channel:'development'});
 assert.equal(reopened.storage().persistentAvailable,false);
 await assert.rejects(settings.put({expectedRevision:1,configuration:DEFAULT_AGENT_CONFIGURATION,secret:{action:'replace',storage:'persistent',value:'SYNTHETIC_REPLACEMENT_MUST_FAIL'}}));
 assert.deepEqual(await readFile(path.join(directory,'settings.json')),before);
 process.stdout.write(JSON.stringify({ok:true,lockedUnavailable:true,ciphertextUnchanged:true}));
}catch{process.stdout.write(JSON.stringify({ok:false}));process.exitCode=1;}
finally{try{await settings?.close();}catch{}codec?.close();reopened?.close();}
`,{mode:0o600});
  const environment={PATH:process.env.PATH,LANG:'C.UTF-8',HOME:home,XDG_RUNTIME_DIR:path.join(home,'run'),XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_CACHE_HOME:path.join(home,'cache'),GNOME_KEYRING_CONTROL:path.join(home,'run','keyring')};
  const script='printf %s SYNTHETIC_MIOON_KEYRING_TEST | gnome-keyring-daemon --components=secrets --control-directory "$GNOME_KEYRING_CONTROL" --unlock >/dev/null 2>&1\nexec "$1" "$2"';
  let output;
  try{output=await promisify(execFile)('dbus-run-session',['--','sh','-c',script,'mioon-locked-test',process.execPath,file],{env:environment,timeout:25000,maxBuffer:16384});}
  catch{throw Error('Dedicated synthetic locked-vault validation did not complete.');}
  assert.deepEqual(JSON.parse(output.stdout),{ok:true,lockedUnavailable:true,ciphertextUnchanged:true});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../apps/desktop/src/main.ts',import.meta.url),'utf8');
const first=source.indexOf('const windowsPackageSmoke =');
const last=source.indexOf('\n',source.indexOf('const smokeOutput:',first));
assert.ok(first>=0&&last>first);
const policy=source.slice(first,last).replace('const smokeOutput: string | false | undefined','const smokeOutput');
function gate(platform:string,channel:string,packaged:boolean,env:Record<string,string>){
 return vm.runInNewContext(policy+'\n({windowsPackageSmoke,smokeOutput});',{app:{isPackaged:packaged},process:{platform,env},identity:{channel}}) as {windowsPackageSmoke:boolean;smokeOutput:string|false|undefined};
}
const environment={MIOON_DESKTOP_WINDOWS_SMOKE:'1',MIOON_DESKTOP_USER_DATA:'C:\\mioon-test\\user-data',MIOON_DESKTOP_SMOKE_OUTPUT:'C:\\mioon-test\\result.json'};
test('only the Windows development package admits the fixed packaged smoke mode',()=>{
 for(const platform of ['win32','darwin','linux'])for(const channel of ['development','production'])for(const packaged of [true,false]){
  const actual=gate(platform,channel,packaged,environment);
  const expected=platform==='win32'&&channel==='development'&&packaged;
  assert.equal(actual.windowsPackageSmoke,expected,`${platform}/${channel}/${packaged}`);
  assert.equal(Boolean(actual.smokeOutput),channel==='development'&&(!packaged||expected));
 }
});
test('packaged smoke needs explicit opt in and a separate profile and report',()=>{
 for(const omitted of Object.keys(environment)){
  const env={...environment};delete env[omitted as keyof typeof env];
  assert.equal(Boolean(gate('win32','development',true,env).smokeOutput),false,omitted);
 }
 assert.equal(Boolean(gate('win32','development',true,{...environment,MIOON_DESKTOP_WINDOWS_SMOKE:'yes'}).smokeOutput),false);
 assert.equal(Boolean(gate('win32','production',true,environment).smokeOutput),false);
});
test('the packaged branch uses fixed built-in checks and leaves the ordinary smoke branch intact',()=>{
 assert.match(source,/if \(windowsPackageSmoke\) \{\s+const \{ runWindowsSmoke \} = await import\('\.\/windows-smoke-checks\.ts'\)/u);
 assert.ok(source.includes("const { runSmoke } = await import('./smoke-checks.ts');"));
});

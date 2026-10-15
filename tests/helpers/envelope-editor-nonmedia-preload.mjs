// Qualification-only fail-fast process boundary. No application runtime import.
import cp from 'node:child_process';
import { readFileSync, realpathSync, appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// Keep synchronous transforms in this guarded thread instead of esbuild's
// internal worker thread, whose execArgv intentionally omits preload hooks.
process.env.ESBUILD_WORKER_THREADS='0';
const root=fileURLToPath(new URL('../../',import.meta.url));
const manifest=JSON.parse(readFileSync(path.join(root,'docs/evidence/volume-envelope-editor-integration/nonmedia-tests.json'),'utf8'));
const tests=new Set(manifest.map(file=>path.join(root,file)));
const esbuilds=new Set([path.join(root,'node_modules/esbuild/bin/esbuild'),path.join(root,'node_modules/esbuild/../@esbuild/linux-x64/bin/esbuild')].flatMap(p=>{try{return [realpathSync(p)];}catch{return [];}}));
// The cached package exposes its platform binary beside its own entry.
const entry=realpathSync(path.join(root,'node_modules/esbuild'));
try{esbuilds.add(realpathSync(path.join(entry,'../@esbuild/linux-x64/bin/esbuild')));}catch{}
const pinned=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).devDependencies.esbuild;
const version=JSON.parse(readFileSync(path.join(entry,'package.json'),'utf8')).version;
if(version!==pinned)throw Error('Nonmedia guard requires pinned esbuild');
const audit=path.join(root,'docs/evidence/volume-envelope-editor-integration/nonmedia-spawn-audit.jsonl');
appendFileSync(audit,JSON.stringify({pid:process.pid,event:'guard-installed'})+'\n');
function allowed(command,args,options){
 let executable;try{executable=realpathSync(command);}catch{return false;}
 if(options?.shell)return false;
 return executable===realpathSync(process.execPath)&&args.some(arg=>tests.has(arg)) ||
  esbuilds.has(executable)&&args.length>=1&&args[0]===`--service=${version}`&&args.slice(1).every(arg=>arg==='--ping');
}
for(const name of ['spawn','spawnSync','execFile','execFileSync']){
 const original=cp[name];cp[name]=function(command,args=[],options,...rest){
  const ok=Array.isArray(args)&&allowed(command,args,options);
  if(audit)appendFileSync(audit,JSON.stringify({pid:process.pid,method:name,allowed:ok,command:String(command),args})+'\n');
  if(!ok)throw Error('Nonmedia qualification forbids this subprocess');
  return original.call(this,command,args,options,...rest);
 };
}
for(const name of ['exec','execSync','fork'])cp[name]=()=>{if(audit)appendFileSync(audit,JSON.stringify({pid:process.pid,method:name,allowed:false})+'\n');throw Error('Nonmedia qualification forbids shell/fork');};
syncBuiltinESMExports();

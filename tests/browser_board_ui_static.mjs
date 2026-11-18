/** Standalone synthetic UI-B1 acceptance. No application or project host starts. */
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

const root=fileURLToPath(new URL('../',import.meta.url));
const fixture=join(root,'tests/fixtures/board-ui-static');
const args=process.argv.slice(2);
const value=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
const scratch=await mkdtemp(join(tmpdir(),'mioon-board-ui-'));
let server;
try {
  await build({entryPoints:[join(fixture,'entry.tsx')],bundle:true,format:'esm',platform:'browser',jsx:'automatic',
    outfile:join(scratch,'fixture.js'),nodePaths:[join(root,'apps/web/node_modules')],
    define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  const files=new Map([
    ['/fixture.js',{body:await readFile(join(scratch,'fixture.js')),type:'text/javascript'}],
    ['/fixture.css',{body:await readFile(join(scratch,'fixture.css')),type:'text/css'}],
    ['/',{body:Buffer.from('<!doctype html><html lang="zh-Hans"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Board fixture</title><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>'),type:'text/html'}],
  ]);
  server=createServer((request,response)=>{
    const pathname=new URL(request.url??'/', 'http://fixture.invalid').pathname;
    if(pathname==='/favicon.ico'){response.writeHead(204);response.end();return;}
    const file=files.get(pathname);
    response.writeHead(file?200:404,{'Content-Type':file?.type??'text/plain','Cache-Control':'no-store'});
    response.end(file?.body??'Not found');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {port}=server.address();
  const url=`http://127.0.0.1:${port}/`;
  if(args.includes('--serve')) {
    process.stdout.write(`${url}\n`);
    await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
  } else {
    const command=[join(fixture,'acceptance.py'),'--url',url];
    for(const name of ['--screens','--report','--browser'])if(value(name))command.push(name,value(name));
    if(args.includes('--skip-performance'))command.push('--skip-performance');
    const allowed=['PATH','HOME','USERPROFILE','SYSTEMROOT','SystemRoot','TEMP','TMP','TMPDIR','LANG','LC_ALL','TZ'];
    const env=Object.fromEntries(allowed.filter(name=>process.env[name]!==undefined).map(name=>[name,process.env[name]]));
    const child=spawn(value('--python')??'python3',command,{cwd:root,env,stdio:['ignore','pipe','pipe']});
    const sanitize=line=>line.split(root).join('<repo>/').split(scratch).join('<scratch>').split(homedir()).join('<home>');
    for(const [stream,destination] of [[child.stdout,process.stdout],[child.stderr,process.stderr]]){
      createInterface({input:stream}).on('line',line=>destination.write(`${sanitize(line)}\n`));
    }
    const exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve(code??1));});
    process.exitCode=exitCode;
  }
} catch(error) {
  const detail=String(error?.message??error).split(root).join('<repo>/').split(scratch).join('<scratch>').split(homedir()).join('<home>');
  process.stderr.write(`Board fixture failed: ${detail}\n`);process.exitCode=1;
} finally {
  if(server)await new Promise(resolve=>server.close(resolve));
  await rm(scratch,{recursive:true,force:true});
}

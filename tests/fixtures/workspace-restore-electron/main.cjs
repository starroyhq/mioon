// QA-only fixed Electron main. No BrowserWindow, renderer, token or provider.
const {app,utilityProcess}=require('electron');
const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'../../..');
const evidence=path.join(root,'evidence/workspace-restore/electron-final');
app.setName('Mioon Restore Gate QA');
app.setPath('userData',path.join(evidence,'user-data'));
let report,child,failed=false;
process.on('SIGTERM',()=>{failed=true;if(child)child.kill();else app.exit(1);});
app.whenReady().then(()=>{
 child=utilityProcess.fork(path.join(root,'tests/workspace-restore-electron-qa.mjs'),['utility'],{env:{},stdio:'pipe',serviceName:'Mioon restore gate QA'});
 child.stdout.on('data',bytes=>process.stdout.write(bytes));child.stderr.on('data',bytes=>process.stderr.write(bytes));
 child.on('message',value=>{report=value;fs.writeFileSync(path.join(evidence,'utility-report.json'),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});child.postMessage('report-saved');});
 const watchdog=setTimeout(()=>{failed=true;child.kill();},60000);
 child.on('exit',code=>{clearTimeout(watchdog);app.exit(!failed&&code===0&&report?.ok?0:1);});
}).catch(error=>{process.stderr.write(String(error)+'\n');app.exit(1);});

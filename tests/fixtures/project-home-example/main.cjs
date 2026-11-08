const {app, BrowserWindow, session, ipcMain} = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs'), path = require('node:path'), directory = __dirname;
for (const name of ['user-data', 'session-data', 'cache', 'logs', 'crash-dumps', 'files', 'bin']) fs.mkdirSync(path.join(directory, name));
app.setPath('userData', path.join(directory, 'user-data'));
app.setPath('sessionData', path.join(directory, 'session-data'));
app.setPath('logs', path.join(directory, 'logs'));
app.setPath('crashDumps', path.join(directory, 'crash-dumps'));
app.commandLine.appendSwitch('disk-cache-dir', path.join(directory, 'cache'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(win, expression) {
  const started = Date.now();
  while (Date.now() - started < 12000) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await pause(25);
  }
  throw Error('Fixture condition timed out: ' + expression);
}
function verify(result) {
  const {scenario, counts} = result;
  if (scenario.startsWith('trash-')) return {visible: result.visibility === 'visible', confirmationShown: result.confirmationShown, deletes: counts.deletes === (scenario === 'trash-confirm' ? 1 : 0), noTemplateWrites: counts.instantiations === 0, sourceState: result.fileState.sourceExists === (scenario === 'trash-cancel'), binState: result.fileState.binExists === (scenario === 'trash-confirm'), fileIntegrity: result.fileState.sha256 === result.fileState.originalSha256};
  const checks = {visible: result.visibility === 'visible', panel: counts.panels === (scenario === 'deny' ? 0 : 1), instantiations: counts.instantiations === (['success', 'exists'].includes(scenario) ? 1 : 0), opens: counts.opens === (scenario === 'success' ? 1 : 0)};
  if (scenario === 'success') Object.assign(checks, {receipt: counts.receipts === 1, sealedAdmission: result.admissions.length === 1 && result.admissions[0].accepted === true, registered: result.registered === 1});
  if (scenario === 'cancel') checks.visibleCancellation = result.notices.some(value => value.visible && value.text.includes(result.messages.cancelled));
  if (scenario === 'deny') checks.visibleRefusal = result.dialogs.some(value => value.visible && value.kind === 'example-blocked' && value.text.trim());
  if (scenario === 'exists') Object.assign(checks, {visibleExists: result.dialogs.some(value => value.visible && value.kind === 'example-blocked' && value.text.includes(result.messages.exists)), noOverwrite: result.directoryUnchanged && counts.receipts === 0});
  return checks;
}
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  const results = [], owned = new Map();
  ipcMain.handle('project-home-fixture:trash', (event, input) => {
    const file = owned.get(event.sender.id);
    if (!file || input.projectFile !== file.source || input.projectId !== '77000000-0000-4000-8000-000000000060' || input.expectedRevision !== 1 || input.confirmTrash !== true) throw Error('Unowned synthetic trash input');
    const identity = fs.lstatSync(file.source, {bigint: true});
    if (!identity.isFile() || identity.nlink !== 1n || String(identity.dev) !== input.fileIdentity.dev || String(identity.ino) !== input.fileIdentity.ino) throw Error('Synthetic file identity changed');
    fs.renameSync(file.source, file.bin);
    return {requestId: input.requestId, projectId: input.projectId, projectFile: input.projectFile, trashed: true, records: 'retained'};
  });
  const cases = ['launcher', 'editor'].flatMap(role => ['cancel', 'success', 'deny', 'exists'].map(scenario => ({role, scenario}))).concat(['trash-cancel', 'trash-confirm'].map(scenario => ({role: 'launcher', scenario})));
  for (const {role, scenario} of cases) {
    const win = new BrowserWindow({show: false, width: 1200, height: 900, webPreferences: {nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, preload: path.join(directory, 'preload.cjs')}});
    win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    try {
      const query = {role, scenario};
      let file;
      if (scenario.startsWith('trash-')) {
        const source = path.join(directory, 'files', scenario + '.mioon'), bin = path.join(directory, 'bin', scenario + '.mioon');
        const bytes = Buffer.from('Synthetic Q05 placeholder only\n'); fs.writeFileSync(source, bytes, {flag: 'wx'});
        const identity = fs.statSync(source, {bigint: true}); file = {source, bin, originalSha256: crypto.createHash('sha256').update(bytes).digest('hex')}; owned.set(win.webContents.id, file);
        Object.assign(query, {projectFile: source, dev: String(identity.dev), ino: String(identity.ino)});
      }
      await win.loadFile(path.join(directory, 'index.html'), {query});
      await wait(win, 'Boolean(window.projectHomeExample?.entry?.desktop?.getState().capabilities?.ready && !window.projectHomeExample.entry.desktop.getState().busy)');
      if (role === 'editor') await win.webContents.executeJavaScript('window.projectHomeExample.entry.show("open")');
      await wait(win, 'Boolean(document.querySelector("[data-testid=project-home-example]") && !document.querySelector("[data-testid=project-home-example]").disabled && window.projectHomeExample.entry.getState().catalogReady)');
      const visibility = await win.webContents.executeJavaScript('document.visibilityState');
      if (visibility !== 'visible') throw Error('The fixture is hidden, not a product failure');
      if (scenario.startsWith('trash-')) {
        await win.webContents.executeJavaScript('document.querySelector("[data-testid=pf-card-menu-77000000-0000-4000-8000-000000000060]").click()');
        await wait(win, 'Boolean(document.querySelector("[data-testid=pf-menu-trash-77000000-0000-4000-8000-000000000060]"))');
        await win.webContents.executeJavaScript('window.projectHomeExample.holdNext(); document.querySelector("[data-testid=pf-menu-trash-77000000-0000-4000-8000-000000000060]").click()');
      } else await win.webContents.executeJavaScript('window.projectHomeExample.holdNext(); document.querySelector("[data-testid=project-home-example]").click()');
      await wait(win, 'window.projectHomeExample.waiting()');
      // A pending cross-task read lets real React commit catalogReady=false.
      await pause(120);
      const pending = await win.webContents.executeJavaScript('({catalogReady: window.projectHomeExample.entry.getState().catalogReady, blocked: !document.querySelector("[data-testid=project-home-example]") || document.querySelector("[data-testid=project-home-example]").disabled})');
      if (pending.catalogReady || !pending.blocked) throw Error('The fixture did not exercise a rendered pending directory');
      await win.webContents.executeJavaScript('window.projectHomeExample.release()');
      await pause(350);
      let confirmationShown = false;
      if (scenario.startsWith('trash-')) {
        await wait(win, 'Boolean(document.querySelector("[data-testid=project-home-native-dialog][data-state=confirm-trash]"))');
        confirmationShown = true;
        await win.webContents.executeJavaScript(scenario === 'trash-confirm' ? 'document.querySelector("[data-testid=project-home-trash-confirm]").click()' : 'document.querySelector("[data-testid=project-home-native-close]").click()');
      }
      await pause(500);
      const result = await win.webContents.executeJavaScript('window.projectHomeExample.collect()');
      if (file) {const actual = fs.readFileSync(fs.existsSync(file.source) ? file.source : file.bin);result.confirmationShown = confirmationShown;result.fileState = {sourceExists: fs.existsSync(file.source), binExists: fs.existsSync(file.bin), originalSha256: file.originalSha256, sha256: crypto.createHash('sha256').update(actual).digest('hex')};}
      result.checks = verify(result); result.passed = Object.values(result.checks).every(Boolean); results.push(result);
      await win.webContents.executeJavaScript('window.projectHomeExample.unmount()');
    } catch (error) {results.push({role, scenario, passed: false, error: String(error)});}
    finally {owned.delete(win.webContents.id);win.destroy();}
  }
  fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify({scope: 'Real React/Electron with synthetic ports; trash renames only private placeholder files, not the application trash service; no user files or model keys', results}, null, 2) + '\n');
  app.exit(results.every(value => value.passed) ? 0 : 1);
}).catch(error => {fs.writeFileSync(path.join(directory, 'error.json'), JSON.stringify({error: String(error)})); app.exit(1);});

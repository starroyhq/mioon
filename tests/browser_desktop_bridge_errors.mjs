/** Standalone real Electron/contextBridge regression, outside the headless suite.
 * Run from the repository root with Node 24 and the installed pinned Electron:
 * TMPDIR=/private/tmp node tests/browser_desktop_bridge_errors.mjs
 * To reproduce pre-fix behavior without editing the working tree:
 * TMPDIR=/private/tmp node tests/browser_desktop_bridge_errors.mjs --baseline <commit>
 * All app profiles, source bundles and placeholder files stay in one new private
 * temp directory. No installed app, user project, secret, network or real model
 * participates. Baseline mode requires the old Error-property-loss behavior.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';

const repo = process.cwd();
const fixture = fileURLToPath(new URL('./fixtures/desktop-bridge-errors/', import.meta.url));
const args = process.argv.slice(2);
const baseline = args.length === 2 && args[0] === '--baseline' && /^[a-f0-9]{7,40}$/u.test(args[1]) ? args[1] : null;
const digest = value => createHash('sha256').update(value).digest('hex');
const scrub = value => {
  const workspaceFree = String(value).split(repo).join('[workspace]');
  return process.env.HOME ? workspaceFree.split(process.env.HOME).join('[home]') : workspaceFree;
};
let output;
try {
  if (args.length && !baseline) throw new Error('FIXTURE_INVALID_ARGUMENTS');
  if (!fs.existsSync(path.join(repo, 'apps/desktop/src/preload.ts'))) throw new Error('FIXTURE_RUN_FROM_REPOSITORY_ROOT');
  const require = createRequire(path.join(repo, 'package.json'));
  const {build} = require('esbuild');
  // Resolve the installed binary without running Electron's automatic installer.
  const electronPackage = path.dirname(require.resolve('electron'));
  const electron = path.join(electronPackage, 'dist', fs.readFileSync(path.join(electronPackage, 'path.txt'), 'utf8').trim());
  if (!fs.existsSync(electron)) throw new Error('FIXTURE_ELECTRON_NOT_INSTALLED');
  const tempBase = process.env.TMPDIR ? fs.realpathSync(os.tmpdir()) : process.platform === 'darwin' ? '/private/tmp' : fs.realpathSync(os.tmpdir());
  output = fs.mkdtempSync(path.join(tempBase, baseline ? 'mioon-bridge-baseline-' : 'mioon-bridge-current-'));
  fs.chmodSync(output, 0o700);
  const sourceCommit = execFileSync('git', ['rev-parse', '--verify', `${baseline ?? 'HEAD'}^{commit}`], {cwd: repo, encoding: 'utf8'}).trim();
  const sources = new Map();
  const snapshot = {
    name: 'record-real-production-sources',
    setup(builder) {
      builder.onLoad({filter: /\.[cm]?[jt]sx?$/}, input => {
        const relative = path.relative(repo, input.path).split(path.sep).join('/');
        if (!/^(?:apps|packages)\//u.test(relative) || relative.includes('/node_modules/')) return;
        // Every production module, including the complete actual preload and
        // its imports, comes from the same fixed Git tree in baseline mode.
        const bytes = baseline ? execFileSync('git', ['show', `${sourceCommit}:${relative}`], {cwd: repo, maxBuffer: 8 * 1024 * 1024}) : fs.readFileSync(input.path);
        sources.set(relative, {path: relative, bytes: bytes.length, sha256: digest(bytes)});
        return {contents: bytes.toString('utf8'), loader: /\.tsx$/u.test(relative) ? 'tsx' : /\.ts$/u.test(relative) ? 'ts' : 'js', resolveDir: path.dirname(input.path)};
      });
    },
  };
  const shared = {absWorkingDir: repo, bundle: true, sourcemap: false, legalComments: 'eof', logLevel: 'silent', plugins: [snapshot]};
  // Match apps/desktop/scripts/build.ts, not a replacement test preload.
  await build({...shared, entryPoints: ['apps/desktop/src/preload.ts'], outfile: path.join(output, 'preload.cjs'), platform: 'node', format: 'cjs', target: 'node24', external: ['electron']});
  await build({...shared, entryPoints: [path.join(fixture, 'main.js')], outfile: path.join(output, 'main.cjs'), platform: 'node', format: 'cjs', target: 'node24', external: ['electron']});
  await build({...shared, entryPoints: [path.join(fixture, 'renderer.js')], outfile: path.join(output, 'renderer.js'), platform: 'browser', format: 'iife', target: 'chrome140', nodePaths: [path.join(repo, 'node_modules'), path.join(repo, 'apps/web/node_modules')], tsconfig: path.join(repo, 'apps/web/tsconfig.json')});
  fs.writeFileSync(path.join(output, 'config.json'), JSON.stringify({baseline: Boolean(baseline)}));
  fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; connect-src \'none\'"><script src="renderer.js"></script>');
  const manifest = {
    source: baseline ? {kind: 'fixed-git-tree', commit: sourceCommit} : {kind: 'working-tree', head: sourceCommit},
    command: `TMPDIR=/private/tmp node tests/browser_desktop_bridge_errors.mjs${baseline ? ' --baseline ' + sourceCommit : ''}`,
    sources: [...sources.values()].sort((a, b) => a.path.localeCompare(b.path)),
    bundles: ['preload.cjs', 'main.cjs', 'renderer.js'].map(name => ({path: name, sha256: digest(fs.readFileSync(path.join(output, name)))})),
  };
  fs.writeFileSync(path.join(output, 'sources.json'), JSON.stringify(manifest, null, 2) + '\n');
  const stdout = fs.openSync(path.join(output, 'stdout.log'), 'w'), stderr = fs.openSync(path.join(output, 'stderr.log'), 'w');
  // File descriptors preserve child log bytes; decode complete files on exit.
  const child = spawn(electron, [path.join(output, 'main.cjs')], {cwd: output, detached: true, stdio: ['ignore', stdout, stderr], env: {PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'en_US.UTF-8', TMPDIR: output}});
  const timeout = setTimeout(() => {try {process.kill(-child.pid, 'SIGKILL');} catch {}}, 90000);
  let code;
  try {code = await new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', resolve);});}
  finally {
    clearTimeout(timeout); fs.closeSync(stdout); fs.closeSync(stderr);
    // Raw child logs live only in this mode-0700 directory while it runs.
    // Scrub workspace/home paths before retaining or reporting any evidence.
    for (const name of ['stdout.log', 'stderr.log']) {
      const file = path.join(output, name); fs.writeFileSync(file, scrub(fs.readFileSync(file, 'utf8')));
    }
  }
  const resultFile = path.join(output, 'results.json');
  const report = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
  const passed = report?.results.filter(value => value.passed).length ?? 0, total = report?.results.length ?? 0;
  // A generic artifact name keeps local workspace and home paths out of output.
  console.log(JSON.stringify({mode: baseline ? 'baseline' : 'current', artifact: path.basename(output), electron: report?.electron ?? null, exitCode: code, passed, total}));
  if (code !== 0 || total !== 16 || passed !== total || !report?.isolation.sandbox || !report?.isolation.contextIsolation || report?.isolation.nodeIntegration !== false) process.exitCode = 1;
} catch (error) {
  const code = /^[A-Z_]+$/u.test(error?.message ?? '') ? error.message : 'FIXTURE_SETUP_FAILED';
  if (output) fs.writeFileSync(path.join(output, 'setup-error.json'), JSON.stringify({code, errors: (error?.errors ?? [{text: String(error?.message ?? code)}]).map(value => ({text: scrub(value.text)}))}, null, 2) + '\n');
  console.error(JSON.stringify({error: code, artifact: output ? path.basename(output) : null}));
  process.exitCode = 1;
}

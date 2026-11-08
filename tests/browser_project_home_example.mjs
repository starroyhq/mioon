/** Standalone real React/Electron regression, separate from the headless suite.
 * Run from the repository root with Node 24 and an installed pinned Electron:
 * TMPDIR=/private/tmp node tests/browser_project_home_example.mjs
 * Only fixture sources are bundled. All profiles and files belong to its new
 * temp directory; synthetic ports never reach a user project or OS Trash.
 * Real server/template/Trash behavior is covered by the corresponding Node tests.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
const repo = process.cwd(), fixture = fileURLToPath(new URL('./fixtures/project-home-example/', import.meta.url));
if (!fs.existsSync(path.join(repo, 'apps/web/src/ProjectEntry.tsx'))) throw Error('Run from the repository root');
const require = createRequire(path.join(repo, 'package.json')), {build} = require('esbuild');
// Resolving does not execute Electron's index.js automatic installer.
const electronPackage = path.dirname(require.resolve('electron'));
const electron = path.join(electronPackage, 'dist', fs.readFileSync(path.join(electronPackage, 'path.txt'), 'utf8').trim());
if (!fs.existsSync(electron)) throw Error('The pinned Electron binary must already be installed');
const output = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mioon-home-example-'));
const bundle = await build({entryPoints: [path.join(fixture, 'renderer.jsx')], bundle: true, platform: 'browser', format: 'iife', write: false, jsx: 'automatic', target: 'chrome140', loader: {'.css': 'empty'}, define: {'process.env.NODE_ENV': '"production"'}, nodePaths: [path.join(repo, 'node_modules'), path.join(repo, 'apps/web/node_modules')], tsconfig: path.join(repo, 'apps/web/tsconfig.json'), plugins: [{name: 'fixed-language-only', setup(builder) {builder.onResolve({filter: /\/i18n\/I18nProvider\.tsx$/}, () => ({path: path.join(repo, 'tests/fixtures/project-file-ui/ssr-i18n.tsx')}));}}]});
fs.writeFileSync(path.join(output, 'renderer.js'), bundle.outputFiles[0].text);
fs.copyFileSync(path.join(fixture, 'main.cjs'), path.join(output, 'main.cjs'));
fs.copyFileSync(path.join(fixture, 'preload.cjs'), path.join(output, 'preload.cjs'));
fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'unsafe-inline\'; img-src data:; connect-src \'none\'"><div id="root"></div><script src="renderer.js"></script>');
const stdout = fs.openSync(path.join(output, 'stdout.log'), 'w'), stderr = fs.openSync(path.join(output, 'stderr.log'), 'w');
const child = spawn(electron, [path.join(output, 'main.cjs')], {cwd: output, detached: true, stdio: ['ignore', stdout, stderr], env: {PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'en_US.UTF-8', TMPDIR: output}});
const timeout = setTimeout(() => {try {process.kill(-child.pid, 'SIGKILL');} catch {}}, 90000);
const code = await new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', resolve);});
clearTimeout(timeout); fs.closeSync(stdout); fs.closeSync(stderr);
const resultFile = path.join(output, 'results.json');
const report = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
console.log(JSON.stringify({exitCode: code, output, passed: report?.results.filter(value => value.passed).length ?? 0, total: report?.results.length ?? 0}));
if (code !== 0 || !report || report.results.length !== 10 || !report.results.every(value => value.passed)) process.exitCode = 1;

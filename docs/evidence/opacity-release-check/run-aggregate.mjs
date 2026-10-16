// Reproduce only the reviewed offline/synthetic release selection.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../..');
const selectionPath = path.join(directory, 'aggregate-selection.json');
const selection = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
for (const file of selection.files) selection.sourceSha256AtSelection[file] = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
selection.status = 'executing';
fs.writeFileSync(selectionPath, JSON.stringify(selection, null, 2) + '\n');
const args = ['--test', '--test-reporter=tap', '--test-concurrency=4', ...selection.files];
const log = path.join(directory, 'aggregate-final.tap');
const output = fs.openSync(log, 'w');
const startedAt = new Date().toISOString();
const child = spawn(process.execPath, args, {cwd: root, stdio: ['ignore', output, output], shell: false});
const result = await new Promise((resolve, reject) => {child.once('error', reject);child.once('close', (code, signal) => resolve({code, signal}));});
fs.closeSync(output);
const content = fs.readFileSync(log, 'utf8');
const counts = Object.fromEntries(['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => [key, Number(content.match(new RegExp('^# ' + key + ' (\\d+)$', 'm'))?.[1] ?? NaN)]));
const summary = {startedAt, completedAt: new Date().toISOString(), executable: process.execPath, version: process.version, platform: process.platform, arch: process.arch,
  variant: 'Installed CUA Node24.21.0 darwin-arm64; not the historical fixed Linux binary or packaged product runtime', command: [process.execPath, ...args], uniqueFiles: selection.files.length, ...result, counts,
  scope: selection.scope, log: 'aggregate-final.tap'};
fs.writeFileSync(path.join(directory, 'aggregate-result.json'), JSON.stringify(summary, null, 2) + '\n');
selection.status = result.code === 0 && result.signal === null ? 'passed' : 'failed';
fs.writeFileSync(selectionPath, JSON.stringify(selection, null, 2) + '\n');
console.log(JSON.stringify({code: result.code, signal: result.signal, uniqueFiles: summary.uniqueFiles, counts}));
process.exitCode = result.code ?? 1;
